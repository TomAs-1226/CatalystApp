// The shell: the rail, the router, the title bar, the command palette and the banner.
//
// Views are modules that know nothing about each other. Each exports `init()`, run once the first
// time its view is opened, and optionally `activate(tab)`, run every time. The shell never reaches
// into a view and a view never reaches into the shell — the one thing they share is the open
// project, which travels as a `catalyst:project` event.

import { $, $$, IN_APP, TAURI, appWindow, escapeHtml, invoke, settings, svg } from "./core.js";
import { TOOLS } from "./data.js";
import { stateLayer } from "./motion.js";

const RAIL = [
  ["home", "Home", "home"],
  ["workspace", "Workspace", "workspace"],
  ["tools", "Tools", "tools"],
  ["project", "Project", "project"],
  ["library", "Library", "library"],
  ["tab", "Tablet", "tablet"],
];

const VIEWS = ["home", "workspace", "tools", "project", "library", "tab", "settings", "tool"];

/** The module behind each view, loaded the first time that view is opened. */
const LOADERS = {
  home: () => import("./views/home.js"),
  workspace: () => import("./views/workspace.js"),
  tools: () => import("./views/tools.js"),
  project: () => import("./views/project.js"),
  library: () => import("./views/library.js"),
  tab: () => import("./views/tab.js"),
  settings: () => import("./views/settings.js"),
};

const loaded = new Map();
let current = { view: "home", tab: null };
/* Settings is a mode, so leaving it means going back rather than going somewhere. */
let previous = "home";

/** The project the whole app is currently about, or null. */
let openProject = null;

/** Checks that run before the open project changes or the window closes; see `project.guard`. */
const guards = new Set();

export const project = {
  get: () => openProject,
  /**
   * Set it outright, with no questions asked. For restoring the last session at start-up, where
   * nothing is open yet that could be lost; everything a person does goes through `request`.
   */
  set(p) {
    openProject = p;
    const chip = $("#tbProject");
    if (p) {
      chip.hidden = false;
      // The name is a folder name off the disk, or whatever the registry file says, so it is text.
      chip.innerHTML = `${svg("folder")}<span>${escapeHtml(p.name)}</span>`;
      chip.title = p.path;
    } else {
      chip.hidden = true;
    }
    document.dispatchEvent(new CustomEvent("catalyst:project", { detail: p }));
    if (p) settings.set("openProject", JSON.stringify({ name: p.name, path: p.path }));
    else settings.remove("openProject");
  },
  /**
   * Register a check that runs before the project changes or the app quits.
   *
   * It is called with the project about to be opened (null for none) and `{ quitting }`, and
   * resolves false to stay where things are. The workspace uses it for unsaved files: opening a
   * project throws the editor's buffers away, and so does closing the window.
   *
   * @returns {() => void} unregister
   */
  guard(fn) {
    guards.add(fn);
    return () => guards.delete(fn);
  },
  /** Change the project if every guard agrees. Resolves true when it changed, or needed not to. */
  async request(p) {
    if ((p?.path ?? null) === (openProject?.path ?? null)) {
      if (p) project.set(p);
      return true;
    }
    if (!(await passGuards(p, { quitting: false }))) return false;
    project.set(p);
    return true;
  },
};

async function passGuards(next, reason) {
  for (const check of guards) {
    try {
      if (!(await check(next, reason))) return false;
    } catch (err) {
      console.error(err);
      const why = String(err?.message || err);
      // A guard that throws has not said it is safe to go on, and going on is the step that loses
      // work - so switching project stays put. Quitting asks instead: a broken check that could
      // never be satisfied would otherwise leave a window nobody can close.
      if (!reason?.quitting) {
        banner("Could not check for unsaved work: " + why);
        return false;
      }
      try {
        const choice = await ask({
          title: "Close without checking for unsaved files?",
          body: "Catalyst could not check the editor for unsaved changes: " + why,
          actions: [
            { label: "Stay", value: false, cancel: true, focus: true },
            { label: "Close anyway", value: true },
          ],
        });
        if (!choice) return false;
      } catch (_) {
        return true;
      }
    }
  }
  return true;
}

