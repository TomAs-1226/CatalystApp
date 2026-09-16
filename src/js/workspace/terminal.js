// The terminal pane: one PTY on the Rust side, one xterm in the DOM, and the wiring between them.
//
// Everything that is not DOM lives in exported functions at the top of this file, because the
// interesting failures here are all in the wiring and none of them need a browser to reproduce:
//
//   - output that arrives before `pty_open` has returned the session id (the first line of a
//     Gradle build is emitted in under a millisecond; an `await` across the IPC boundary is not),
//   - output belonging to *another* session, which with four panes open is most of it,
//   - a resize storm from dragging the splitter, which without a debounce is one ConPTY resize
//     per animation frame,
//   - a payload that is not the shape the contract promises, which must never throw inside an
//     event listener - a throw there kills the listener and the pane goes silent for good.
//
// The DOM half is deliberately thin: mount, listen, write, close.

// The session id is not known until `pty_open` resolves, so the listeners are registered first and
// everything they see is buffered until then. This caps that buffer. The window it covers is
// milliseconds; the cap only exists so a pathological case cannot grow without bound.
const PENDING_CAP = 512;

// How long the pane waits after the last resize before telling the PTY. Dragging a splitter emits
// a ResizeObserver callback per frame, and a ConPTY resize per frame makes the child reflow its
// screen dozens of times for one gesture. This is a functional settle time, not a motion duration.
const RESIZE_SETTLE_MS = 80;

// Build output is long. xterm's default of 1000 lines loses the start of a Gradle failure, which
// is the only part worth reading.
const SCROLLBACK = 5000;

// Where the vendor script puts xterm. The first path in each list is the layout `scripts/vendor.mjs`
// actually writes - flat, both module formats side by side. The rest are the spellings a copy step
// could reasonably produce instead, because that script is someone else's file and src/vendor/ is
// gitignored, so this module cannot check the layout into the repository and rely on it. The UMD
// builds assign their exports onto globalThis when imported as a module, which is why they work as
// a fallback at all. Nothing here is ever fetched from a network: every path is relative to this
// file, inside the app, as `script-src 'self'` requires.
const XTERM_MODULES = [
  "../../vendor/xterm/xterm.mjs",
  "../../vendor/xterm/lib/xterm.mjs",
  "../../vendor/xterm/xterm.js",
  "../../vendor/xterm/lib/xterm.js",
];
const FIT_MODULES = [
  "../../vendor/xterm/addon-fit.mjs",
  "../../vendor/xterm/lib/addon-fit.mjs",
  "../../vendor/xterm/addon-fit/lib/addon-fit.mjs",
  "../../vendor/xterm/addon-fit.js",
  "../../vendor/xterm/lib/addon-fit.js",
];
const XTERM_STYLES = [
  "../../vendor/xterm/xterm.css",
  "../../vendor/xterm/css/xterm.css",
];

// The workspace stylesheet. Injected rather than assumed, because `src/vendor/` is gitignored and
// the shell's index.html cannot link a file that may not be on disk.
const WORKSPACE_STYLES = "../../styles/workspace.css";

// ---------------------------------------------------------------- event payloads

/**
 * Return the payload of a `pty://…` event if it belongs to `id`, otherwise null.
 *
 * Both halves matter. The id check is what stops four panes from printing each other's output,
 * and the shape check is what stops one malformed payload from killing the listener.
 */
export function payloadFor(id, payload) {
  if (!payload || typeof payload !== "object") return null;
  if (typeof payload.id !== "string" || payload.id !== id) return null;
  return payload;
}

/** The text of a `pty://data` payload. Anything that is not a string is no output at all. */
export function dataOf(payload) {
  const data = payload ? payload.data : undefined;
  return typeof data === "string" ? data : "";
}

/**
 * The exit code of a `pty://exit` payload, as a number or null.
 *
 * The contract types it `Option<i32>`, which serialises to null. A process that left no code has
 * to stay null: "exit 0" for a process that was killed is how a failed deploy gets called a
 * success. `exit_code` is read as well because that is the name the same number carries on
 * `PtyInfo`, and one struct being renamed is not worth a pane that reports every build as having
 * ended without a status.
 */
