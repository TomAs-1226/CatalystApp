import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildXtermTheme,
  codeOf,
  dataOf,
  exitNote,
  makeDebounced,
  makeSessionRouter,
  payloadFor,
  ptyOpenRequest,
  sizeChanged,
  THEME_TOKENS,
} from "./terminal.js";

// --- event payloads ---------------------------------------------------------
//
// These run inside a Tauri event listener. A throw in there does not surface anywhere: it kills
// the listener, and the pane goes quiet for the rest of its life with no error on screen. So every
// one of these has to survive a payload that is not the shape the contract promises.

test("a payload is only accepted when the id is this session's", () => {
  assert.deepEqual(payloadFor("a", { id: "a", data: "x" }), { id: "a", data: "x" });
  assert.equal(payloadFor("a", { id: "b", data: "x" }), null, "another pane's output must not appear here");
});

test("a malformed payload is refused rather than thrown over", () => {
  for (const bad of [null, undefined, "a", 7, [], {}, { data: "x" }, { id: 7 }, { id: null }]) {
    assert.equal(payloadFor("a", bad), null);
  }
});

test("data that is not a string is no output at all", () => {
  assert.equal(dataOf({ id: "a", data: "hello" }), "hello");
  assert.equal(dataOf({ id: "a" }), "");
  assert.equal(dataOf({ id: "a", data: null }), "");
  assert.equal(dataOf({ id: "a", data: 12 }), "");
  assert.equal(dataOf(null), "");
});

test("a missing exit code stays null and never becomes zero", () => {
  // Option<i32> serialises to null when the child left no code. Reading that as 0 is how a killed
  // deploy gets reported as a success.
  assert.equal(codeOf({ id: "a", code: 0 }), 0);
  assert.equal(codeOf({ id: "a", code: 1 }), 1);
  assert.equal(codeOf({ id: "a", code: null }), null);
  assert.equal(codeOf({ id: "a" }), null);
  assert.equal(codeOf(null), null);
});

test("the code is read under either name Rust gives it", () => {
  // The event says `code`; the same number is `exit_code` on PtyInfo. Reading both costs a line and
  // saves a pane that would otherwise report every finished build as having ended without a status.
  assert.equal(codeOf({ id: "a", exit_code: 3 }), 3);
  assert.equal(codeOf({ id: "a", exit_code: 0 }), 0);
  assert.equal(codeOf({ id: "a", code: 0, exit_code: 9 }), 0, "the event's own name wins");
});

test("the exit note tells the truth about how it ended", () => {
  assert.equal(exitNote(0).tone, "ok");
  assert.match(exitNote(0).text, /0/);
  assert.equal(exitNote(1).tone, "bad");
  assert.match(exitNote(1).text, /1/);
  assert.equal(exitNote(null).tone, "warn");
});

test("a session the user stopped is not reported as a failure", () => {
  // Closing a session on Windows makes the child exit 1. Colouring the user's own Stop button red
  // and calling it an error is a lie the colour sells hard.
  const note = exitNote(1, { stopped: true });
  assert.equal(note.tone, "dim");
  assert.match(note.text, /Stopped/);
  assert.notEqual(exitNote(1).tone, "dim", "an exit 1 nobody asked for is still a failure");
});

test("a child killed because its console went away is not a failed build either", () => {
  // -1073741510 is STATUS_CONTROL_C_EXIT: the pty closed under the child. Printed raw it tells
  // nobody anything, and printed in red it accuses the code of something it did not do.
  const note = exitNote(-1073741510);
  assert.equal(note.tone, "dim");
  assert.match(note.text, /Stopped/);
  assert.doesNotMatch(note.text, /1073741510/);
});

// --- the open request -------------------------------------------------------

test("cols and rows are always positive integers", () => {
  // proposeDimensions() on a pane that has not been laid out yields 0, a fraction or NaN, and
  // `u16` on the other side rejects every one of those as a deserialisation error - which arrives
  // as "invalid args", not as "your terminal has no size yet".
  assert.equal(ptyOpenRequest({ kind: "shell", cwd: "/x", cols: 0, rows: 0 }).cols, 1);
  assert.equal(ptyOpenRequest({ kind: "shell", cwd: "/x", cols: NaN, rows: NaN }).rows, 1);
  assert.equal(ptyOpenRequest({ kind: "shell", cwd: "/x", cols: 80.7, rows: 24.2 }).cols, 80);
  assert.equal(ptyOpenRequest({ kind: "shell", cwd: "/x", cols: 80.7, rows: 24.2 }).rows, 24);
  assert.equal(ptyOpenRequest({ kind: "shell", cwd: "/x", cols: 1e9, rows: 1 }).cols, 65535);
  assert.equal(ptyOpenRequest({ kind: "shell", cwd: "/x", cols: -5, rows: -5 }).cols, 1);
});

