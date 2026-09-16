// The workspace: one project, its files, a terminal that runs devtools, and a Claude Code session.
//
// This view owns the layout and the project; it owns none of the panes. Each pane is a module with a
// `mount*` that takes its element and hands back a `destroy()`, and this file is the only place that
// knows they exist together. That is deliberate: the editor should be replaceable without touching
// the terminal, and a pane that fails to load must leave the rest of the workspace working.

import { $, $$, IN_APP, invoke, pickDirectory, settings, svg, escapeHtml } from "../core.js";
import { project, tabMark } from "../app.js";

/** The mounted panes, so a project change can take them down before putting them back up. */
const panes = { tree: null, editor: null, agent: null, terminal: null, runner: null, find: null };
let mountedFor = null;
let dockTab = "terminal";
/** Moves the dock strip's mark; replaced whenever the dock is built for a different project. */
let moveDockMark = null;

export function init() {
  $("#wsOpenBtn").onclick = openProject;
  $("#wsTreeBtn").onclick = () => toggle("tree");
  $("#wsDockBtn").onclick = () => toggle("dock");
  $("#wsAgentBtn").onclick = () => toggle("agent");
  $("#wsBuildBtn").onclick = () => run("build");
  $("#wsDeployBtn").onclick = () => run("deploy");
  document.addEventListener("catalyst:project", () => { if (!$("#view-workspace").hidden) activate(); });

  // Ctrl+S reaches the editor wherever the focus is inside the workspace, because a code pane that
  // only saves when its own textarea has focus is a pane that loses work.
  document.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if ($("#view-workspace").hidden) return;
    const key = e.key.toLowerCase();
    if (key === "s") {
      e.preventDefault();
      panes.editor?.saveActive?.();
    } else if (key === "f" && e.shiftKey) {
      e.preventDefault();
      showFind();
    }
  });
}

export async function activate() {
  const p = project.get();
  const empty = $("#wsEmpty");
  const body = $("#wsBody");
  const bar = $(".ws-bar");

  if (!p) {
    empty.hidden = false;
    body.hidden = true;
    bar.hidden = true;
    $("#wsName").textContent = "No project open";
    $("#wsPath").textContent = "";
    return;
  }

  empty.hidden = true;
  body.hidden = false;
  bar.hidden = false;
  $("#wsName").textContent = p.name;
  $("#wsPath").textContent = p.path;

  if (mountedFor === p.path) return;
  await unmount();
  mountedFor = p.path;
  await mountPanes(p);
}

/** Open a folder as the workspace's project, and register it so agents can see it too. */
async function openProject() {
  if (!IN_APP) {
    note("Opening a project needs the desktop app. In a browser preview there is no file access.");
    return;
  }
  const dir = await pickDirectory("Choose your robot project");
  if (!dir) return;
  try {
    // Registering is what makes the project visible to the MCP server, which is what makes the
    // Claude session in this window useful. Writing stays off until it is switched on per project.
    let bundled = null;
    try { bundled = await invoke("read_bundled_vendordep"); } catch (_) { /* analysis degrades */ }
    const p = await invoke("register_project", { dir, name: null, bundledVendordep: bundled });
    project.set({ name: p.name, path: p.path });
  } catch (e) {
    note("Could not open that folder: " + e);
  }
}

async function mountPanes(p) {
  await mountTree(p);
  await mountEditor(p);
  await mountDock(p);
  await mountAgentPane(p);
}

async function unmount() {
  for (const key of Object.keys(panes)) {
    try { panes[key]?.destroy?.(); } catch (_) { /* a pane that cannot close is still going away */ }
    panes[key] = null;
  }
  ["#wsTree", "#wsEditor", "#wsAgent", "#wsDock"].forEach((sel) => { $(sel).innerHTML = ""; });
  moveDockMark = null;   // its strip has just been thrown away with the dock
}

async function mountTree(p) {
  const el = $("#wsTree");
  try {
    const { mountTree: mount } = await import("../workspace/tree.js");
    panes.tree = mount({ el, root: p.path, onOpen: (path) => panes.editor?.openFile?.(path) });
  } catch (e) {
    fallback(el, "The file tree could not load.", e);
  }
}

async function mountEditor(p) {
  const el = $("#wsEditor");
  try {
    const mod = await import("../workspace/editor.js");
    const api = mod.mountEditor({ el, root: p.path });
    // The editor module may hand its API back, or export it — accept either, so the pane and this
    // view can be worked on separately.
    panes.editor = {
      destroy: api?.destroy || mod.destroy,
      openFile: api?.openFile || mod.openFile,
      saveActive: api?.saveActive || mod.saveActive,
    };
  } catch (e) {
    fallback(el, "The editor could not load.", e);
  }
}

/*
 * The dock is two tabs, because they answer different questions: a terminal is where you type, and
 * the runner is where the project's own build and deploy live with their exact devtools arguments.
 */