// ----------------------------------------------------------------- dialog
//
// One question at a time, answered with a button. A second question while one is showing answers
// the first with its way out, because two stacked decisions about the same unsaved files are one
// too many.

let dialogDone = null;

/**
 * Ask, and resolve with the `value` of the button pressed.
 *
 * Escape, and a click on the scrim, choose the action marked `cancel` - the one that changes
 * nothing. Focus starts on the action marked `focus`, or on the way out when none is, so an Enter
 * that was meant for something behind the dialog cannot pick a destructive choice.
 *
 * @param {object}   q
 * @param {string}   q.title
 * @param {string}   [q.eyebrow]
 * @param {string}   [q.body]
 * @param {string[]} [q.list]     lines shown as a list, such as the files a choice affects
 * @param {{label, value, kind?: "primary"|"ghost", cancel?: boolean, focus?: boolean}[]} q.actions
 */
export function ask({ title, eyebrow = "", body = "", list = [], actions }) {
  if (dialogDone) dialogDone(null);
  const root = $("#dialog");
  $("#dialogEyebrow").textContent = eyebrow;
  $("#dialogTitle").textContent = title;
  $("#dialogBody").textContent = body;
  const ul = $("#dialogList");
  ul.innerHTML = "";
  for (const line of list) {
    const li = document.createElement("li");
    li.textContent = line;
    ul.appendChild(li);
  }

  const cancel = actions.find((a) => a.cancel) || actions[0];
  const row = $("#dialogActions");
  row.innerHTML = "";
  const buttons = actions.map((a) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cat-btn" + (a.kind ? ` cat-btn--${a.kind}` : "");
    b.textContent = a.label;
    b.addEventListener("click", () => finish(a.value));
    return [a, b];
  });
  // The way out on the left, apart; everything that does something together on the right.
  const out = buttons.find(([a]) => a === cancel);
  if (out) row.append(out[1]);
  const space = document.createElement("span");
  space.className = "dialog-actions__space";
  row.append(space);
  for (const [a, b] of buttons) if (a !== cancel) row.append(b);

  const before = document.activeElement;
  arrive(root);
  root.hidden = false;
  (buttons.find(([a]) => a.focus) || out || buttons[0])?.[1].focus();

  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); finish(cancel.value); }
    else if (e.key === "Tab") {
      // Focus stays inside while it is open; a modal whose Tab walks out into the page behind it is
      // a modal in appearance only.
      const els = buttons.map(([, b]) => b);
      const i = els.indexOf(document.activeElement);
      e.preventDefault();
      els[(i + (e.shiftKey ? els.length - 1 : 1) + els.length) % els.length].focus();
    }
  };
  const onScrim = (e) => { if (e.target === root) finish(cancel.value); };
  root.addEventListener("keydown", onKey);
  root.addEventListener("click", onScrim);

  let resolve;
  const answered = new Promise((r) => { resolve = r; });
  function finish(value) {
    if (dialogDone !== finish) return;
    dialogDone = null;
    root.removeEventListener("keydown", onKey);
    root.removeEventListener("click", onScrim);
    leave(root, () => { root.hidden = true; });
    if (before && typeof before.focus === "function" && document.contains(before)) before.focus();
    resolve(value === null ? cancel.value : value);
  }
  dialogDone = finish;
  return answered;
}

// ----------------------------------------------------------------- motion
//
// Four things CSS cannot do on its own, and nothing else. Every duration and curve below comes out
// of identity.css as a role; none is written here.

/** A number from an identity token, for the one measurement a mark has to make. */
function token(name, fallback) {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
  return Number.isFinite(v) ? v : fallback;
}

/**
 * Take `el` off the screen the way it came on: mark it, let whatever the stylesheet starts finish,
 * then hide it.
 *
 * `hidden` removes an element from the layout on the same frame, so an exit cannot be a CSS
 * transition alone — something has to hold it there. The wait is on the animations themselves
 * rather than a timer, so it is right under `prefers-reduced-motion` too, where the stylesheet
 * removes the animation and this hides at once instead of waiting out a duration that is not there.
 */
