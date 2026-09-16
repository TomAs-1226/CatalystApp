// The Claude Code pane: a status strip over a terminal running the CLI in the project directory.
//
// The strip is the point. A Claude session that starts in the right folder but without the MCP
// server wired is not obviously broken - it answers, fluently, out of training data, about a
// library whose API changed underneath it. The four facts across the top are the ones that decide
// whether the answers will be about this project: the CLI is there and which version, the Catalyst
// MCP server is wired, CLAUDE.md exists, and the folder is in the registry the server reads.
//
// When the CLI is not there the pane says where the app looked instead of opening a terminal that
// prints one error and sits dead. On this machine that is the normal case, not the exotic one:
// `claude` ships inside the desktop app and is not on PATH.

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
 * @returns {{ destroy, refresh, prepare, status }}
 */
export function mountAgent({ el, dir }) {
  el.classList.add("ws-agent");
  el.innerHTML = "";

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

  const msg = document.createElement("div");
  msg.className = "ws-agent-msg hidden";

  const body = document.createElement("div");
  body.className = "ws-agent-body";

  el.append(strip, msg, body);

  let status = normalizeStatus(null);
  let terminal = null;
  let busy = false;
  let destroyed = false;

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
    chips.innerHTML = "";
    for (const chip of statusChips(status)) {
      const node = document.createElement("div");
      node.className = "cat-chip ws-chip";
      node.dataset.tone = chip.tone;
      node.dataset.chip = chip.id;
      if (chip.detail) node.title = chip.detail;
      // The identity gives status a shape as well as a colour, so the strip still reads in
      // greyscale and to someone who cannot tell the red from the green.
      const dot = document.createElement("span");
      dot.className = "cat-dot cat-dot--" + chip.tone;
      const k = document.createElement("span");
      k.className = "ws-chip-k";
      k.textContent = chip.label;
      const v = document.createElement("span");
      v.className = "ws-chip-v";
      v.textContent = chip.value;
      node.append(dot, k, v);
      chips.appendChild(node);
    }
    prepareBtn.textContent = isReady(status) ? "Set up again" : "Set this project up";
    prepareBtn.disabled = busy;
    recheckBtn.disabled = busy;
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
    paintChips();
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
      paintChips();
      say(isReady(status) ? "ok" : "warn", prepareSummary(before, status));
      await paintBody();
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
    async destroy() {
      destroyed = true;
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