export function codeOf(payload) {
  if (!payload) return null;
  const code = payload.code !== undefined ? payload.code : payload.exit_code;
  return typeof code === "number" ? code : null;
}

// What Windows reports for a process killed because its console went away: STATUS_CONTROL_C_EXIT,
// 0xC000013A as a signed i32. It means the pty closed under the child, not that the build failed.
const STATUS_CONTROL_C_EXIT = -1073741510;

/**
 * What to show when a session ends.
 *
 * Three of these four cases exist because of how a PTY dies on Windows. `stopped` is set when this
 * pane asked for the kill, and it outranks the code: closing a session reports 1, and painting the
 * user's own Stop button as "exit code 1" in failure red is a lie the colour sells hard. The
 * control-C status is the same story from the other end - the console went away under the child -
 * and a raw -1073741510 on screen tells nobody anything.
 */
export function exitNote(code, { stopped = false } = {}) {
  if (stopped) return { tone: "dim", text: "Stopped." };
  if (code === STATUS_CONTROL_C_EXIT) return { tone: "dim", text: "Stopped — the terminal closed under it." };
  if (code === 0) return { tone: "ok", text: "Finished — exit code 0." };
  if (code === null || code === undefined) return { tone: "warn", text: "Ended without reporting an exit code." };
  return { tone: "bad", text: `Exited with code ${code}.` };
}

/**
 * Normalise the `PtyOpen` request.
 *
 * cols and rows are `u16` on the other side: a zero, a fraction or a NaN out of `proposeDimensions`
 * on a pane that is not laid out yet is a deserialisation error, not a small terminal.
 */
export function ptyOpenRequest({ kind, cwd, args, cols, rows }) {
  return {
    kind: String(kind),
    cwd: String(cwd),
    args: Array.isArray(args) ? args.map(String) : [],
    cols: clampDim(cols),
    rows: clampDim(rows),
  };
}

function clampDim(n) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v < 1) return 1;
  return Math.min(v, 65535);
}

/** True when a new size is usable and actually differs from the last one sent. */
export function sizeChanged(prev, next) {
  if (!next || !(next.cols > 0) || !(next.rows > 0)) return false;
  return !prev || prev.cols !== next.cols || prev.rows !== next.rows;
}

/**
 * The router between the two global `pty://…` events and one pane.
 *
 * Listeners have to be registered before `pty_open` is called, because the child starts writing
 * immediately and an event emitted before anyone is listening is simply gone. That leaves a window
 * in which this pane is listening but does not yet know which id is its own, so everything is kept
 * and replayed in order once `bind` names it. After that the id filter does the work.
 */
export function makeSessionRouter({ onData, onExit, cap = PENDING_CAP } = {}) {
  let id = null;
  let closed = false;
  let pending = [];

  const deliver = (event) => {
    if (event.kind === "data") {
      const text = dataOf(event.payload);
      if (text && onData) onData(text);
    } else if (onExit) {
      onExit(codeOf(event.payload));
    }
  };

  const accept = (kind, payload) => {
    if (closed) return;
    if (id === null) {
      // Not ours to judge yet - the id arrives with `pty_open`, this is what the window costs.
      pending.push({ kind, payload });
      if (pending.length > cap) pending.shift();
      return;
    }
    if (!payloadFor(id, payload)) return;
    deliver({ kind, payload });
  };

  return {
    data: (payload) => accept("data", payload),
    exit: (payload) => accept("exit", payload),
    bind(sessionId) {
      if (closed) return;
      id = sessionId;
      const replay = pending;
      pending = [];
      for (const event of replay) {
        if (payloadFor(id, event.payload)) deliver(event);
      }
    },
    close() {
      closed = true;
      pending = [];
    },
    get id() {
      return id;
    },
    get pendingCount() {
      return pending.length;
    },
  };
}

/**
 * A trailing debounce with injectable timers, so the resize path can be tested without waiting.
 *
 * Trailing and not leading on purpose: the size that matters is the one the drag ends on, and the
 * one it starts from is already on screen.
 */