test("args default to an empty list and are always strings", () => {
  assert.deepEqual(ptyOpenRequest({ kind: "devtools", cwd: "/x", cols: 80, rows: 24 }).args, []);
  assert.deepEqual(ptyOpenRequest({ kind: "devtools", cwd: "/x", args: null, cols: 80, rows: 24 }).args, []);
  assert.deepEqual(
    ptyOpenRequest({ kind: "devtools", cwd: "/x", args: ["gradle", "--", "build"], cols: 80, rows: 24 }).args,
    ["gradle", "--", "build"],
  );
});

test("a size is only pushed when it is usable and actually different", () => {
  assert.equal(sizeChanged(null, { cols: 80, rows: 24 }), true);
  assert.equal(sizeChanged({ cols: 80, rows: 24 }, { cols: 80, rows: 24 }), false);
  assert.equal(sizeChanged({ cols: 80, rows: 24 }, { cols: 81, rows: 24 }), true);
  assert.equal(sizeChanged({ cols: 80, rows: 24 }, null), false, "no measurement is not a resize");
  assert.equal(sizeChanged({ cols: 80, rows: 24 }, { cols: 0, rows: 24 }), false);
});

// --- the router -------------------------------------------------------------

function collect() {
  const data = [];
  const exits = [];
  const router = makeSessionRouter({ onData: (d) => data.push(d), onExit: (c) => exits.push(c) });
  return { router, data, exits };
}

test("output emitted before pty_open returned the id is replayed, in order", () => {
  // The whole reason the listeners go on first. A child writes its first bytes in microseconds and
  // the id comes back over an IPC round trip; an event emitted with nobody listening is gone, and
  // one that arrives before the id is known has nothing to compare against yet.
  const { router, data } = collect();
  router.data({ id: "s1", data: "one " });
  router.data({ id: "s1", data: "two " });
  router.bind("s1");
  router.data({ id: "s1", data: "three" });
  assert.equal(data.join(""), "one two three");
});

test("another session's output is dropped, before and after the id is known", () => {
  const { router, data } = collect();
  router.data({ id: "other", data: "NOPE" });
  router.data({ id: "s1", data: "mine" });
  router.bind("s1");
  router.data({ id: "other", data: "NOPE" });
  assert.equal(data.join(""), "mine");
});

test("an exit that beat the id still ends the session", () => {
  // `devtools` with a bad argument exits before pty_open has resolved. Losing that exit leaves the
  // pane looking like it is still running, with a Stop button for a process that is already gone.
  const { router, exits } = collect();
  router.exit({ id: "s1", code: 2 });
  router.bind("s1");
  assert.deepEqual(exits, [2]);
});

test("nothing is delivered once the router is closed", () => {
  const { router, data, exits } = collect();
  router.bind("s1");
  router.close();
  router.data({ id: "s1", data: "late" });
  router.exit({ id: "s1", code: 0 });
  assert.deepEqual(data, []);
  assert.deepEqual(exits, []);
});

test("the pending buffer cannot grow without bound", () => {
  const router = makeSessionRouter({ cap: 3 });
  for (let i = 0; i < 100; i++) router.data({ id: "s1", data: String(i) });
  assert.equal(router.pendingCount, 3);
});

test("a malformed payload never throws out of the router", () => {
  const { router, data } = collect();
  for (const bad of [null, undefined, 7, "x", {}, { id: "s1" }, { id: "s1", data: 3 }]) {
    router.data(bad);
    router.exit(bad);
  }
  router.bind("s1");
  assert.deepEqual(data, []);
});

// --- the resize debounce ----------------------------------------------------

function fakeTimers() {
  let next = 1;
  const jobs = new Map();
  return {
    set: (fn) => { const id = next++; jobs.set(id, fn); return id; },
    clear: (id) => { jobs.delete(id); },
    run() { const all = [...jobs.values()]; jobs.clear(); for (const fn of all) fn(); },
    size: () => jobs.size,
  };
}

test("a drag that fires every frame resizes the pty once, with the size it ended on", () => {
  // Without this, dragging a splitter is one ConPTY resize per animation frame and the child
  // reflows its screen dozens of times for one gesture.
  const timers = fakeTimers();
  const seen = [];
  const push = makeDebounced((cols) => seen.push(cols), 80, timers);
  for (const cols of [80, 90, 100, 120]) push(cols);
  assert.deepEqual(seen, [], "nothing runs while the gesture is still moving");
  assert.equal(timers.size(), 1, "each call replaces the pending one rather than adding to it");
  timers.run();
  assert.deepEqual(seen, [120], "the size it ended on, and only that one");
});