function leave(el, hide) {
  // Each exit carries its own token, so the ceiling timer of an exit that was interrupted cannot end a
  // later one early.
  const token = String((+el.dataset.leaveToken || 0) + 1);
  el.dataset.leaveToken = token;
  el.dataset.leaving = "true";
  // Only animations that end. A spinner inside a leaving view is `infinite`, its `finished` never
  // resolves, and waiting on it would leave the view on screen for good.
  const running = el.getAnimations({ subtree: true }).filter((a) =>
    a.playState === "running" && a.effect?.getComputedTiming?.().endTime !== Infinity);
  const finish = () => {
    // It came back while it was going, or left again since. Whoever did that owns it now.
    if (el.dataset.leaving !== "true" || el.dataset.leaveToken !== token) return;
    delete el.dataset.leaving;
    hide();
  };
  if (!running.length) { finish(); return; }
  Promise.allSettled(running.map((a) => a.finished)).then(finish);
  // And a ceiling, because the longest role is under 800ms: an exit that has not finished by 1.5s is
  // one whose animation stopped being driven - a hidden window, a cancelled effect - and the view
  // still has to go.
  setTimeout(finish, 1500);
}

/** Cancel an exit in progress, because the thing is being shown again. */
function arrive(el) { delete el.dataset.leaving; }

/**
 * One mark for a tab strip, moved rather than redrawn.
 *
 * identity.css draws the selected tab's underline as that tab's own ::after, which is right until
 * you click along the strip: the mark goes out here and comes on there, and nothing connects the
 * two. This puts a single element in the strip and moves it with `settle` — a value travelling to
 * where you just put it. Setting `data-mark` is what tells the stylesheet to stop drawing the
 * per-tab underline, so a strip nobody wired keeps the one it always had.
 *
 * Returns the function that re-measures and moves it. Width is `scaleX` on a 1px element rather
 * than a width, so the travel and the stretch are one composited transform and neither is layout.
 *
 * @param {HTMLElement} strip the tablist
 * @param {{selected?: string, inset?: string}} [opts] `inset` names the token the identity's own
 *   underline is inset by, so the moving mark lands exactly where the drawn one did
 */
export function tabMark(strip, opts = {}) {
  if (!strip) return () => {};
  const selected = opts.selected || '[aria-selected="true"]';
  const inset = opts.inset ? token(opts.inset, 0) : 0;

  let mark = strip.querySelector(":scope > .tab-mark");
  if (!mark) {
    mark = document.createElement("span");
    mark.className = "tab-mark";
    mark.setAttribute("aria-hidden", "true");
    strip.appendChild(mark);
  }
  strip.dataset.mark = "";
  let placed = false;

  return function move(instant) {
    // A strip inside a hidden view measures zero, and a mark placed there would travel out of
    // nowhere the first time the view is opened. Leave it alone until there is something to measure.
    if (!strip.isConnected || !strip.offsetParent) return;
    const on = strip.querySelector(selected);
    if (!on) { mark.dataset.on = "false"; return; }
    const width = Math.max(0, on.offsetWidth - inset * 2);
    if (!width) return;
    const to = `translateX(${on.offsetLeft + inset}px) scaleX(${width})`;
    if (mark.style.transform === to) { mark.dataset.on = "true"; return; }
    // The first placement has nowhere to travel from, and a window being resized is not a choice
    // anyone made about which tab is selected. Neither travels.
    if (instant || !placed) {
      mark.style.transition = "none";
      mark.style.transform = to;
      void mark.offsetWidth;
      mark.style.transition = "";
      placed = true;
    } else {
      mark.style.transform = to;
    }
    mark.dataset.on = "true";
  };
}

/** The movers for the strips this shell owns, run whenever their view is shown. */
const marks = new Map();

function moveMarks(view, instant) {
  for (const [key, move] of marks) if (!view || key === view) move(instant);
}

/**
 * The rail's mark, on the same terms: one element that travels to the section you chose rather than
 * six that take turns being lit. The rail items are all one height, so this is a translate.
 */
let railPlaced = false;