export function makeDebounced(fn, wait, timers) {
  const set = timers ? timers.set : setTimeout;
  const clear = timers ? timers.clear : clearTimeout;
  let handle = null;
  let lastArgs = null;

  const call = (...args) => {
    lastArgs = args;
    if (handle !== null) clear(handle);
    handle = set(() => {
      handle = null;
      const a = lastArgs;
      lastArgs = null;
      fn(...a);
    }, wait);
  };
  call.cancel = () => {
    if (handle !== null) clear(handle);
    handle = null;
    lastArgs = null;
  };
  call.flush = () => {
    if (handle === null) return;
    clear(handle);
    handle = null;
    const a = lastArgs;
    lastArgs = null;
    fn(...a);
  };
  call.pending = () => handle !== null;
  return call;
}

// ---------------------------------------------------------------- theme

// Which identity token each xterm colour comes from. xterm needs resolved colour strings, so this
// is read at run time rather than written into a theme object: the accent is repainted live by the
// settings page, and a terminal that kept the colours it was born with would be the one thing in
// the window that did not follow.
//
// blue, cyan and magenta are deliberately absent. The identity has no token for them, and mapping
// them onto the signal colour would turn every `ls` crimson.
export const THEME_TOKENS = {
  background: "--cat-ground",
  foreground: "--cat-ink",
  cursor: "--cat-signal",
  cursorAccent: "--cat-ground",
  // The identity already owns a translucent signal; a selection is exactly what it is for, so
  // nothing here has to mix a colour of its own.
  selectionBackground: "--cat-signal-tint-2",
  black: "--cat-ground",
  brightBlack: "--cat-faint",
  red: "--cat-bad",
  brightRed: "--cat-signal-lt",
  green: "--cat-ok",
  brightGreen: "--cat-ok",
  yellow: "--cat-warn",
  brightYellow: "--cat-warn",
  white: "--cat-body",
  brightWhite: "--cat-ink-strong",
};