async function mountDock(p) {
  const dock = $("#wsDock");
  dock.innerHTML = `<div class="ws-dock__tabs">
      <button class="cat-tab" data-dock="terminal" aria-selected="true">Terminal</button>
      <button class="cat-tab" data-dock="build" aria-selected="false">Build</button>
      <button class="cat-tab" data-dock="find" aria-selected="false">Find</button>
      <span style="flex:1"></span>
      <button class="cat-btn cat-btn--ghost" data-dock-close title="Hide">${svg("close")}</button>
    </div>
    <div class="ws-dock__body" data-dock-pane="terminal"></div>
    <div class="ws-dock__body" data-dock-pane="build" hidden></div>
    <div class="ws-dock__body" data-dock-pane="find" hidden></div>`;

  $$("[data-dock]", dock).forEach((b) => { b.onclick = () => showDockTab(b.dataset.dock); });
  $("[data-dock-close]", dock).onclick = () => toggle("dock");
  // The dock's own strip gets the mark that travels, the same one the page tabs use. The dock is
  // rebuilt per project, so the mover is rebuilt with it.
  moveDockMark = tabMark($(".ws-dock__tabs", dock), { inset: "--cat-space-2" });
  moveDockMark();

  const termEl = $('[data-dock-pane="terminal"]', dock);
  try {
    const { mountTerminal } = await import("../workspace/terminal.js");
    panes.terminal = mountTerminal({ el: termEl, kind: "shell", cwd: p.path, args: [] });
  } catch (e) {
    fallback(termEl, "The terminal could not load.", e);
  }

  const findEl = $('[data-dock-pane="find"]', dock);
  try {
    const { mountFind } = await import("../workspace/find.js");
    panes.find = mountFind({ el: findEl, dir: p.path, onOpen: (path) => openPath(path) });
  } catch (e) {
    fallback(findEl, "Find could not load.", e);
  }

  const runEl = $('[data-dock-pane="build"]', dock);
  try {
    const { mountRunner } = await import("../workspace/runner.js");
    panes.runner = mountRunner({ el: runEl, dir: p.path });
  } catch (e) {
    fallback(runEl, "The build runner could not load.", e);
  }
}

function showDockTab(tab) {
  dockTab = tab;
  $$("[data-dock]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.dock === tab)));
  $$("[data-dock-pane]").forEach((p) => { p.hidden = p.dataset.dockPane !== tab; });
  moveDockMark?.();
}

async function mountAgentPane(p) {
  const el = $("#wsAgent");
  try {
    const { mountAgent } = await import("../workspace/agent.js");
    panes.agent = mountAgent({ el, dir: p.path, onHide: () => toggle("agent") });
  } catch (e) {
    fallback(el, "The Claude pane could not load.", e);
  }
}

/**
 * Show the Claude pane with its setup strip open, from Settings or the palette.
 *
 * Returns false when there is no pane to show it in — no project open — so the caller can say that
 * instead of navigating somewhere empty.
 */
export async function showAgentSetup() {
  if (!project.get()) return false;
  if (!panes.agent) await activate();
  if (!panes.agent?.showSetup) return false;
  if ($("#wsBody").dataset.agent === "off") toggle("agent");
  panes.agent.showSetup();
  return true;
}

/** Open a file in the editor, from the tree, a search hit or the palette's quick open. */
export async function openPath(path) {
  if (!path) return;
  if (!panes.editor) await activate();
  panes.editor?.openFile?.(path);
}

/** Show the Find pane and put the caret in it. Ctrl+Shift+F, and the toolbar. */
export function showFind(query) {
  if ($("#wsBody").dataset.dock !== "on") toggle("dock");
  showDockTab("find");
  if (query) panes.find?.search?.(query);
  panes.find?.focus?.();
}

/** Build or deploy, through the runner when it is there and a plain terminal when it is not. */
async function run(what) {
  const p = project.get();
  if (!p) return;
  if (!$("#wsBody").dataset.dock || $("#wsBody").dataset.dock === "off") toggle("dock");
  showDockTab("build");

  if (panes.runner?.run) { panes.runner.run(what); return; }

  // Deploy reaches hardware, so it asks — every time, whichever path it takes.
  if (what === "deploy" && !confirm(`Deploy ${p.name} to the robot?`)) return;
  const el = $('[data-dock-pane="build"]');
  el.innerHTML = "";
  try {
    const { mountTerminal } = await import("../workspace/terminal.js");
    panes.runner = mountTerminal({ el, kind: "devtools", cwd: p.path, args: ["gradle", "--", what] });
  } catch (e) {
    fallback(el, `Could not start ${what}.`, e);
  }
}

function toggle(which) {
  const body = $("#wsBody");
  const now = body.dataset[which] === "off" ? "on" : "off";
  body.dataset[which] = now;
  settings.set("ws." + which, now);
  const btn = { tree: "#wsTreeBtn", dock: "#wsDockBtn", agent: "#wsAgentBtn" }[which];
  $(btn)?.classList.toggle("cat-btn--primary", now === "on");
  // The editor measures itself; a fold that changes its width has to tell it.
  panes.editor?.layout?.();
}

/** A pane that could not load says what happened, in its own space, and leaves the rest working. */
function fallback(el, what, error) {
  el.innerHTML = `<div style="padding:16px">
      <div class="finding bad">
        <span class="finding__mark">✕</span>
        <div>
          <div class="finding__what">${escapeHtml(what)}</div>
          <div class="finding__detail">${escapeHtml(String(error))}</div>
        </div>
      </div>
    </div>`;
}

function note(text) {
  const el = $("#wsEmpty");
  let line = el.querySelector(".ws-note");
  if (!line) {
    line = document.createElement("p");
    line.className = "hint ws-note";
    el.appendChild(line);
  }
  line.textContent = text;
}
