// The Claude Code pane: a head, a setup strip that folds away, and a terminal running the CLI in the
// project directory.
//
// The strip matters while something is missing. A Claude session that starts in the right folder
// but without the MCP server wired is not obviously broken - it answers, fluently, out of training
// data, about a library whose API changed underneath it. The four facts on the strip are the ones
// that decide whether the answers will be about this project: the CLI is there and which version,
// the Catalyst MCP server is wired, CLAUDE.md exists, and the folder is in the registry the server
// reads. Once all four hold, the strip has nothing left to say and folds under the head, whose one
// dot keeps reporting; the head's Setup button and Settings → AI agents both bring it back.
//
// When the CLI is not there the pane says where the app looked instead of opening a terminal that
// prints one error and sits dead. On this machine that is the normal case, not the exotic one:
// `claude` ships inside the desktop app and is not on PATH.

import { svg } from "../core.js";
import { mountTerminal } from "./terminal.js";

/**
 * Accept an `AgentStatus` in either spelling and give back one shape.
 *
 * serde serialises the struct's fields as they are written unless the Rust side adds
 * `rename_all = "camelCase"`, and which of those happens is not this module's decision to make.
 * Reading both is four lines; guessing wrong is a status strip that reports everything missing on
 * a machine where everything is present.
 */
export function normalizeStatus(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  const pick = (snake, camel) => (s[snake] !== undefined ? s[snake] : s[camel]);
  const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    cli_path: str(pick("cli_path", "cliPath")),
    cli_version: str(pick("cli_version", "cliVersion")),
    mcp_wired: !!pick("mcp_wired", "mcpWired"),
    claude_md: !!pick("claude_md", "claudeMd"),
    project_registered: !!pick("project_registered", "projectRegistered"),
  };
}

/** Everything the agent needs is in place. */
export function isReady(status) {
  const s = normalizeStatus(status);
  return !!(s.cli_path && s.mcp_wired && s.claude_md && s.project_registered);
}

/** The four facts, as chips. */
export function statusChips(status) {
  const s = normalizeStatus(status);
  return [
    {
      id: "cli",
      label: "Claude Code",
      value: s.cli_path ? (s.cli_version || "found") : "not found",
      tone: s.cli_path ? "ok" : "bad",
      detail: s.cli_path || null,
    },
    {
      id: "mcp",
      label: "Catalyst MCP",
      value: s.mcp_wired ? "wired" : "not wired",
      tone: s.mcp_wired ? "ok" : "warn",
      detail: s.mcp_wired ? ".mcp.json names the catalyst server" : "the agent would answer from memory, not from this library",
    },
    {
      id: "claudemd",
      label: "CLAUDE.md",
      value: s.claude_md ? "present" : "missing",
      tone: s.claude_md ? "ok" : "warn",
      detail: s.claude_md ? null : "no project instructions for the session",
    },
    {
      id: "registered",
      label: "Project",
      value: s.project_registered ? "registered" : "not registered",
      tone: s.project_registered ? "ok" : "warn",
      detail: s.project_registered ? null : "the MCP server refuses to write outside the registry",
    },
  ];
}

/**
 * The one tone for the whole pane: the worst of the four facts.
 *
 * The head shows a single dot because four dots in a 32px strip is not a summary, it is the strip
 * again. Worst-wins is the only aggregation that does not hide a problem behind three things being
 * fine.
 */
export function paneTone(status) {
  const tones = statusChips(status).map((c) => c.tone);
  if (tones.includes("bad")) return "bad";
  if (tones.includes("warn")) return "warn";
  return "ok";
}

/**
 * Whether the setup strip belongs on screen.
 *
 * Once a project is wired the strip is four green chips and two buttons reporting that nothing needs
 * doing, and it costs the session about a fifth of the pane. So it earns its place only while
 * something is actually wrong, or while the user has asked to see it - and that second case is why
 * this is a function and not `!isReady(...)` at the call site.
 */
export function stripVisible({ status, open }) {
  return !isReady(status) || !!open;
}

/**
 * Where the app looks for the CLI, in the order it looks.
 *
 * Taken from the resolution order the backend implements. It is written out because "Claude Code
 * was not found" with no list is unactionable, and the fix - the environment variable - is the
 * first item.
 */
export function cliSearchPlaces() {
  return [
    "the CATALYST_CLAUDE_EXE environment variable",
    "claude / claude.exe on PATH",
    "the newest version folder under %APPDATA%\\Claude\\claude-code\\",
  ];
}

/**
 * What `agent_prepare` actually changed, in one sentence.
 *
 * Prepare is idempotent and mostly silent, so without this the button looks like it did nothing
 * the second time it is pressed - and the case worth reporting is the quiet one: a CLAUDE.md that
 * was already there is left alone on purpose, not overwritten.
 */