function moveRailMark(instant) {
  const mark = $("#railMark");
  if (!mark) return;
  const item = $(".rail-item.active");
  // A tool is not a section, so nothing on the rail is active while one is open. The mark fades
  // rather than jumping home, and travels from where it was when a section comes back.
  if (!item) { mark.dataset.on = "false"; return; }
  const pad = token("--cat-space-2", 8);
  const height = `${Math.max(0, item.offsetHeight - pad * 2)}px`;
  const to = `translateY(${item.offsetTop + pad}px)`;
  if (mark.style.height !== height) mark.style.height = height;
  if (instant || !railPlaced) {
    mark.style.transition = "none";
    mark.style.transform = to;
    void mark.offsetWidth;
    mark.style.transition = "";
    railPlaced = true;
  } else {
    mark.style.transform = to;
  }
  mark.dataset.on = "true";
}

/*
 * The press answer.
 *
 * One delegated `pointerdown` rather than a handler per control: the rail, the dock's tabs, the
 * palette's rows and every view's buttons are built and rebuilt by different modules, and a wiring
 * pass would miss whatever was drawn after it ran. `pointerdown` and not `click`, because answering
 * at the moment of the press is the whole point — `stateLayer` grows the layer from the point the
 * pointer went down, declines to run under `prefers-reduced-motion`, and removes its own element.
 *
 * Not the tree rows and not the search hits: dense lists clicked along a dozen at a time, which
 * already answer with a background on the `layer` role.
 */
const PRESSED = ".cat-btn, .card-btn, .rail-item, .tb-btn, .tb-project, .mode-rail__item, .cat-tab, .ed-tab";

function wirePress() {
  window.addEventListener("pointerdown", (e) => {
    const hit = e.target instanceof Element ? e.target.closest(PRESSED) : null;
    if (hit && !hit.disabled) stateLayer(hit, e);
  }, { passive: true });
}

// ------------------------------------------------------------------ routing

/** Go somewhere. `where` is "view", "view/tab", or "tool/<id>". */
export async function go(where) {
  const [view, tab] = String(where || "home").split("/");
  if (!VIEWS.includes(view)) return go("home");

  // Settings is a mode: it covers the rail, so it has to be seen stepping aside rather than simply
  // stopping. It is the one view that leaves on `smooth` instead of being switched off.
  const mode = $("#view-settings");
  const modeLeaving = mode && !mode.hidden && view !== "settings";

  $$(".view").forEach((v) => {
    if (v === mode && modeLeaving) return;
    if (v.dataset.view === view) arrive(v);
    v.hidden = v.dataset.view !== view;
  });
  if (modeLeaving) leave(mode, () => { mode.hidden = true; });
  $$(".rail-item").forEach((r) => r.classList.toggle("active", r.dataset.go?.split("/")[0] === view));
  moveRailMark();
  moveMarks(view);

  if (current.view !== "settings" && view === "settings") {
    previous = current.tab ? `${current.view}/${current.tab}` : current.view;
  }
  current = { view, tab: tab || null };
  try { history.replaceState(null, "", "#" + where); } catch (_) { /* file:// has no history */ }
  if (view !== "tool") settings.set("lastView", where);

  if (view === "tool") {
    showTool(tab);
    return;
  }

  const load = LOADERS[view];
  if (!load) return;
  if (!loaded.has(view)) {
    // A view that fails to load says so in its own space. Letting the rejection escape would leave
    // the rail lit on a blank panel, which reads as the app having frozen.
    try {
      const mod = await load();
      loaded.set(view, mod);
      await mod.init?.();
    } catch (err) {
      console.error(err);
      const page = $(`#view-${view} .page`) || $(`#view-${view}`);
      if (page) {
        page.innerHTML = `<div class="notice">This page could not load: ${String(err)}</div>`;
      }
      return;
    }
  }
  const mod = loaded.get(view);
  if (tab) selectTab(view, tab);
  await mod.activate?.(tab || activeTab(view));
}

function showTool(id) {
  const tool = TOOLS.find((t) => t.id === id);
  if (!tool) return go("tools");
  const frame = $("#toolFrame");
  if (frame.dataset.tool !== id) {
    frame.dataset.tool = id;
    frame.src = `tools/${id}/index.html`;
  }
}