// xterm throws out of its colour manager on a value it cannot parse, and a throw there happens
// during `open()` - the pane would be a blank rectangle with an exception in the console. A token
// that is missing or holds something that is not a colour is skipped instead, and xterm keeps its
// own default for that slot.
const COLOUR_LIKE = /^(#|rgb|rgba|hsl|hsla|color|lab|lch|oklab|oklch)\b|^#/i;

function looksLikeColour(value) {
  const v = String(value || "").trim();
  if (!v) return false;
  if (v.startsWith("#")) return /^#[0-9a-f]{3,8}$/i.test(v);
  return COLOUR_LIKE.test(v);
}

/**
 * Build an xterm theme from the identity tokens.
 *
 * `read(name)` returns a token's colour, or "" when it is not defined or is not a colour. It is
 * injected so this is testable without a document, and so the reader can be the sharper one from
 * theme.js when that module is present.
 */
export function buildXtermTheme(read) {
  const theme = {};
  for (const [key, token] of Object.entries(THEME_TOKENS)) {
    const value = read(token);
    if (looksLikeColour(value)) theme[key] = String(value).trim();
  }
  return theme;
}

function localTokenReader() {
  return (name) => {
    try {
      // Custom properties are substituted at computed-value time, so this follows var() chains -
      // --cat-bad is defined as var(--cat-signal-lt) and reads as the colour, not as the text.
      return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    } catch {
      return "";
    }
  };
}

/**
 * The token reader, from `src/js/theme.js` when it is there.
 *
 * theme.js is the editor pane's module and exists for the same reason this needs one: a theme that
 * is a JSON object cannot say var(--cat-signal). Its `hexToken` resolves the whole chain and hands
 * back hex, including for tokens written as rgba() - worth using rather than duplicating, and the
 * local reader below is only what this module would do on its own if that file were absent.
 */
async function loadTokenReader() {
  const local = localTokenReader();
  try {
    const mod = await import(new URL("../theme.js", import.meta.url).href);
    const raw = typeof mod.cssToken === "function" ? (name) => mod.cssToken(name) || "" : local;
    const colour = typeof mod.hexToken === "function" ? (name) => mod.hexToken(name) || "" : raw;
    return { colour, raw };
  } catch {
    // Not there yet, or not loadable. The local reader covers everything this pane needs.
  }
  return { colour: local, raw: local };
}

// ---------------------------------------------------------------- vendored xterm

let xtermPromise = null;

function pickExport(mod, name) {
  if (mod && typeof mod[name] === "function") return mod[name];
  if (mod && mod.default && typeof mod.default[name] === "function") return mod.default[name];
  // The UMD builds assign their exports onto globalThis when imported as a module.
  if (typeof globalThis[name] === "function") return globalThis[name];
  return null;
}

async function importFirst(candidates, exportName) {
  const tried = [];
  for (const rel of candidates) {
    const href = new URL(rel, import.meta.url).href;
    try {
      const mod = await import(href);
      const found = pickExport(mod, exportName);
      if (found) return found;
      tried.push(`${rel} (loaded, no ${exportName})`);
    } catch (err) {
      tried.push(`${rel} (${err && err.message ? err.message : "not found"})`);
    }
  }
  throw new Error(`could not load ${exportName} from src/vendor/xterm — tried ${tried.join(", ")}`);
}

function ensureStylesheet(id, candidates) {
  if (document.getElementById(id)) return;
  let index = 0;
  const link = document.createElement("link");
  link.id = id;
  link.rel = "stylesheet";
  link.addEventListener("error", () => {
    index += 1;
    if (index < candidates.length) link.href = new URL(candidates[index], import.meta.url).href;
  });
  link.href = new URL(candidates[index], import.meta.url).href;
  document.head.appendChild(link);
}

async function ensureXterm() {
  if (!xtermPromise) {
    xtermPromise = (async () => {
      // xterm's stylesheet first, so the workspace one that follows wins a tie on source order.
      // The rules that must not lose are written to win on specificity anyway, because index.html
      // may well link the workspace sheet statically, long before this runs.
      ensureStylesheet("cat-xterm-css", XTERM_STYLES);
      ensureStylesheet("cat-workspace-css", [WORKSPACE_STYLES]);
      const Terminal = await importFirst(XTERM_MODULES, "Terminal");
      let FitAddon = null;
      try {
        FitAddon = await importFirst(FIT_MODULES, "FitAddon");
      } catch {
        // The fit addon is a convenience. Without it the terminal still runs; it just keeps the
        // size it opened with, which is better than no terminal.
        FitAddon = null;
      }
      return { Terminal, FitAddon };
    })().catch((err) => {
      // Do not cache a failure: a later mount, after the vendor step has run, should try again.
      xtermPromise = null;
      throw err;
    });
  }
  return xtermPromise;
}

// ---------------------------------------------------------------- the pane

const tauri = () => (typeof window === "undefined" ? null : window.__TAURI__ || null);
const invoke = (cmd, args) => {
  const t = tauri();
  if (!t) return Promise.reject(new Error("not running inside the Catalyst app"));
  return t.core.invoke(cmd, args);
};
const messageOf = (err) =>
  typeof err === "string" ? err : (err && err.message) || String(err || "something went wrong");

const isWindows = () => {
  try {
    const p = navigator.userAgentData?.platform || navigator.platform || "";
    return /win/i.test(p);
  } catch {
    return false;
  }
};

/**
 * Mount a terminal bound to one PTY session.
 *
 * @param {object}   opts
 * @param {Element}  opts.el      the element to fill; its contents are replaced
 * @param {string}   opts.kind    "shell" | "devtools" | "claude"
 * @param {string}   opts.cwd     working directory for the child
 * @param {string[]} [opts.args]  arguments, for the kinds that take them
 * @param {boolean}  [opts.restartable=true]  offer to run it again when it exits
 * @param {function} [opts.onOpen]   (id) once the session exists
 * @param {function} [opts.onExit]   (code|null, { stopped }) when it ends
 * @param {function} [opts.onError]  (message) when it could not start
 * @returns {{ destroy, focus, restart, stop, retheme, isAlive, isRunning, id }}
 */
export function mountTerminal({ el, kind, cwd, args = [], restartable = true, onOpen, onExit, onError }) {
  el.classList.add("ws-term");
  el.dataset.kind = kind;
  el.innerHTML = "";

  const screen = document.createElement("div");
  screen.className = "ws-term-screen";
  const note = document.createElement("div");
  note.className = "ws-term-note hidden";
  const noteText = document.createElement("span");
  noteText.className = "ws-term-note-text";
  const noteBtn = document.createElement("button");
  noteBtn.type = "button";
  noteBtn.className = "cat-btn ws-term-again";
  noteBtn.textContent = "Run again";
  note.append(noteText, noteBtn);
  el.append(screen, note);

  let destroyed = false;
  let term = null;
  let fit = null;
  let sessionId = null;
  let router = null;
  let unlisteners = [];
  let lastSize = null;
  let stopping = false;
  let reaped = false;
  let running = false;
  let observer = null;
  let outbox = [];
  let tokens = { colour: localTokenReader(), raw: localTokenReader() };

  const sendData = (data) =>
    invoke("pty_write", { id: sessionId, data }).catch((err) => {
      showNote("bad", messageOf(err));
    });

  // Anything xterm produced before the session id came back. In practice that is the cursor-position
  // report, which the child is waiting on before it runs at all, and whatever was typed into a pane
  // that had not finished opening.
  const flushOutbox = () => {
    if (!outbox.length || !sessionId) return;
    const queued = outbox.join("");
    outbox = [];
    sendData(queued);
  };

  /** Close a session that has already ended, so its reader thread is not left parked. */
  const reap = () => {
    if (reaped || !sessionId) return;
    reaped = true;
    invoke("pty_close", { id: sessionId }).catch(() => {});
  };

  const showNote = (tone, text, { again = false } = {}) => {
    if (destroyed) return;
    note.classList.remove("hidden");
    note.dataset.tone = tone;
    noteText.textContent = text;
    noteBtn.classList.toggle("hidden", !(again && restartable));
  };
  const hideNote = () => {
    note.classList.add("hidden");
    noteBtn.classList.add("hidden");
  };

  const applyTheme = () => {
    if (!term) return;
    try {
      const theme = buildXtermTheme(tokens.colour);
      if (Object.keys(theme).length) term.options.theme = theme;
      const mono = tokens.raw("--cat-mono");
      if (mono) term.options.fontFamily = mono;
      // --cat-fs-13 is the identity's size for mono values. Reading it rather than choosing one
      // keeps the terminal on the same type scale as everything beside it.
      const size = parseFloat(tokens.raw("--cat-fs-13"));
      if (Number.isFinite(size) && size > 0) term.options.fontSize = size;
    } catch {
      // A theme that will not apply is not worth losing the terminal over.
    }
  };

  const measure = () => {
    if (!term) return null;
    if (fit && typeof fit.proposeDimensions === "function") {
      const d = fit.proposeDimensions();
      // undefined while the pane has no layout yet - hidden tab, or mounted before the flex
      // container has resolved. The observer fires again when it does.
      if (d && d.cols > 0 && d.rows > 0) return { cols: d.cols, rows: d.rows };
      return null;
    }
    return { cols: term.cols, rows: term.rows };
  };

  const pushSize = () => {
    if (destroyed || !term) return;
    const size = measure();
    if (!sizeChanged(lastSize, size)) return;
    lastSize = size;
    try {
      if (fit) fit.fit();
      else term.resize(size.cols, size.rows);
    } catch {
      return;
    }
    if (sessionId && running) {
      invoke("pty_resize", { id: sessionId, cols: size.cols, rows: size.rows }).catch(() => {
        // A resize that misses is cosmetic; the next one lands. Never surface it.
      });
    }
  };
  const pushSizeSoon = makeDebounced(pushSize, RESIZE_SETTLE_MS);

  async function openSession() {
    stopping = false;
    reaped = false;
    lastSize = null;
    outbox = [];
    const size = measure() || { cols: term.cols, rows: term.rows };
    lastSize = size;

    router = makeSessionRouter({
      onData: (text) => { if (term) term.write(text); },
      onExit: (code) => {
        running = false;
        if (term) term.options.disableStdin = true;
        const n = exitNote(code, { stopped: stopping });
        showNote(n.tone, n.text, { again: true });
        // The reader thread on Windows never sees EOF: the exit is noticed by polling, and the
        // thread stays parked until the session is closed. A pane that finished a build and was
        // left on screen would keep one alive for the rest of the session, so the close happens
        // here rather than waiting for destroy().
        reap();
        if (onExit) onExit(code, { stopped: stopping });
      },
    });

    const t = tauri();
    if (!t || !t.event) {
      router.close();
      showNote("warn", "The terminal only runs inside the Catalyst app.");
      if (onError) onError("not running inside the Catalyst app");
      return;
    }

    // Both listeners must be *registered*, not merely requested, before the child exists.
    //
    // Two things depend on it. The obvious one is that an event emitted with nobody listening is
    // gone, and the first flush arrives within 16 ms. The one that decides whether the pane works
    // at all is quieter: portable-pty asks conhost to inherit the cursor, so conhost sends ESC[6n
    // and the child does not start running until something answers it. xterm answers automatically
    // through onData - but only if it received the query in the first place. Miss that one chunk
    // and the pane is blank forever, with no error anywhere to explain it.
    //
    // `listen` is itself an IPC round trip, so firing it and moving on is exactly the late attach
    // that loses the query. It is awaited.
    try {
      unlisteners = await Promise.all([
        t.event.listen("pty://data", (e) => router.data(e && e.payload)),
        t.event.listen("pty://exit", (e) => router.exit(e && e.payload)),
      ]);
    } catch (err) {
      const msg = messageOf(err);
      router.close();
      showNote("bad", "The terminal could not listen for output: " + msg, { again: true });
      if (onError) onError(msg);
      return;
    }
    if (destroyed) {
      await teardownSession({ close: false });
      return;
    }

    let id;
    try {
      id = await invoke("pty_open", { req: ptyOpenRequest({ kind, cwd, args, cols: size.cols, rows: size.rows }) });
    } catch (err) {
      const msg = messageOf(err);
      showNote("bad", msg, { again: true });
      if (onError) onError(msg);
      await teardownSession({ close: false });
      return;
    }
    if (destroyed) {
      invoke("pty_close", { id }).catch(() => {});
      return;
    }
    sessionId = id;
    running = true;
    router.bind(id);
    flushOutbox();
    if (onOpen) onOpen(id);
    // The pane may well have been laid out while `pty_open` was in flight.
    pushSize();
  }

  async function teardownSession({ close = true } = {}) {
    pushSizeSoon.cancel();
    outbox = [];
    if (router) router.close();
    router = null;
    const offs = unlisteners;
    unlisteners = [];
    for (const off of offs) {
      try {
        if (typeof off === "function") off();
      } catch {
        // An unlisten that throws has still stopped mattering: the router above is closed.
      }
    }
    // `reaped` means the exit handler already closed it; closing twice is only an error to swallow.
    if (close && sessionId && !reaped) {
      await invoke("pty_close", { id: sessionId }).catch(() => {
        // Already dead is the common case and not worth a message.
      });
    }
    sessionId = null;
    running = false;
  }

  const keyHandler = (ev) => {
    if (ev.type !== "keydown") return true;
    const ctrl = ev.ctrlKey || ev.metaKey;
    if (ctrl && ev.shiftKey && (ev.key === "C" || ev.key === "c")) {
      const sel = term.getSelection();
      if (sel) navigator.clipboard?.writeText(sel).catch(() => {});
      return false;
    }
    if (ctrl && ev.shiftKey && (ev.key === "V" || ev.key === "v")) {
      // Through xterm's paste, not straight to the PTY. Written raw, every newline in the clipboard
      // is a Return: three lines of code pasted into Claude Code sent the first one as a message.
      // `paste` wraps the text in bracketed-paste markers when the program asked for them, which is
      // how a TUI tells a paste from typing.
      navigator.clipboard?.readText?.()
        .then((text) => { if (text && term && sessionId && running) term.paste(text); })
        .catch(() => {});
      return false;
    }
    return true;
  };

  // This promise never rejects. Everything it can fail at has a place on screen, and a rejection
  // that only `destroy()` ever awaits is a rejection nobody sees until it is logged as unhandled.
  const start = (async () => {
    let Terminal;
    let FitAddon;
    try {
      ({ Terminal, FitAddon } = await ensureXterm());
    } catch (err) {
      showNote("bad", messageOf(err));
      if (onError) onError(messageOf(err));
      return;
    }
    if (destroyed) return;
    if (!tauri()) {
      showNote("warn", "The terminal only runs inside the Catalyst app.");
      if (onError) onError("not running inside the Catalyst app");
      return;
    }

    try {
      tokens = await loadTokenReader();

      term = new Terminal({
        allowTransparency: false,
        convertEol: false,
        cursorBlink: true,
        scrollback: SCROLLBACK,
        // ConPTY rewrites the screen itself; telling xterm which backend it is talking to is what
        // makes a resize reflow rather than duplicate the prompt.
        ...(isWindows() ? { windowsPty: { backend: "conpty" } } : {}),
      });
      applyTheme();
      if (FitAddon) {
        fit = new FitAddon();
        term.loadAddon(fit);
      }
      term.attachCustomKeyEventHandler(keyHandler);
      term.open(screen);
      // Wired before the first `pty_open`, and it does not drop what it cannot send yet: the
      // cursor-position report xterm sends back is what lets the child start, and dropping it
      // because the id has not arrived is the same hang as attaching the listener late.
      term.onData((data) => {
        if (!sessionId) {
          outbox.push(data);
          if (outbox.length > PENDING_CAP) outbox.shift();
          return;
        }
        if (!running) return;
        sendData(data);
      });

      observer = new ResizeObserver(() => pushSizeSoon());
      observer.observe(el);
    } catch (err) {
      showNote("bad", "The terminal could not start: " + messageOf(err));
      if (onError) onError(messageOf(err));
      return;
    }

    await openSession();
  })();

  noteBtn.addEventListener("click", () => { handle.restart().catch(() => {}); });

  const handle = {
    async destroy() {
      if (destroyed) return;
      destroyed = true;
      if (observer) observer.disconnect();
      observer = null;
      try { await start; } catch { /* the mount already reported it */ }
      await teardownSession({ close: true });
      if (term) term.dispose();
      term = null;
      fit = null;
      el.innerHTML = "";
      el.classList.remove("ws-term");
    },
    /** Kill the child but keep what it printed on screen. */
    async stop() {
      if (!running || !sessionId) return;
      // `stopping` is what turns the exit that follows into "Stopped." rather than "exit code 1",
      // and `reaped` stops the exit handler closing a session this call has already closed.
      stopping = true;
      reaped = true;
      await invoke("pty_close", { id: sessionId }).catch(() => {});
    },
    /** Close whatever is there and open a fresh session in the same pane. */
    async restart() {
      if (destroyed) return;
      try { await start; } catch { return; }
      if (!term) return;
      try {
        await teardownSession({ close: true });
        hideNote();
        term.options.disableStdin = false;
        term.reset();
        await openSession();
        term.focus();
      } catch (err) {
        showNote("bad", messageOf(err), { again: true });
      }
    },
    focus() {
      if (term) term.focus();
    },
    /**
     * Put text in front of the program as a paste rather than as keystrokes.
     *
     * A program in raw mode reads typed characters as commands: `/`, `!` and `?` each switch Claude
     * Code into a different mode when they arrive first, and a newline submits. As a bracketed paste
     * the same text is inserted and nothing else. Returns false when there is no live session to
     * paste into.
     */
    paste(text) {
      if (!term || !sessionId || !running || !text) return false;
      term.paste(String(text));
      return true;
    },
    /** Re-read the identity tokens. The accent picker repaints them under a live terminal. */
    retheme() {
      applyTheme();
    },
    isAlive: () => running,
    isRunning: () => running,
    get id() {
      return sessionId;
    },
    /** Resolves once the pane has finished its first open, successfully or not. */
    ready: () => start,
  };

  return handle;
}