export function prepareSummary(before, after) {
  const b = normalizeStatus(before);
  const a = normalizeStatus(after);
  const did = [];
  if (!b.mcp_wired && a.mcp_wired) did.push("wired the Catalyst MCP server");
  else if (a.mcp_wired) did.push("the MCP server was already wired");
  if (!b.claude_md && a.claude_md) did.push("wrote CLAUDE.md");
  else if (a.claude_md) did.push("left the existing CLAUDE.md alone");
  if (!a.mcp_wired) did.push("could not wire the MCP server");
  if (!a.claude_md) did.push("CLAUDE.md is still missing");
  if (!a.project_registered) did.push("this folder is not in the project registry, so the agent may read it but not write to it");
  if (!did.length) return "Nothing to change.";
  return did.join("; ") + ".";
}

// ---------------------------------------------------------------- the pane

/**
 * Paint the four facts into `container` as chips.
 *
 * Shared with Settings → AI agents, which shows the same setup outside the workspace; two copies of
 * this markup would be two answers to what a status chip looks like.
 */
export function renderChips(container, status) {
  container.innerHTML = "";
  for (const chip of statusChips(status)) {
    const node = document.createElement("div");
    node.className = "cat-chip ws-chip";
    node.dataset.tone = chip.tone;
    node.dataset.chip = chip.id;
    if (chip.detail) node.title = chip.detail;
    // The identity gives status a shape as well as a colour, so the strip still reads in greyscale
    // and to someone who cannot tell the red from the green.
    const dot = document.createElement("span");
    dot.className = "cat-dot cat-dot--" + chip.tone;
    const k = document.createElement("span");
    k.className = "ws-chip-k";
    k.textContent = chip.label;
    const v = document.createElement("span");
    v.className = "ws-chip-v";
    v.textContent = chip.value;
    node.append(dot, k, v);
    container.appendChild(node);
  }
}

const tauri = () => (typeof window === "undefined" ? null : window.__TAURI__ || null);
const invoke = (cmd, args) => {
  const t = tauri();
  if (!t) return Promise.reject(new Error("not running inside the Catalyst app"));
  return t.core.invoke(cmd, args);
};
const messageOf = (err) =>
  typeof err === "string" ? err : (err && err.message) || String(err || "something went wrong");

/**
 * Mount the Claude Code pane.
 *
 * @param {object}  opts
 * @param {Element} opts.el   the element to fill
 * @param {string}  opts.dir  the project directory the session runs in
 * @param {function} [opts.onHide]  folds the whole pane away; the head grows a close button with it
 * @returns {{ destroy, refresh, prepare, showSetup, send, status, ready }}
 */