/* The tools are separate documents in a frame, so the app's scrollbar styling does not reach them.
 * Rather than edit eleven pages that belong to the library repo, the shell injects the rule. */
function styleToolScrollbars() {
  try {
    const doc = $("#toolFrame").contentDocument;
    if (!doc || doc.getElementById("catalyst-sb")) return;
    const s = doc.createElement("style");
    s.id = "catalyst-sb";
    s.textContent = "*{scrollbar-width:thin;scrollbar-color:rgba(255,255,255,0.16) transparent}"
      + "::-webkit-scrollbar{width:12px;height:12px}::-webkit-scrollbar-track{background:transparent}"
      + "::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.14);border-radius:999px;border:3px solid transparent;background-clip:padding-box;min-height:40px}"
      + "::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,0.26);background-clip:padding-box}";
    doc.head.appendChild(s);
  } catch (_) { /* a frame that will not let us in styles itself */ }
}

// --------------------------------------------------------------------- tabs

function activeTab(view) {
  const tabs = $(`#${view}Tabs`);
  return tabs?.querySelector('[aria-selected="true"]')?.dataset.tab || null;
}

function selectTab(view, tab) {
  const tabs = $(`#${view}Tabs`);
  if (!tabs) return;
  let matched = false;
  $$("[data-tab]", tabs).forEach((b) => {
    const on = b.dataset.tab === tab;
    if (on) matched = true;
    b.setAttribute("aria-selected", String(on));
  });
  if (!matched) return;
  const panels = $(`#view-${view}`);
  $$("[data-panel]", panels).forEach((p) => { p.hidden = p.dataset.panel !== tab; });
  marks.get(view)?.();
}

function wireTabs() {
  document.addEventListener("click", (e) => {
    const tab = e.target.closest('[role="tab"][data-tab]');
    if (!tab) return;
    const view = tab.closest(".view")?.dataset.view;
    if (view) go(`${view}/${tab.dataset.tab}`);
  });

  // The two horizontal tab rows the shell owns. The settings rail is a column of filled pills, not
  // an underlined row, so there is no mark to move there — it is the fill that says which one.
  for (const view of ["project", "library"]) {
    const strip = $(`#${view}Tabs`);
    if (strip) marks.set(view, tabMark(strip, { inset: "--cat-space-2" }));
  }

  // A window that changes size moves every tab under it, and the rail's Settings item with it.
  // Re-measuring is a read, not an animation, and a mark that sprang after every resize frame would
  // be chasing the window rather than marking anything.
  window.addEventListener("resize", () => { moveMarks(null, true); moveRailMark(true); }, { passive: true });
}

// --------------------------------------------------------------------- rail

function buildRail() {
  const rail = $("#rail");
  for (const [id, label, icon] of RAIL) {
    const b = document.createElement("button");
    b.className = "rail-item";
    b.dataset.go = id;
    b.innerHTML = `${svg(icon)}<span>${label}</span>`;
    rail.appendChild(b);
  }
  const spacer = document.createElement("div");
  spacer.className = "rail-spacer";
  rail.appendChild(spacer);

  const settingsBtn = document.createElement("button");
  settingsBtn.className = "rail-item";
  settingsBtn.dataset.go = "settings";
  settingsBtn.innerHTML = `${svg("settings")}<span>Settings</span>`;
  rail.appendChild(settingsBtn);

  // The one crimson mark, for all six places. It is never read out: the item's own `active` class
  // is what carries the state, and this is the picture of it.
  const mark = document.createElement("span");
  mark.className = "rail-mark";
  mark.id = "railMark";
  mark.setAttribute("aria-hidden", "true");
  rail.appendChild(mark);
}

// ---------------------------------------------------------------- titlebar

