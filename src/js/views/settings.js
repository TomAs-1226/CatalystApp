// Settings, with the project registry and agent access as its other two tabs.
//
// Everything on this page is stored on this machine and nothing is sent anywhere. The three tabs are
// the three kinds of thing that are: preferences in localStorage, the project registry in the app's
// data directory, and the MCP config someone pastes into another agent.

import { $, $$, IN_APP, escapeHtml, invoke, openExternal, pickDirectory, settings } from "../core.js";
import { AGENT_CAPS, APP_VERSION_FALLBACK, LIB_VERSION, LINKS } from "../data.js";
import { go, project } from "../app.js";

/** The pages the app will open itself at. A stored value that is none of them falls back to Home. */
const STARTUP = ["home", "workspace", "last"];

/* Cleared by "Reset all settings". `openProject` is here because a reset that leaves the app still
 * pointed at a project is not a reset; `accent` no longer exists - the identity has one accent and
 * the picker is gone - and it is swept up so an install upgraded from the old app does not keep a
 * dead key for ever. */
const OWN_KEYS = ["accent", "startup", "includeDeps", "updateMode", "lastView"];

export function init() {
  $("#projAddBtn").addEventListener("click", pickProjectFolder);
  wireCopy();
  renderSettings();
  renderAgents();

  /* Refresh the registry when this page first loads, not only when the Projects tab is opened.
   * list_projects re-reads every project and rewrites the file when anything changed, and that file
   * is what the MCP server hands to an AI agent - so a stale one means an agent reading an analysis
   * from whenever somebody last looked. */
  if (IN_APP) renderProjects().catch(() => { /* the tab reports its own errors when opened */ });
}

export function activate(tab) {
  if (tab === "projects") renderProjects();
  else if (tab === "agents") renderAgents();
  else renderSettings();
}

// ------------------------------------------------------------------- general

function renderSettings() {
  const startup = $("#startupSel");
  const stored = settings.get("startup", "home");
  startup.value = STARTUP.includes(stored) ? stored : "home";
  startup.onchange = (e) => settings.set("startup", e.target.value);

  const deps = $("#depsDefault");
  deps.checked = settings.getBool("includeDeps", true);
  deps.onchange = (e) => {
    settings.set("includeDeps", e.target.checked);
    // The install page's own checkbox is in this document whether or not that page has been opened,
    // and leaving it showing the old default would make the setting look like it had not taken.
    const live = $("#includeDeps");
    if (live) live.checked = e.target.checked;
  };

  paintAppVersion();
  $("#aboutLib").textContent = LIB_VERSION;

  // Text buttons: `.cat-btn` has no rule sizing an icon inside it, and an unsized inline SVG in a
  // flex row takes its default 300×150.
  $("#aboutLinks").innerHTML = LINKS.map(([label, url]) =>
    `<button class="cat-btn" data-link="${escapeHtml(url)}">${escapeHtml(label)}</button>`).join("");
  $$("#aboutLinks [data-link]").forEach((el) =>
    el.addEventListener("click", () => openExternal(el.dataset.link)));

  $("#resetBtn").onclick = reset;
}

function reset() {
  OWN_KEYS.forEach((k) => settings.remove(k));
  // Clears the stored project and the title-bar chip in one move, and tells every view that there
  // is no longer a project open.
  project.set(null);

  // The update-mode radios live on the Library page, and one still showing a cleared choice would
  // be lying about what the app will do.
  const ask = document.querySelector('input[name="upmode"][value="ask"]');
  if (ask) ask.checked = true;

  renderSettings();
}

/**
 * Ask the binary what version it is, and put it everywhere this page shows it.
 *
 * Both elements, including the Updates line on the Library page: whichever page is opened first,
 * the other is already right. The value comes from the binary, so two callers cannot disagree.
 */
async function paintAppVersion() {
  let version = APP_VERSION_FALLBACK;
  if (IN_APP) {
    try { version = await invoke("app_version"); } catch (_) { /* fall back to "dev" */ }
  }
  const about = $("#aboutApp");
  if (about) about.textContent = version;
  const meta = $("#appVerMeta");
  if (meta) meta.textContent = "Catalyst v" + version;
}

// ------------------------------------------------------------------ projects

/*
 * The registered projects.
 *
 * These live in a JSON file in the app's data directory rather than in localStorage, because the
 * MCP server is a separate Node process and cannot see localStorage. That file is also the
 * permission boundary for agent writes - see src-tauri/src/projects.rs.
 */
async function renderProjects() {
  const list = $("#projList");
  if (!IN_APP) {
    list.innerHTML = `<p class="hint">Project registration needs the desktop app. You are viewing
      this in a browser preview, where there is no file access and no registry to read.</p>`;
    return;
  }

  let projects = [];
  try {
    projects = await invoke("list_projects");
  } catch (e) {
    list.innerHTML = `<p class="hint">Could not read the registry: ${escapeHtml(String(e))}</p>`;
    return;
  }

  try { $("#projRegPath").textContent = "Registry: " + (await invoke("projects_registry_path")); }
  catch (_) { /* the path is a nicety, not a requirement */ }

  if (!projects.length) {
    list.innerHTML = `<p class="hint">Nothing imported yet. Choose a folder above and it will appear
      here, and become visible to your AI agent.</p>`;
    return;
  }

  list.innerHTML = projects.map(projectRow).join("");

  $$("#projList [data-open]").forEach((el) => el.addEventListener("click", () => {
    // The link between the registry and the workspace: a project imported here is a project the
    // workspace can open, without picking the same folder a second time.
    project.set({ name: el.dataset.openName, path: el.dataset.open });
    go("workspace");
  }));
  $$("#projList [data-write]").forEach((el) => el.addEventListener("change", async () => {
    try { await invoke("set_agent_write", { dir: el.dataset.write, allowed: el.checked }); }
    catch (e) { el.checked = !el.checked; $("#projAddNote").textContent = "Could not change that: " + e; }
  }));
  $$("#projList [data-note]").forEach((el) => el.addEventListener("change", async () => {
    try { await invoke("set_project_note", { dir: el.dataset.note, note: el.value }); }
    catch (e) { $("#projAddNote").textContent = "Could not save the note: " + e; }
  }));
  $$("#projList [data-forget]").forEach((el) => el.addEventListener("click", async () => {
    try { await invoke("forget_project", { dir: el.dataset.forget }); renderProjects(); }
    catch (e) { $("#projAddNote").textContent = "Could not remove that: " + e; }
  }));
}