export function mountAgent({ el, dir, onHide }) {
  el.classList.add("ws-agent");
  el.innerHTML = "";

  /* The head is what the pane looks like at rest: which pane this is, one dot for whether it is
     healthy, and the way back to the setup it puts away. It is the same 32px strip the dock wears,
     so the two panes read as one family rather than two ideas of what a pane is. */
  const head = document.createElement("div");
  head.className = "ws-agent__head";
  const headDot = document.createElement("span");
  headDot.className = "cat-dot cat-dot--ok";
  const headName = document.createElement("span");
  headName.className = "cat-eyebrow";
  headName.textContent = "CLAUDE CODE";
  const headNote = document.createElement("span");
  headNote.className = "ws-agent-head-note";
  const headSpace = document.createElement("span");
  headSpace.className = "ws-agent-head-space";
  const setupBtn = document.createElement("button");
  setupBtn.type = "button";
  setupBtn.className = "cat-btn cat-btn--ghost ws-agent-setup";
  setupBtn.textContent = "Setup";
  head.append(headDot, headName, headNote, headSpace, setupBtn);
  if (onHide) {
    const hideBtn = document.createElement("button");
    hideBtn.type = "button";
    hideBtn.className = "cat-btn cat-btn--ghost";
    hideBtn.title = "Hide this pane";
    hideBtn.setAttribute("aria-label", "Hide this pane");
    hideBtn.innerHTML = svg("close");
    hideBtn.addEventListener("click", () => onHide());
    head.append(hideBtn);
  }

  // The strip folds rather than vanishing, and a grid row is what folds: 1fr to 0fr animates, where
  // `height: auto` does not, and nothing here has to know how tall the chips ended up being. The row
  // holds an unpadded wrapper rather than the strip itself, because a box cannot be shorter than its
  // own padding and border - folded straight onto the strip, the row stopped at 17px.
  //
  // It starts folded, and without travel: until the first status read comes back there is nothing to
  // report, and a ready project opening the strip only to fold it again is a flash on every open.
  const fold = document.createElement("div");
  fold.className = "ws-agent-fold";
  fold.dataset.open = "off";
  fold.dataset.instant = "";
  const foldInner = document.createElement("div");
  foldInner.className = "ws-agent-fold__inner";

  const strip = document.createElement("div");
  strip.className = "ws-agent-strip";
  const chips = document.createElement("div");
  chips.className = "ws-chips";
  const actions = document.createElement("div");
  actions.className = "ws-agent-actions";
  const prepareBtn = document.createElement("button");
  prepareBtn.type = "button";
  prepareBtn.className = "cat-btn cat-btn--primary";
  prepareBtn.textContent = "Set this project up";
  const recheckBtn = document.createElement("button");
  recheckBtn.type = "button";
  recheckBtn.className = "cat-btn";
  recheckBtn.textContent = "Re-check";
  actions.append(prepareBtn, recheckBtn);
  strip.append(chips, actions);
  foldInner.appendChild(strip);
  fold.appendChild(foldInner);

  const msg = document.createElement("div");
  msg.className = "ws-agent-msg hidden";

  const body = document.createElement("div");
  body.className = "ws-agent-body";

  el.append(head, fold, msg, body);

  let status = normalizeStatus(null);
  let terminal = null;
  let busy = false;
  let destroyed = false;
  let setupOpen = false;
  let collapseTimer = null;
  /** Whether a status read has come back at all. Before one has, there is nothing to report. */
  let known = false;

  const say = (tone, text) => {
    if (!text) {
      msg.classList.add("hidden");
      msg.textContent = "";
      return;
    }
    msg.classList.remove("hidden");
    msg.dataset.tone = tone;
    msg.textContent = text;
  };

  const paintChips = () => {
    renderChips(chips, status);
    prepareBtn.textContent = isReady(status) ? "Set up again" : "Set this project up";
    // Crimson only while there is something to fix; re-running a complete setup is housekeeping.
    prepareBtn.classList.toggle("cat-btn--primary", !isReady(status));
    prepareBtn.disabled = busy;
    recheckBtn.disabled = busy;

    const ready = isReady(status);
    const open = known && stripVisible({ status, open: setupOpen });
    fold.dataset.open = open ? "on" : "off";
    fold.setAttribute("aria-hidden", String(!open));
    // While something is wrong the strip cannot be dismissed, so offering a button that appears to
    // dismiss it would be a lie. The toggle exists only once there is a choice to make.
    setupBtn.hidden = !known || !ready;
    setupBtn.textContent = open ? "Hide" : "Setup";
    setupBtn.setAttribute("aria-expanded", String(open));
    // No tone until something has been read: a warning diamond on every open, for the quarter-second
    // before the answer arrives, would be the pane crying wolf.
    headDot.className = known ? "cat-dot cat-dot--" + paneTone(status) : "cat-dot";
    headNote.textContent = status.cli_version || (status.cli_path ? "found" : "");
    head.title = statusChips(status).map((c) => `${c.label}: ${c.value}`).join(" · ");
  };

  /** Fold the strip away once the good news has been read, not the instant it arrives. */
  const collapseLater = () => {
    if (collapseTimer) clearTimeout(collapseTimer);
    collapseTimer = setTimeout(() => {
      collapseTimer = null;
      if (destroyed || !isReady(status)) return;
      setupOpen = false;
      say(null, "");
      paintChips();
    }, 2600);
  };

  /** The pane the CLI's absence deserves: what was looked for, where, and the way out. */
  const paintMissingCli = () => {
    body.innerHTML = "";
    const panel = document.createElement("div");
    panel.className = "ws-agent-missing cat-card";
    const h = document.createElement("div");
    h.className = "cat-card__title";
    h.textContent = "Claude Code is not on this machine — or not where the app looked";
    const p = document.createElement("p");
    p.className = "ws-agent-missing-lead";
    p.textContent = "Catalyst looked in three places, in this order:";
    const list = document.createElement("ol");
    list.className = "ws-agent-places";
    for (const place of cliSearchPlaces()) {
      const li = document.createElement("li");
      li.textContent = place;
      list.appendChild(li);
    }
    const tail = document.createElement("p");
    tail.className = "ws-agent-missing-tail";
    tail.textContent =
      "The CLI ships inside the Claude desktop app and is usually not on PATH. Point "
      + "CATALYST_CLAUDE_EXE at that claude.exe, then re-check — nothing needs reinstalling.";
    panel.append(h, p, list, tail);
    body.appendChild(panel);
  };

  const mountSession = () => {
    body.innerHTML = "";
    const host = document.createElement("div");
    host.className = "ws-agent-term";
    body.appendChild(host);
    terminal = mountTerminal({
      el: host,
      kind: "claude",
      cwd: dir,
      args: [],
      onError: (text) => say("bad", text),
    });
  };

  /**
   * Show the right thing under the strip.
   *
   * A live session is never torn down for a status refresh - re-checking mid-conversation must not
   * cost the conversation. The terminal is only rebuilt when the CLI's presence actually flips.
   */
  const paintBody = async () => {
    const have = !!status.cli_path;
    if (have && terminal) return;
    if (!have && terminal) {
      const old = terminal;
      terminal = null;
      await old.destroy();
    }
    if (have) mountSession();
    else paintMissingCli();
  };

  async function readStatus() {
    try {
      const raw = await invoke("agent_status", { dir });
      status = normalizeStatus(raw);
      return true;
    } catch (err) {
      status = normalizeStatus(null);
      say("bad", "Could not read the agent's status: " + messageOf(err));
      return false;
    }
  }

  async function refresh({ quiet = false } = {}) {
    if (destroyed) return status;
    busy = true;
    paintChips();
    if (!quiet) say("dim", "Checking…");
    const ok = await readStatus();
    busy = false;
    if (destroyed) return status;
    const firstAnswer = !known;
    known = true;
    paintChips();
    // The first answer lands without travel - it is the state the pane opened in, not a change - and
    // everything after it moves. Two frames, so the instant state is painted before travel returns.
    if (firstAnswer) {
      const settle = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (f) => setTimeout(f, 16);
      settle(() => settle(() => { delete fold.dataset.instant; }));
    }
    if (ok) say(null, "");
    await paintBody();
    return status;
  }

  async function prepare() {
    if (destroyed || busy) return status;
    const before = status;
    busy = true;
    paintChips();
    say("dim", "Setting the project up…");
    try {
      const raw = await invoke("agent_prepare", { dir });
      status = normalizeStatus(raw);
      busy = false;
      if (destroyed) return status;
      known = true;
      // Held open for the good news: the chips turning green is the confirmation, and a strip that
      // folded on the same frame would take the evidence away before anyone saw it.
      if (isReady(status)) setupOpen = true;
      paintChips();
      say(isReady(status) ? "ok" : "warn", prepareSummary(before, status));
      await paintBody();
      if (isReady(status)) collapseLater();
    } catch (err) {
      busy = false;
      if (destroyed) return status;
      paintChips();
      // Prepare writes files. A failure here is a real one - a path that is not writable, a
      // .mcp.json that is not valid JSON - and it is shown as it came back rather than summarised.
      say("bad", "Could not set the project up: " + messageOf(err));
    }
    return status;
  }

  prepareBtn.addEventListener("click", () => { prepare().catch(() => {}); });
  recheckBtn.addEventListener("click", () => { refresh().catch(() => {}); });
  setupBtn.addEventListener("click", () => {
    if (collapseTimer) { clearTimeout(collapseTimer); collapseTimer = null; }
    setupOpen = !setupOpen;
    if (!setupOpen) say(null, "");
    paintChips();
    // Opening it to check something should also refresh it: the answer on screen is from whenever
    // the pane last looked, and the thing most likely to have changed is the one being checked.
    if (setupOpen) refresh({ quiet: true }).catch(() => {});
  });

  paintChips();
  // Every failure inside refresh has a place on the strip, so this is only a guard against a
  // rejection that nothing would otherwise await until destroy().
  const first = refresh({ quiet: true }).catch(() => status);

  return {
    /*
     * Put text into the session's prompt without sending it.
     *
     * The editor's "Ask about this file" writes an `@path` reference here and stops, because the
     * question is the user's to ask. Pressing Return for them would send whatever sentence the app
     * invented on their behalf, to an agent that can change their project.
     */
    async send(text) {
      if (!terminal || !text) return false;
      try {
        await terminal.ready;
        await invoke("pty_write", { id: terminal.id, data: String(text) });
        terminal.focus?.();
        return true;
      } catch (e) {
        say("bad", messageOf(e));
        return false;
      }
    },
    /** Open the setup strip from outside the pane — Settings and the palette both do this. */
    showSetup() {
      if (destroyed) return;
      if (collapseTimer) { clearTimeout(collapseTimer); collapseTimer = null; }
      setupOpen = true;
      paintChips();
      refresh({ quiet: true }).catch(() => {});
    },
    async destroy() {
      destroyed = true;
      if (collapseTimer) { clearTimeout(collapseTimer); collapseTimer = null; }
      try { await first; } catch { /* reported already */ }
      if (terminal) {
        const old = terminal;
        terminal = null;
        await old.destroy();
      }
      el.innerHTML = "";
      el.classList.remove("ws-agent");
    },
    refresh,
    prepare,
    get status() {
      return status;
    },
    /** Resolves once the first status read has finished. */
    ready: () => first,
  };
}