function wireTitlebar() {
  $("#tbMark").innerHTML = svg("bolt");
  $("#tbMin").innerHTML = svg("min");
  $("#tbMax").innerHTML = svg("max");
  $("#tbClose").innerHTML = svg("close");
  $("#tbMin").onclick = () => appWindow()?.minimize();
  $("#tbMax").onclick = () => appWindow()?.toggleMaximize();
  $("#tbClose").onclick = () => appWindow()?.close();
  // Every way of closing the window - that button, Alt+F4, the taskbar - arrives here as a request,
  // so unsaved work is asked about once rather than at each of them. Tauri destroys the window
  // itself when the handler returns unless the default was prevented, so it always is, and the
  // window is destroyed here once the guards agree.
  //
  // Checked for rather than assumed: this runs during start-up, and a window API that is missing or
  // throws must cost the close guard, not the rest of the boot after it.
  const win = appWindow();
  if (win && typeof win.onCloseRequested === "function") {
    try {
      Promise.resolve(win.onCloseRequested(async (event) => {
        event.preventDefault();
        if (await passGuards(null, { quitting: true })) await win.destroy();
      })).catch((err) => console.error("close guard not installed:", err));
    } catch (err) {
      console.error("close guard not installed:", err);
    }
  }
  $("#tbProject").onclick = () => go("workspace");

  // The settings mode covers the rail, so its own close is the way out.
  const close = $("#settingsClose");
  close.innerHTML = svg("close");
  close.onclick = () => go(previous);

  // The section rail carries an icon each, kept in the markup as a name rather than as inline SVG.
  $$("#settingsTabs [data-icon]").forEach((b) => {
    b.insertAdjacentHTML("afterbegin", svg(b.dataset.icon));
  });

  // Without a native title bar there is no window menu either, so the shortcuts have to be here.
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p" && !e.shiftKey) { e.preventDefault(); openQuickOpen(); }
    if (e.key === "Escape" && !$("#palette").hidden) closePalette();
  });
}

// ------------------------------------------------------------------ banner

/** One line at the top of the window, for something the user did not ask for but needs to know. */
export function banner(text, actions = []) {
  const b = $("#banner");
  // It arrives on `release` from the stylesheet and leaves on `smooth`, back up the way it came in.
  const dismissBanner = () => leave(b, () => { b.hidden = true; });
  b.innerHTML = `<span>${text}</span>`;
  for (const a of actions) {
    const btn = document.createElement("button");
    btn.className = "cat-btn" + (a.primary ? " cat-btn--primary" : "");
    btn.textContent = a.label;
    btn.onclick = () => { a.onClick?.(); dismissBanner(); };
    b.appendChild(btn);
  }
  const dismiss = document.createElement("button");
  dismiss.className = "cat-btn cat-btn--ghost";
  dismiss.innerHTML = svg("close");
  dismiss.onclick = dismissBanner;
  b.appendChild(dismiss);
  arrive(b);
  b.hidden = false;
}

// ----------------------------------------------------------------- palette

/*
 * Ctrl+K.
 *
 * Six rail items is a good number to look at and a bad number to navigate a hundred times a day, so
 * everything the rail reaches — plus every tool and every registered project — is one search away.
 */
let paletteItems = [];
let paletteIndex = 0;
/* The project's file list, fetched once per project. A robot project is a few hundred files, which
   is small enough to filter on every keystroke and far cheaper than asking the disk each time. */
let fileList = { path: null, files: [] };

/** Quick open: Ctrl+P, the files of the open project, matched on the part anyone would type. */
async function openQuickOpen() {
  const p = project.get();
  if (!p || !IN_APP) return openPalette();

  if (fileList.path !== p.path) {
    fileList = { path: p.path, files: [] };
    try {
      const files = await invoke("ws_files", { dir: p.path, max: 4000 });
      fileList.files = files.map((full) => {
        // Both separators, because this is Windows: the backend hands back `C:\…\Robot.java`, and a
        // class that only knows `/` leaves the whole path as the file's name.
        const rel = full.slice(p.path.length).replace(/^[\\/]+/, "");
        const name = rel.split(/[\\/]/).pop();
        return { label: name, detail: rel, kind: "file", icon: "folder", file: full, rel };
      });
    } catch (e) {
      banner("Could not list this project's files: " + e);
      return openPalette();
    }
  }

  paletteItems = fileList.files;
  showPalette("Open a file…");
}