function projectRow(p) {
  const a = p.analysis || {};
  const path = escapeHtml(p.path);
  const meta = [
    p.catalyst_version ? "Catalyst v" + escapeHtml(p.catalyst_version) : "no Catalyst vendordep",
    p.year ? "WPILib " + escapeHtml(p.year) : null,
    a.kind ? escapeHtml(a.kind) : null,
    a.resolves_from ? "from " + escapeHtml(a.resolves_from) : null,
  ].filter(Boolean).join(" · ");

  // The rest of vendordeps is the project's configuration in one line - it is how you tell a
  // Phoenix-and-PathPlanner robot from a REV one without opening the folder.
  const others = (a.vendordeps || [])
    .filter((v) => v !== "FrcCatalyst.json")
    .map((v) => v.replace(/\.json$/, ""));
  const deps = others.length
    ? `<div class="hint">vendordeps: ${others.map(escapeHtml).join(", ")}</div>`
    : "";
  const notes = (a.notes || []).map((n) => `<div class="hint">${escapeHtml(n)}</div>`).join("");

  return `<div class="cat-kv">
      <div>
        <div class="cat-card__title">${escapeHtml(p.name)}</div>
        <div class="path">${path}</div>
        <div class="hint">${meta}</div>
        ${deps}
        ${notes}
        <input class="cat-field" data-note="${path}" value="${escapeHtml(p.note || "")}"
               placeholder="Note for yourself and for the agent (optional)" />
      </div>
      <!-- Two short lines rather than one long one: the left column's height varies with how much
           there is to say about a project, and a single row of controls wrapped differently on
           every row because of it. -->
      <div class="stack">
        <div class="row">
          <button class="cat-btn" data-open="${path}" data-open-name="${escapeHtml(p.name)}">Open in workspace</button>
          <button class="cat-btn cat-btn--ghost" data-forget="${path}">Remove</button>
        </div>
        <div class="row">
          <span class="hint">Let agents write</span>
          <label class="switch">
            <input type="checkbox" data-write="${path}" ${p.agent_write ? "checked" : ""} />
            <span class="track"></span>
          </label>
        </div>
      </div>
    </div>`;
}

async function pickProjectFolder() {
  const note = $("#projAddNote");
  if (!IN_APP) {
    note.textContent = "Importing a project needs the desktop app's file access.";
    return;
  }
  let dir;
  try { dir = await pickDirectory("Choose your robot project"); }
  catch (e) { note.textContent = "Could not open the picker: " + e; return; }
  if (!dir) return;

  try {
    // Hand the bundled vendordep across so the analysis can say whether this project's install is
    // the one we ship or a modified/locally-built one. Reading it can fail; the analysis copes with
    // null.
    let bundled = null;
    try { bundled = await invoke("read_bundled_vendordep"); } catch (_) { /* analysis degrades */ }
    const p = await invoke("register_project", { dir, name: null, bundledVendordep: bundled });
    note.textContent = `Imported ${p.name}. Writing is off until you switch it on.`;
    renderProjects();
  } catch (e) {
    note.textContent = "Could not import that folder: " + e;
  }
}

// -------------------------------------------------------------------- agents

let agentsRendered = false;

async function renderAgents() {
  const caps = $("#agentCaps");
  if (!caps.childElementCount) {
    caps.innerHTML = AGENT_CAPS.map(([name, desc]) => `
        <div class="cat-kv">
          <div>
            <code>${escapeHtml(name)}</code>
            <div class="hint">${escapeHtml(desc)}</div>
          </div>
        </div>`).join("");
  }
  if (agentsRendered) return;
  agentsRendered = true;

  let serverPath = "<path to>/resources/mcp/server.js";
  let note = "Showing a placeholder path — the real bundled path appears when you run the desktop app.";
  if (IN_APP) {
    try { serverPath = await invoke("mcp_server_path"); note = "Server: " + serverPath; }
    catch (e) { note = "Could not resolve the bundled server path: " + e; }
  }
  const cfg = { mcpServers: { catalyst: { command: "node", args: [serverPath] } } };
  $("#mcpConfig").textContent = JSON.stringify(cfg, null, 2);
  $("#mcpPathNote").textContent = note;
}

function wireCopy() {
  $("#copyMcp").addEventListener("click", async () => {
    const button = $("#copyMcp");
    try {
      await navigator.clipboard.writeText($("#mcpConfig").textContent);
      button.textContent = "Copied";
    } catch (e) {
      // A clipboard the webview refused is worth saying out loud: the config is right there to
      // select by hand, but only if somebody knows the button did nothing.
      button.textContent = "Could not copy";
      $("#mcpPathNote").textContent = "Could not copy to the clipboard: " + e;
    }
    setTimeout(() => { button.textContent = "Copy"; }, 1400);
  });
}