test("a cancelled debounce never runs", () => {
  // destroy() cancels it. A resize that lands after pty_close is a resize on a session that no
  // longer exists, which the backend answers with an error nobody can act on.
  const timers = fakeTimers();
  const seen = [];
  const push = makeDebounced(() => seen.push(1), 80, timers);
  push();
  assert.equal(push.pending(), true);
  push.cancel();
  assert.equal(push.pending(), false);
  timers.run();
  assert.deepEqual(seen, []);
});

test("flush runs the pending call immediately and leaves nothing behind", () => {
  const timers = fakeTimers();
  const seen = [];
  const push = makeDebounced((n) => seen.push(n), 80, timers);
  push(1);
  push(2);
  push.flush();
  assert.deepEqual(seen, [2]);
  assert.equal(timers.size(), 0);
  push.flush();
  assert.deepEqual(seen, [2], "flushing twice does not run it twice");
});

// --- the theme --------------------------------------------------------------

const TOKENS = {
  "--cat-ground": "#0d0e12",
  "--cat-ink": "#e8e9ec",
  "--cat-ink-strong": "#ffffff",
  "--cat-body": "#c9cad0",
  "--cat-faint": "#5c5e65",
  "--cat-signal": "#e94560",
  "--cat-signal-lt": "#ff5d76",
  "--cat-signal-tint-2": "rgba(233, 69, 96, .22)",
  "--cat-ok": "#58c98b",
  "--cat-warn": "#ffbf63",
  "--cat-bad": "#ff5d76",
};
const reader = (map) => (name) => map[name] || "";

test("the terminal takes its colours from the identity tokens", () => {
  const theme = buildXtermTheme(reader(TOKENS));
  assert.equal(theme.background, TOKENS["--cat-ground"]);
  assert.equal(theme.foreground, TOKENS["--cat-ink"]);
  assert.equal(theme.cursor, TOKENS["--cat-signal"]);
  assert.equal(theme.red, TOKENS["--cat-bad"]);
  assert.equal(theme.green, TOKENS["--cat-ok"]);
  assert.equal(theme.yellow, TOKENS["--cat-warn"]);
});

test("selection reuses the identity's own translucent signal rather than mixing one", () => {
  // A colour mixed here would be a colour invented here. The identity already ships the accent at
  // an alpha, which is exactly what a selection is.
  assert.equal(THEME_TOKENS.selectionBackground, "--cat-signal-tint-2");
  assert.equal(buildXtermTheme(reader(TOKENS)).selectionBackground, "rgba(233, 69, 96, .22)");
});

test("no ANSI slot is invented for a colour the identity has no token for", () => {
  // blue, cyan and magenta have no token. Pointing them at the signal colour would turn every
  // directory listing crimson; leaving them out keeps xterm's own defaults, which is honest.
  const theme = buildXtermTheme(reader(TOKENS));
  for (const key of ["blue", "cyan", "magenta", "brightBlue", "brightCyan", "brightMagenta"]) {
    assert.equal(key in theme, false, `${key} should be left to xterm`);
    assert.equal(key in THEME_TOKENS, false);
  }
});

test("every token the theme names is one the identity actually defines", () => {
  // The guard against a token that was renamed out from under this file: a name that resolves to
  // nothing does not throw, it just quietly drops that colour back to xterm's default.
  const defined = new Set(Object.keys(TOKENS));
  for (const token of Object.values(THEME_TOKENS)) {
    assert.equal(defined.has(token), true, `${token} is not in identity.css`);
  }
});

test("a missing or nonsense token is skipped, not passed to xterm", () => {
  // xterm throws out of its colour manager on a value it cannot parse, and that throw happens
  // inside open() - the pane would be a blank rectangle with a stack trace in the console.
  const theme = buildXtermTheme(reader({ "--cat-ground": "", "--cat-ink": "not a colour", "--cat-ok": "#58c98b" }));
  assert.equal("background" in theme, false);
  assert.equal("foreground" in theme, false);
  assert.equal(theme.green, "#58c98b");
  for (const value of Object.values(theme)) {
    assert.equal(typeof value, "string");
    assert.notEqual(value, "");
  }
});

test("an empty identity produces an empty theme rather than a broken one", () => {
  assert.deepEqual(buildXtermTheme(() => ""), {});
});