async function openPalette() {
  const list = [
    { label: "Home", kind: "page", go: "home" },
    { label: "Workspace", kind: "page", go: "workspace" },
    { label: "Tools", kind: "page", go: "tools" },
    { label: "Project health", kind: "page", go: "project/doctor" },
    { label: "Vendordeps", kind: "page", go: "project/vendordeps" },
    { label: "Install into a project", kind: "page", go: "library/install" },
    { label: "This release", kind: "page", go: "library/release" },
    { label: "Updates", kind: "page", go: "library/updates" },
    { label: "Catalyst Tab", kind: "page", icon: "tablet", detail: "The tablet, and Catalyst Link on this PC", go: "tab" },
    { label: "Settings", kind: "page", go: "settings/general" },
    { label: "Your projects", kind: "page", go: "settings/projects" },
    { label: "AI agents", kind: "page", go: "settings/agents" },
    { label: "Claude Code setup", kind: "command", icon: "autonomy", detail: "Check what the agent in this project can see", run: "agentSetup" },
    ...TOOLS.map((t) => ({ label: t.name, kind: "tool", icon: t.id, go: `tool/${t.id}` })),
  ];

  if (IN_APP) {
    try {
      const projects = await invoke("list_projects");
      for (const p of projects) {
        list.push({ label: p.name, kind: "project", icon: "folder", detail: p.path, open: p });
      }
    } catch (_) { /* the palette works without them */ }
  }

  paletteItems = list;
  showPalette("Go to a page, a tool or a project…");
}

function showPalette(placeholder) {
  // Ctrl+K while it is on its way out brings it straight back rather than waiting for the exit.
  arrive($("#palette"));
  $("#palette").hidden = false;
  const input = $("#paletteInput");
  input.placeholder = placeholder;
  input.value = "";
  renderPalette("");
  input.focus();
}

/* It goes back the way it came — `smooth`, no bounce, the same path reversed, which is what says
 * this is the same object leaving rather than a different one appearing. The keyboard is not asked
 * to wait for it: Escape hides the input's focus and runs whatever was chosen on the same frame. */
function closePalette() {
  // The caret goes first. While it is leaving the box is a picture — the stylesheet takes its
  // pointer events away — and a focused field inside a picture eats every keystroke behind it.
  $("#paletteInput").blur();
  leave($("#palette"), () => { $("#palette").hidden = true; });
}

function renderPalette(query) {
  const q = query.trim().toLowerCase();
  const hits = paletteItems
    .map((i) => ({ item: i, rank: rankPalette(i, q) }))
    .filter((r) => r.rank >= 0)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 40)
    .map((r) => r.item);
  paletteIndex = 0;
  // Escaped, all of it. Labels and details here are file names and project paths off the disk, and
  // a repository is somebody else's choice of file names: one called `<img src=x onerror=…>.java`
  // would otherwise run in a window that can open a terminal.
  $("#paletteList").innerHTML = hits.map((i, n) => `
    <button class="palette-item" role="option" data-n="${n}" aria-selected="${n === 0}">
      ${svg(i.icon || (i.kind === "page" ? "home" : "folder"))}
      <span>${escapeHtml(i.label)}</span>
      ${i.detail ? `<span class="palette-item__detail">${escapeHtml(i.detail)}</span>` : ""}
      <span class="palette-item__kind">${escapeHtml(i.kind)}</span>
    </button>`).join("");
  $$("#paletteList .palette-item").forEach((el) => {
    el.onclick = () => runPalette(hits[+el.dataset.n]);
  });
}

/** Lower is better; -1 means it does not match at all. */
function rankPalette(item, q) {
  if (!q) return 0;
  const label = item.label.toLowerCase();
  if (label.startsWith(q)) return 0;
  if (label.includes(q)) return 1;
  const detail = String(item.detail || "").toLowerCase();
  if (detail.includes(q)) return 2;
  if (item.kind.includes(q)) return 3;
  return -1;
}

async function runPalette(item) {
  if (!item) return;
  closePalette();
  if (item.file) {
    await go("workspace");
    const mod = await import("./views/workspace.js");
    await mod.openPath(item.file);
    return;
  }
  if (item.open) {
    if (await project.request({ name: item.open.name, path: item.open.path })) await go("workspace");
    return;
  }
  if (item.run === "agentSetup") {
    await openAgentSetup();
    return;
  }
  await go(item.go);
}

