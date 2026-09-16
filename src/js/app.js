// The shell: the rail, the router, the title bar, the command palette and the banner.
//
// Views are modules that know nothing about each other. Each exports `init()`, run once the first
// time its view is opened, and optionally `activate(tab)`, run every time. The shell never reaches
// into a view and a view never reaches into the shell — the one thing they share is the open
// project, which travels as a `catalyst:project` event.

import { $, $$, IN_APP, TAURI, appWindow, invoke, settings, svg } from "./core.js";
import { TOOLS } from "./data.js";
import { stateLayer } from "./motion.js";

const RAIL = [
  ["home", "Home", "home"],
  ["workspace", "Workspace", "workspace"],
  ["tools", "Tools", "tools"],
  ["project", "Project", "project"],
  ["library", "Library", "library"],
];

const VIEWS = ["home", "workspace", "tools", "project", "library", "settings", "tool"];

/** The module behind each view, loaded the first time that view is opened. */
const LOADERS = {
  home: () => import("./views/home.js"),
  workspace: () => import("./views/workspace.js"),
  tools: () => import("./views/tools.js"),
  project: () => import("./views/project.js"),
  library: () => import("./views/library.js"),
  settings: () => import("./views/settings.js"),
};

const loaded = new Map();
let current = { view: "home", tab: null };
/* Settings is a mode, so leaving it means going back rather than going somewhere. */
let previous = "home";

/** The project the whole app is currently about, or null. */
let openProject = null;

export const project = {
  get: () => openProject,
  /** Set from anywhere: the workspace, the Projects tab, a recent-project card. */
  set(p) {
    openProject = p;
    const chip = $("#tbProject");
    if (p) {
      chip.hidden = false;
      chip.innerHTML = `${svg("folder")}<span>${p.name}</span>`;
      chip.title = p.path;
    } else {
      chip.hidden = true;
    }
    document.dispatchEvent(new CustomEvent("catalyst:project", { detail: p }));
    if (p) settings.set("openProject", JSON.stringify({ name: p.name, path: p.path }));
    else settings.remove("openProject");
  },
};

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
  el.dataset.leaving = "true";
  const running = el.getAnimations({ subtree: true }).filter((a) => a.playState === "running");
  const finish = () => {
    // It came back while it was going. Whoever brought it back owns it now.
    if (el.dataset.leaving !== "true") return;
    delete el.dataset.leaving;
    hide();
  };
  if (!running.length) { finish(); return; }
  Promise.allSettled(running.map((a) => a.finished)).then(finish);
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
        const rel = full.slice(p.path.length).replace(/^[\/]+/, "");
        const name = rel.split(/[\/]/).pop();
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
    { label: "Settings", kind: "page", go: "settings/general" },
    { label: "Your projects", kind: "page", go: "settings/projects" },
    { label: "AI agents", kind: "page", go: "settings/agents" },
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
  $("#paletteList").innerHTML = hits.map((i, n) => `
    <button class="palette-item" role="option" data-n="${n}" aria-selected="${n === 0}">
      ${svg(i.icon || (i.kind === "page" ? "home" : "folder"))}
      <span>${i.label}</span>
      ${i.detail ? `<span class="palette-item__detail">${i.detail}</span>` : ""}
      <span class="palette-item__kind">${i.kind}</span>
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
    project.set({ name: item.open.name, path: item.open.path });
    await go("workspace");
    return;
  }
  await go(item.go);
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