/**
 * The Claude pane with its setup strip showing, wherever this was asked for from.
 *
 * With no project open there is no pane to show, so it goes to Settings → AI agents, which says what
 * setup means and how to open a project, rather than to an empty workspace.
 */
export async function openAgentSetup() {
  if (!project.get()) {
    await go("settings/agents");
    return;
  }
  await go("workspace");
  const mod = await import("./views/workspace.js");
  if (!(await mod.showAgentSetup())) await go("settings/agents");
}

function wirePalette() {
  const input = $("#paletteInput");
  input.addEventListener("input", () => renderPalette(input.value));
  input.addEventListener("keydown", (e) => {
    const items = $$("#paletteList .palette-item");
    if (!items.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      paletteIndex = (paletteIndex + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
      items.forEach((el, n) => el.setAttribute("aria-selected", String(n === paletteIndex)));
      items[paletteIndex].scrollIntoView({ block: "nearest" });
    }
    if (e.key === "Enter") {
      e.preventDefault();
      items[paletteIndex]?.click();
    }
  });
  $("#palette").addEventListener("click", (e) => { if (e.target.id === "palette") closePalette(); });
}

// -------------------------------------------------------------------- boot

function initialRoute() {
  const hash = (location.hash || "").slice(1);
  if (hash && VIEWS.includes(hash.split("/")[0])) return hash;
  const startup = settings.get("startup", "home");
  if (startup === "last") return settings.get("lastView", "home");
  if (startup === "workspace") return "workspace";
  return "home";
}

document.addEventListener("click", (e) => {
  const link = e.target.closest("[data-go]");
  if (link) go(link.dataset.go);
});

// A bundled tool asking the shell to go somewhere: Driver Config sends people to the project
// registry to switch writing on, because it cannot switch it on for them. Same origin only, and
// only a route that already exists - a tool page may ask for a view, never invent one.
window.addEventListener("message", (e) => {
  if (e.origin !== location.origin || !e.data || e.data.type !== "catalyst:navigate") return;
  const route = String(e.data.view || "");
  const head = route.split("/")[0];
  if (VIEWS.includes(head)) go(route);
  else if (TOOLS.some((t) => t.id === head)) go(`tool/${head}`);
});

document.addEventListener("DOMContentLoaded", async () => {
  document.body.classList.add("cat-app");
  buildRail();
  wireTitlebar();
  wireTabs();
  wirePalette();
  wirePress();
  $("#toolFrame").addEventListener("load", styleToolScrollbars);

  /*
   * A tool asking to come back.
   *
   * On the docs site a tool's "Catalyst tools" link goes up one folder to the index. In here the
   * tools live at `tools/<id>/index.html` with no index above them, so that link used to land on a
   * blank page with no way out but the rail. The tool now posts a message instead, and this is the
   * only message the shell listens to: it comes from our own frame, it says one word, and it can
   * navigate nowhere except the tools list.
   */
  window.addEventListener("message", (e) => {
    if (e.source !== $("#toolFrame").contentWindow) return;
    if (e.data && e.data.catalyst === "tools") go("tools");
  });

  // Put the last open project back, so reopening the app lands where work was left. The path is
  // only re-checked when the workspace actually opens it — a folder that has since moved should say
  // so there, not fail silently at boot.
  try {
    const saved = JSON.parse(settings.get("openProject", "null"));
    if (saved?.path) project.set(saved);
  } catch (_) { /* nothing was open */ }

  await go(initialRoute());

  // Re-read the project registry once at boot, whether or not anyone opens Settings. `list_projects`
  // re-analyses every project and rewrites the file the MCP server hands to an agent; without this,
  // someone who launches the app and never opens that page leaves the agent reading whatever was
  // true the last time they did.
  if (IN_APP) invoke("list_projects").catch(() => { /* the page reports its own errors when opened */ });

  // The library's update check is quiet and best-effort, and it belongs to the Library view; ask it
  // to run in the background whether or not that view has been opened.
  if (settings.get("updateMode", "ask") !== "manual") {
    import("./views/library.js").then((m) => m.checkQuietly?.()).catch(() => {});
  }
});
