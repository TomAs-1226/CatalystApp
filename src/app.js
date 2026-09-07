// Catalyst desktop shell (native-feel Tauri app).
// Core features (tools + install from the bundled vendordep) work fully offline.
// Update checks and the optional dependency download are best-effort and skip quietly when offline.

import { seasonOf } from "./season.js";
import { cmpVer } from "./version.js";

const TAURI = window.__TAURI__ || null;
const IN_APP = !!TAURI;

const APP_VERSION = "2.0.0";   // this app's version, tracking the library major it installs
const LIB_VERSION = "2.0.0-alpha.1";   // the FrcCatalyst version bundled inside this app
const LIB_FRC_YEAR = "2027";           // the season that version targets

// The feed for the line this build is on. Pointing at the stable vendordep would have meant a
// 2.x app watching the 1.x release line: it would never learn that a new 2.0.0 alpha had shipped,
// and would sit reporting "up to date" for the whole beta.
const LIB_VENDORDEP_URL = "https://tomas-1226.github.io/FrcCatalyst/beta/vendordep/FrcCatalyst.json";

// ---------- icons (Lucide-style line icons) ----------
const ICONS = {
  home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
  builder: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  motors: '<path d="M12.2 2h-.4a2 2 0 0 0-2 2v.2a2 2 0 0 1-1 1.7l-.4.3a2 2 0 0 1-2 0l-.2-.1a2 2 0 0 0-2.7.7l-.2.4a2 2 0 0 0 .7 2.7l.2.1a2 2 0 0 1 1 1.7v.5a2 2 0 0 1-1 1.8l-.2.1a2 2 0 0 0-.7 2.7l.2.4a2 2 0 0 0 2.7.7l.2-.1a2 2 0 0 1 2 0l.4.3a2 2 0 0 1 1 1.7v.2a2 2 0 0 0 2 2h.4a2 2 0 0 0 2-2v-.2a2 2 0 0 1 1-1.7l.4-.3a2 2 0 0 1 2 0l.2.1a2 2 0 0 0 2.7-.7l.2-.4a2 2 0 0 0-.7-2.7l-.2-.1a2 2 0 0 1-1-1.8v-.5a2 2 0 0 1 1-1.7l.2-.1a2 2 0 0 0 .7-2.7l-.2-.4a2 2 0 0 0-2.7-.7l-.2.1a2 2 0 0 1-2 0l-.4-.3a2 2 0 0 1-1-1.7V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  pid: '<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>',
  motion: '<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>',
  wiring: '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>',
  canids: '<line x1="4" x2="20" y1="9" y2="9"/><line x1="4" x2="20" y1="15" y2="15"/><line x1="10" x2="8" y1="3" y2="21"/><line x1="16" x2="14" y1="3" y2="21"/>',
  aiming: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  auto: '<circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/>',
  statemachine: '<rect width="8" height="8" x="3" y="3" rx="2"/><path d="M7 11v4a2 2 0 0 0 2 2h4"/><rect width="8" height="8" x="13" y="13" rx="2"/>',
  install: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
  updates: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  doctor: '<path d="M11 2v3"/><path d="M17 2v3"/><path d="M8 5h12a1 1 0 0 1 1 1v5a7 7 0 0 1-14 0V6a1 1 0 0 1 1-1z"/><path d="M14 18a3 3 0 1 0 6 0v-3"/><circle cx="20" cy="10" r="1.4"/>',
  vendordeps: '<path d="M4 4v16"/><path d="M8 4v16"/><path d="M13 4h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-3z"/><path d="m19.5 5.5 1.6 13.4"/>',
  console: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.2"/><path d="M12 8.8V3"/><path d="m9.2 13.6-4.9 2.9"/><path d="m14.8 13.6 4.9 2.9"/>',
  chev: '<path d="m9 18 6-6-6-6"/>',
  agent: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
  settings: '<path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>',
  star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  reset: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  min: '<line x1="5" x2="19" y1="12" y2="12"/>',
  max: '<rect x="5" y="5" width="14" height="14" rx="1.5"/>',
  close: '<line x1="6" x2="18" y1="6" y2="18"/><line x1="18" x2="6" y1="6" y2="18"/>',
};
const svg = (name) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ""}</svg>`;

const TOOLS = [
  { id: "builder",      name: "Builder",       desc: "Generate ready-to-paste mechanism config code." },
  { id: "motors",       name: "Motors",        desc: "Every MotorType preset + a gear-ratio calculator." },
  { id: "pid",          name: "PID Tuner",     desc: "Tune PID gains against a live response sim." },
  { id: "motion",       name: "Motion Magic",  desc: "Plan Motion Magic velocity / accel profiles." },
  { id: "wiring",       name: "Wiring",        desc: "CAN bus + power wiring reference." },
  { id: "canids",       name: "CAN IDs",       desc: "Lay out CAN IDs and catch conflicts." },
  { id: "aiming",       name: "Aiming",        desc: "Shoot-on-the-move aiming solver." },
  { id: "auto",         name: "Auto",          desc: "Sketch an autonomous routine." },
  { id: "statemachine", name: "State Machine", desc: "Paste your graph and see the states." },
  { id: "history",      name: "Motor History", desc: "Every motor's hours, peaks and past names, pulled off the robot." },
  { id: "autonomy",     name: "Autonomy 2.0",  desc: "Plan the logic, see what will actually run, take the code." },
];

// Vendor libraries Catalyst builds against.
//
// `url` means the 2027 vendordep is published at a stable address and can be fetched. `manual`
// means it is not, and the app says so instead of guessing.
//
// That distinction matters more than it looks. Phoenix 6 and PathPlanner both have 2027 releases,
// but neither publishes a 2027 vendordep JSON at a discoverable URL yet - PathPlanner's canonical
// PathplannerLib.json still reports frcYear 2026. Fetching that into a 2027 project would write a
// file that looks installed and fails at build time, which is a worse outcome than telling someone
// to add it from VS Code's vendor library list, so that is what this does.
//
// PhotonVision is gone entirely: there is no 2027 build, and Catalyst is Limelight-first on
// Systemcore because the pipeline is built into the hardware.
const DEPS = [
  { file: "LimelightLib.json", name: "LimelightLib", url: "https://limelightvision.github.io/limelightlib-public/LimelightLib.json" },
  { name: "Phoenix 6",   manual: "Add from VS Code: Manage Vendor Libraries → Install new libraries (online)" },
  { name: "PathPlanner", manual: "Add from VS Code: Manage Vendor Libraries → Install new libraries (online)" },
];

const ACCENTS = {
  coral: ["e94560", "ff6b81"], blue: ["3b82f6", "60a5fa"],
  green: ["22c55e", "4ade80"], purple: ["8b5cf6", "a78bfa"],
};
const LINKS = [
  ["GitHub", "https://github.com/TomAs-1226/FrcCatalyst"],
  ["Documentation", "https://tomas-1226.github.io/FrcCatalyst/"],
  ["Report an issue", "https://github.com/TomAs-1226/FrcCatalyst/issues"],
];
const CHANGELOG = [
  { v: "2.0.0", t: "WPILib 2027 and Limelight Systemcore", date: "2026-08-23", items: ["Catalyst 2.x targets WPILib 2027 on Systemcore: five CAN buses, Commands v3, the onboard IMU, and a machine that reports its own processor, temperature, storage and flash wear.", "This app installs the 2027 vendordep and bundles the Systemcore-aware tools. It will not install into a 2026 project - keep Catalyst 1.x and the previous app for a roboRIO."] },
  { v: "1.7.0", t: "Physics Core validated in simulation", date: "2026-08-05", items: ["A ground-truth simulator marks Physics Core against the RFC acceptance criteria - fused velocity is now 48% closer to the truth through a slip than raw encoders.", "Building it found three real defects that 300 unit tests had missed. Also adds a guide to measuring your robot, and which measurements actually matter."] },
  { v: "1.6.0", t: "Physics Core, completed", date: "2026-08-05", items: ["A live centre of mass that tracks your elevator, closed-form ballistics, online identification of feedforward gains and battery resistance, fault isolation that names a cause, and capability evaluation before an action is scheduled.", "Learned values are reported, never applied — no method writes a gain. The one limit layer computes caps and applies none of them."] },
  { v: "1.5.0", t: "Physics Core (optional physical-intelligence layer)", date: "2026-08-05", items: ["Fuses wheel odometry and the IMU into one velocity with an honest confidence, scores which wheel is slipping, detects collisions, and predicts the robot's state at shot release.", "Entirely optional and strictly advisory — it writes no pose and changes no setpoint, so existing robot code is untouched."] },
  { v: "1.4.0", t: "Catalyst Desktop (optional companion app)", date: "2026-07-30", items: ["Every Catalyst tool in one native window, one-click install into your robot project, offline auto-update, and an AI-agent connector.", "The desktop app is optional — the library works exactly the same without it."] },
  { v: "1.3.3", t: "LoopMonitor", date: "2026-07-28", items: ["A one-line loop-time monitor that warns when your robot loop runs over the 20 ms budget."] },
  { v: "1.3.2", t: "Field-centric red flip & loop-cost guidance", date: "2026-07-25", items: ["The red-alliance drive flip is now explicit and guaranteed.", "A guide on keeping the loop under 20 ms."] },
  { v: "1.3.1", t: "Audit fixes", date: "2026-07-24", items: ["Nine verified fixes, including two that could crash the robot loop."] },
  { v: "1.3.0", t: "Understandable state machine, servos, live debugging", date: "2026-07-23", items: ["explain() plain-language dump, a ServoMechanism, and live sim status panels."] },
];

let chosenDir = null;

const settings = {
  get: (k, d) => { const v = localStorage.getItem("catalyst." + k); return v === null ? d : v; },
  set: (k, v) => localStorage.setItem("catalyst." + k, v),
  getBool: (k, d) => { const v = localStorage.getItem("catalyst." + k); return v === null ? d : v === "true"; },
};
function applyAccent(name) {
  const a = ACCENTS[name] || ACCENTS.coral;
  document.documentElement.style.setProperty("--coral", "#" + a[0]);
  document.documentElement.style.setProperty("--coral-lt", "#" + a[1]);
}

const $ = (s) => document.querySelector(s);
const invoke = (cmd, args) => TAURI.core.invoke(cmd, args);
const httpGet = async (url) =>
  IN_APP ? TAURI.http.fetch(url, { method: "GET" }) : fetch(url);

// ---------- nav ----------
function navBtn(id, name, ic) {
  const b = document.createElement("button");
  b.className = "nav-item";
  b.dataset.view = id;
  b.innerHTML = `${svg(ic)}<span>${name}</span>`;
  return b;
}
function buildNav() {
  $("#navTop").appendChild(navBtn("home", "Home", "home"));
  const tn = $("#toolNav");
  const hl = $("#homeList");
  for (const t of TOOLS) {
    tn.appendChild(navBtn(t.id, t.name, t.id));
    const r = document.createElement("div");
    r.className = "tool-row";
    r.dataset.view = t.id;
    r.innerHTML = `<div class="tr-ico">${svg(t.id)}</div><div><div class="tr-name">${t.name}</div><div class="tr-desc">${t.desc}</div></div><div class="tr-chev">${svg("chev")}</div>`;
    hl.appendChild(r);
  }
  const nb = $("#navBottom");
  nb.appendChild(navBtn("install", "Install into project", "install"));
  addConsoleEntry(nb, hl);
  nb.appendChild(navBtn("doctor", "Doctor", "doctor"));
  nb.appendChild(navBtn("vendordeps", "Vendordeps", "vendordeps"));
  nb.appendChild(navBtn("agents", "AI Agents", "agent"));
  nb.appendChild(navBtn("whatsnew", "What's New", "star"));
  nb.appendChild(navBtn("updates", "Updates", "updates"));
  nb.appendChild(navBtn("settings", "Settings", "settings"));

  $("#homeInstallBtn").innerHTML = `${svg("install")} Install Catalyst into my robot project`;
  $("#pickBtn").innerHTML = `${svg("install")} Choose robot project folder…`;
  $("#installVer").textContent = "v" + LIB_VERSION;
  $("#appVerMeta").textContent = "Catalyst v" + APP_VERSION;
  $("#libVerMeta").textContent = "Bundled v" + LIB_VERSION;
}

/*
 * Catalyst Console is a separate binary bundled in as a resource, not a tool page, so it gets a nav
 * entry that launches it rather than one that routes to a view.
 *
 * The entry only appears if a console was actually bundled. Catalyst and the console have separate
 * release cadences, so a build made before a console release will not have one, and a button that
 * says "not found" when you press it is worse than no button at all.
 */
async function addConsoleEntry(navBottom, homeList) {
  if (!TAURI) return;
  let available = false;
  try { available = await invoke("console_available"); } catch { return; }
  if (!available) return;

  const launch = async (el) => {
    const previous = el.innerHTML;
    el.style.pointerEvents = "none";
    try {
      await invoke("launch_console");
      // The console takes a moment to put a window up, and a button that looks inert in the meantime
      // reads as broken. It enforces its own single instance, so pressing again is harmless.
      el.innerHTML = previous.replace("Driver Console", "Opening\u2026");
    } catch (e) {
      el.innerHTML = previous.replace("Driver Console", "Could not open");
      console.warn(e);
    }
    setTimeout(() => { el.innerHTML = previous; el.style.pointerEvents = ""; }, 2200);
  };

  const btn = document.createElement("button");
  btn.className = "nav-item";
  btn.innerHTML = `${svg("console")}<span>Driver Console</span>`;
  btn.onclick = () => launch(btn);
  navBottom.appendChild(btn);

  const row = document.createElement("div");
  row.className = "tool-row";
  row.innerHTML = `<div class="tr-ico">${svg("console")}</div><div><div class="tr-name">Driver Console</div>`
    + `<div class="tr-desc">Open the driver station dashboard: live telemetry, tuning, the field in 3D.</div></div>`
    + `<div class="tr-chev">${svg("chev")}</div>`;
  row.onclick = () => launch(row);
  homeList.appendChild(row);
}

function setView(view) {
  document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
  document.querySelectorAll(".nav-item").forEach((n) => n.classList.remove("active"));
  const tool = TOOLS.find((t) => t.id === view);
  if (tool) {
    $("#toolFrame").src = `tools/${tool.id}/index.html`;
    $("#view-tool").classList.remove("hidden");
  } else if (view === "install") {
    $("#view-install").classList.remove("hidden");
    if (!IN_APP) $("#browserNotice").classList.remove("hidden");
  } else if (view === "updates") {
    $("#view-updates").classList.remove("hidden");
  } else if (view === "agents") {
    $("#view-agents").classList.remove("hidden");
    renderAgents();
  } else if (view === "settings") {
    $("#view-settings").classList.remove("hidden");
    renderSettings();
  } else if (view === "whatsnew") {
    $("#view-whatsnew").classList.remove("hidden");
    renderWhatsNew();
  } else if (view === "doctor") {
    $("#view-doctor").classList.remove("hidden");
  } else if (view === "vendordeps") {
    $("#view-vendordeps").classList.remove("hidden");
  } else {
    $("#view-home").classList.remove("hidden");
    renderRecent();
  }
  const btn = document.querySelector(`.nav-item[data-view="${view}"]`);
  if (btn) btn.classList.add("active");
  try { history.replaceState(null, "", "#" + view); } catch (_) {}
  if (["home", "install", "updates", "agents", "settings", "whatsnew"].includes(view)) settings.set("lastView", view);
}
const VIEWS = ["home", "install", "doctor", "vendordeps", "updates", "agents", "settings", "whatsnew"];
function initialView() {
  const h = (location.hash || "").slice(1);
  if (TOOLS.some((t) => t.id === h) || VIEWS.includes(h)) return h;
  if (settings.get("startup", "home") === "last") return settings.get("lastView", "home");
  return "home";
}

// ---------- recent projects ----------
function recentProjects() { try { return JSON.parse(settings.get("recentProjects", "[]")); } catch (_) { return []; } }
function addRecent(dir, name, version) {
  let list = recentProjects().filter((p) => p.path !== dir);
  list.unshift({ path: dir, name: name || dir.split(/[\\/]/).pop(), version });
  settings.set("recentProjects", JSON.stringify(list.slice(0, 6)));
}
function renderRecent() {
  const list = recentProjects();
  $("#recentWrap").classList.toggle("hidden", list.length === 0);
  $("#recentList").innerHTML = list.map((p, i) =>
    `<div class="recent-item" data-recent="${i}"><div class="ri-ico">${svg("folder")}</div><div><div class="ri-name">${p.name}</div><div class="ri-path">${p.path}</div></div><div class="ri-ver">${p.version ? "v" + p.version : ""}</div></div>`
  ).join("");
  $("#recentList").querySelectorAll("[data-recent]").forEach((el) => {
    el.addEventListener("click", async () => {
      const p = recentProjects()[+el.dataset.recent];
      chosenDir = p.path; $("#chosenPath").textContent = p.path;
      setView("install");
      if (IN_APP) await runDetect(p.path);
    });
  });
}

// ---------- settings + what's new ----------
function renderSettings() {
  const sw = $("#swatches");
  const cur = settings.get("accent", "coral");
  sw.innerHTML = Object.entries(ACCENTS).map(([name, a]) =>
    `<div class="swatch${name === cur ? " active" : ""}" data-accent="${name}" style="background:linear-gradient(135deg,#${a[0]},#${a[1]})" title="${name}"></div>`
  ).join("");
  sw.querySelectorAll("[data-accent]").forEach((el) => el.addEventListener("click", () => {
    settings.set("accent", el.dataset.accent); applyAccent(el.dataset.accent); renderSettings();
  }));
  $("#startupSel").value = settings.get("startup", "home");
  $("#startupSel").onchange = (e) => settings.set("startup", e.target.value);
  $("#depsDefault").checked = settings.getBool("includeDeps", true);
  $("#depsDefault").onchange = (e) => { settings.set("includeDeps", e.target.checked); const c = $("#includeDeps"); if (c) c.checked = e.target.checked; };
  $("#aboutApp").textContent = APP_VERSION;
  $("#aboutLib").textContent = LIB_VERSION;
  $("#aboutLinks").innerHTML = LINKS.map(([label, url]) => `<button class="link-btn" data-link="${url}">${svg("external")} ${label}</button>`).join("");
  $("#aboutLinks").querySelectorAll("[data-link]").forEach((el) => el.addEventListener("click", () => openExternal(el.dataset.link)));
  $("#resetBtn").onclick = () => {
    ["accent", "startup", "includeDeps", "updateMode", "lastView"].forEach((k) => localStorage.removeItem("catalyst." + k));
    applyAccent("coral"); renderSettings();
  };
}
function renderWhatsNew() {
  $("#changelog").innerHTML = CHANGELOG.map((c, i) =>
    `<div class="cl-item${i === 0 ? " latest" : ""}"><div class="cl-head"><span class="cl-ver">v${c.v}</span><span class="cl-title">${c.t}</span><span class="cl-date">${c.date}</span></div><ul>${c.items.map((it) => `<li>${it}</li>`).join("")}</ul></div>`
  ).join("");
}
async function openExternal(url) {
  if (IN_APP && TAURI.opener) { try { await TAURI.opener.openUrl(url); return; } catch (_) {} }
  window.open(url, "_blank");
}

// ---------- AI agent connector ----------
const AGENT_CAPS = [
  ["catalyst_motor_specs", "Look up any MotorType's specs (Kraken, Falcon, NEO, Minion…)."],
  ["catalyst_gear_calc", "Output speed and torque through a gear reduction."],
  ["catalyst_build_mechanism", "Generate ready-to-paste Java for a mechanism config."],
  ["catalyst_can_conflicts", "Check a CAN device list for duplicate IDs."],
  ["catalyst_graph_overview", "A map of a codebase: its size, its areas, and what everything hangs off."],
  ["catalyst_graph_search", "Find where something lives, by name, with its file and line."],
  ["catalyst_graph_neighbors", "What a class or method connects to, grouped by relation."],
  ["catalyst_graph_path", "How two things are related: the shortest chain between them."],
  ["catalyst_graph_file", "What a file defines and what it reaches outside itself."],
  ["catalyst_graph_build", "Build a graphify graph for any project. Structural, no LLM, no token cost."],
  ["catalyst_source_search", "Regex across the source with context, once the graph says where to look."],
  ["catalyst_source_read", "Read a file, or just the part around one symbol."],
];
let agentsRendered = false;
async function renderAgents() {
  const caps = $("#agentCaps");
  if (!caps.childElementCount) {
    caps.innerHTML = AGENT_CAPS.map(([n, d]) => `<div class="cap"><span class="cap-name">${n}</span><span class="cap-desc">${d}</span></div>`).join("");
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
    const txt = $("#mcpConfig").textContent;
    try { await navigator.clipboard.writeText(txt); } catch (_) {}
    const b = $("#copyMcp"); b.textContent = "Copied"; b.classList.add("done");
    setTimeout(() => { b.textContent = "Copy"; b.classList.remove("done"); }, 1400);
  });
}

// ---------- window controls ----------
async function appWindow() {
  return IN_APP ? TAURI.window.getCurrentWindow() : null;
}
function wireTitlebar() {
  $("#tbMin").innerHTML = svg("min");
  $("#tbMax").innerHTML = svg("max");
  $("#tbClose").innerHTML = svg("close");
  $("#tbMin").onclick = async () => (await appWindow())?.minimize();
  $("#tbMax").onclick = async () => (await appWindow())?.toggleMaximize();
  $("#tbClose").onclick = async () => (await appWindow())?.close();
}

// ---------- installer ----------
/* ------------------------------------------------------------------------ doctor
 *
 * The install view answers "can I install here". This answers "will it run", which is a different
 * question and a much less obvious one: every check behind it is for something that does not fail
 * at build time.
 *
 * Read-only, deliberately. It would be easy to offer "fix this for me" on the JVM flags, and a tool
 * that edits a team's build.gradle for them is a tool they cannot fully trust afterwards. It shows
 * the lines and lets them paste. */

/* Everything the Doctor renders comes out of a team's own project - file paths, source lines, the
 * contents of build.gradle. That is not hostile input, but it is arbitrary text going into innerHTML,
 * and a stray angle bracket in a source line should render as an angle bracket rather than silently
 * eating the rest of the row. */
function escapeHtml(value) {
  return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
}

/* One finding, in the shape both views report them in: a mark, what was checked, why it matters,
 * and what to do. The vendordeps list reuses this for the problems that belong to the whole folder
 * rather than to any one file. */
function findingRow(f) {
  return `<div class="doc-row ${f.level}">
      <span class="doc-mark">${levelMark(f.level)}</span>
      <div class="doc-body">
        <div class="doc-what">${escapeHtml(f.what)}</div>
        ${f.detail ? `<div class="doc-detail">${escapeHtml(f.detail)}</div>` : ""}
        ${fixBlock(f.fix)}
      </div>
    </div>`;
}

/* The severity glyph, shared with the vendordeps list. There is no colour-only signalling anywhere
 * in either view: every level has its own mark as well. */
const levelMark = (level) => (level === "ok" ? "✓" : level === "warn" ? "▲" : "✕");

/* The fix is shown as a block only when it is something to paste. A one-line instruction reads
 * better as a sentence than as a code block pretending to be a command. */
function fixBlock(fix) {
  if (!fix) return "";
  return fix.includes("\n") || fix.includes("{")
    ? `<pre class="doc-fix">${escapeHtml(fix)}</pre>`
    : `<div class="doc-fix-line">${escapeHtml(fix)}</div>`;
}

let doctorDir = null;

async function pickDoctorFolder() {
  if (!IN_APP) { $("#docBrowserNotice").classList.remove("hidden"); return; }
  const dir = await TAURI.dialog.open({
    directory: true, multiple: false, title: "Choose your robot project folder",
  });
  if (!dir) return;
  doctorDir = dir;
  $("#docPath").textContent = dir;
  await runDoctor(dir);
}

async function runDoctor(dir) {
  const verdict = $("#docVerdict");
  const list = $("#docFindings");
  verdict.classList.remove("hidden");
  verdict.className = "doc-verdict checking";
  verdict.textContent = "Checking…";
  list.innerHTML = "";

  const result = await invoke("diagnose_project", { dir })
      .catch((e) => ({ ready: false, summary: "Could not read the project", findings: [],
                       error: String(e) }));

  verdict.className = `doc-verdict ${result.ready ? "ready" : "blocked"}`;
  verdict.textContent = result.summary;

  list.innerHTML = (result.findings || []).map(findingRow).join("");

  await runMigrationScan(dir);
}

async function runMigrationScan(dir) {
  const panel = $("#docMigrationPanel");
  const list = $("#docMigration");

  const usages = await invoke("scan_migration", { dir }).catch(() => []);
  panel.hidden = usages.length === 0;
  if (!usages.length) return;

  /* Grouped by file, because that is the unit somebody opens. A flat list of forty lines across six
   * files is the same information arranged so nobody can act on it. */
  const byFile = new Map();
  for (const u of usages) {
    if (!byFile.has(u.file)) byFile.set(u.file, []);
    byFile.get(u.file).push(u);
  }

  list.innerHTML = [...byFile.entries()].map(([file, rows]) => `
      <div class="doc-file">
        <div class="doc-file-name">${escapeHtml(file)}<span class="doc-count">${rows.length}</span></div>
        ${rows.map((u) => `
          <div class="doc-usage">
            <span class="doc-line">${u.line}</span>
            <div>
              <div class="doc-rename">
                <code class="old">${escapeHtml(u.oldName)}</code>
                ${u.newName ? `<span class="arrow">→</span><code class="new">${escapeHtml(u.newName)}</code>`
                            : `<span class="arrow">—</span><span class="removed">removed</span>`}
              </div>
              <div class="doc-why">${escapeHtml(u.why)}</div>
              <pre class="doc-code">${escapeHtml(u.text)}</pre>
            </div>
          </div>`).join("")}
      </div>`).join("");
}

async function pickFolder() {
  if (!IN_APP) { $("#browserNotice").classList.remove("hidden"); return; }
  const dir = await TAURI.dialog.open({ directory: true, multiple: false, title: "Choose your robot project folder" });
  if (!dir) return;
  chosenDir = dir;
  $("#chosenPath").textContent = dir;
  await runDetect(dir);
}
async function runDetect(dir) {
  const info = await invoke("detect_project", { dir });
  const line = (ok, t) => `<div class="d-row"><span class="${ok ? "ok" : "bad"}">${ok ? "✓" : "✗"}</span> ${t}</div>`;
  let html = `<div class="d-title">${info.project_name || "Selected folder"}</div>`;
  html += line(info.is_wpilib, info.is_wpilib ? "WPILib / GradleRIO project" : "Does not look like a WPILib project");
  if (!info.is_wpilib && info.reasons.length)
    html += `<div class="d-row" style="color:var(--muted);font-size:12.5px">(${info.reasons.join("; ")})</div>`;
  html += info.has_catalyst
    ? line(true, `FrcCatalyst installed (${info.catalyst_version || "?"} → updating to v${LIB_VERSION})`)
    : line(false, "FrcCatalyst not installed yet");

  // Season mismatch is the failure worth catching here. A 2027 vendordep in a 2026 project writes
  // cleanly, looks installed, and then fails at build with an error that mentions none of this.
  if (info.project_year && seasonOf(info.project_year) !== LIB_FRC_YEAR) {
    html += line(false,
      `This is a ${info.project_year} project and Catalyst ${LIB_VERSION} targets ${LIB_FRC_YEAR}. ` +
      `Import it as a ${LIB_FRC_YEAR} project in WPILib VS Code first — installing into a ` +
      `${info.project_year} project will build against the wrong WPILib.`);
  }
  const el = $("#detectResult");
  el.innerHTML = html; el.classList.remove("hidden");
  $("#installOptions").classList.toggle("hidden", !info.is_wpilib);
  $("#installLog").classList.add("hidden");
}
async function doInstall() {
  const log = $("#installLog"); log.innerHTML = ""; log.classList.remove("hidden");
  const w = (ok, m) => { const d = document.createElement("div"); d.className = ok ? "log-ok" : "log-bad"; d.textContent = (ok ? "✓ " : "✗ ") + m; log.appendChild(d); };
  try {
    const content = await invoke("read_bundled_vendordep");
    w(true, await invoke("write_vendordep", { dir: chosenDir, filename: "FrcCatalyst.json", content }));
  } catch (e) { w(false, "FrcCatalyst: " + e); }
  if ($("#includeDeps").checked) {
    for (const dep of DEPS) {
      if (dep.manual) { w(false, `${dep.name}: no 2027 vendordep is published yet. ${dep.manual}`); continue; }
      try {
        const r = await httpGet(dep.url);
        if (!r.ok) throw new Error("HTTP " + r.status);
        const content = await r.text();
        // Refuse a vendordep meant for another season. Writing one produces a project that looks
        // correctly configured and fails at build with an error that names none of this.
        const year = JSON.parse(content).frcYear;
        if (year && seasonOf(year) !== LIB_FRC_YEAR) {
          throw new Error(`its vendordep reports frcYear ${year}, not ${LIB_FRC_YEAR}`);
        }
        w(true, await invoke("write_vendordep", { dir: chosenDir, filename: dep.file, content }));
      } catch (e) { w(false, `${dep.name}: ${e} — add it from Manage Vendor Libraries instead`); }
    }
  }
  addRecent(chosenDir, null, LIB_VERSION);
  w(true, "Done. Reopen the project in WPILib VS Code and build once while online.");
  await runDetect(chosenDir);
}

// ---------- updates ----------
function getMode() { return localStorage.getItem("catalyst.updateMode") || "ask"; }
function setMode(m) { localStorage.setItem("catalyst.updateMode", m); }

function showBanner(text, actions) {
  const b = $("#updateBanner");
  b.innerHTML = `<span>${text}</span><div class="b-actions"></div>`;
  const act = b.querySelector(".b-actions");
  (actions || []).forEach((a) => { const btn = document.createElement("button"); btn.className = "btn " + (a.primary ? "primary" : ""); btn.textContent = a.label; btn.onclick = a.onClick; act.appendChild(btn); });
  b.classList.remove("hidden");
}

async function checkLib(manual) {
  const st = $("#libUpStatus");
  st.textContent = "Checking…"; st.className = "up-status";
  try {
    const r = await httpGet(LIB_VENDORDEP_URL);
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = JSON.parse(await r.text());
    const latest = j.version;
    if (cmpVer(latest, LIB_VERSION) > 0) {
      st.textContent = `v${latest} available`; st.className = "up-status avail";
      if (getMode() !== "manual" || manual)
        showBanner(`FrcCatalyst v${latest} is available (this app bundles v${LIB_VERSION}).`,
          [{ label: "Install into a project", primary: true, onClick: () => setView("install") }]);
    } else {
      st.textContent = "Up to date"; st.className = "up-status ok";
    }
  } catch (e) {
    st.textContent = "Offline — couldn't check"; st.className = "up-status";
  }
}

async function checkApp(manual) {
  const st = $("#appUpStatus");
  st.textContent = "Checking…"; st.className = "up-status";
  if (!IN_APP || !TAURI.updater) { st.textContent = manual ? "Only available in the app" : "—"; return; }
  try {
    const update = await TAURI.updater.check();
    if (update && update.available) {
      st.textContent = `v${update.version} available`; st.className = "up-status avail";
      const install = async () => { await update.downloadAndInstall(); await TAURI.process?.relaunch?.(); };
      if (getMode() === "auto") { await install(); }
      else showBanner(`Catalyst app v${update.version} is available.`, [{ label: "Update & restart", primary: true, onClick: install }]);
    } else { st.textContent = "Up to date"; st.className = "up-status ok"; }
  } catch (e) {
    st.textContent = "Offline — couldn't check"; st.className = "up-status";
  }
}

// ---------- wire up ----------
document.addEventListener("click", (e) => {
  const nav = e.target.closest("[data-view]");
  if (nav) setView(nav.dataset.view);
});

function injectIframeScrollbar() {
  try {
    const doc = $("#toolFrame").contentDocument;
    if (!doc || doc.getElementById("catalyst-sb")) return;
    const s = doc.createElement("style");
    s.id = "catalyst-sb";
    s.textContent = "*{scrollbar-width:thin;scrollbar-color:rgba(255,255,255,0.16) transparent}::-webkit-scrollbar{width:12px;height:12px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-button{display:none;width:0;height:0}::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.14);border-radius:999px;border:3px solid transparent;background-clip:padding-box;min-height:40px}::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,0.26);background-clip:padding-box}";
    doc.head.appendChild(s);
  } catch (_) {}
}

document.addEventListener("DOMContentLoaded", () => {
  applyAccent(settings.get("accent", "coral"));
  buildNav();
  wireTitlebar();
  setView(initialView());
  $("#includeDeps").checked = settings.getBool("includeDeps", true);
  $("#toolFrame").addEventListener("load", injectIframeScrollbar);
  $("#pickBtn").addEventListener("click", pickFolder);
  $("#docPickBtn").addEventListener("click", pickDoctorFolder);
  $("#installBtn").addEventListener("click", doInstall);
  $("#checkAppBtn").addEventListener("click", () => checkApp(true));
  $("#checkLibBtn").addEventListener("click", () => checkLib(true));
  wireCopy();
  // settings radios
  const mode = getMode();
  document.querySelectorAll('input[name="upmode"]').forEach((r) => {
    r.checked = r.value === mode;
    r.addEventListener("change", () => { if (r.checked) setMode(r.value); });
  });
  // quiet best-effort checks on launch (unless manual-only)
  if (getMode() !== "manual") { checkApp(false); checkLib(false); }
});
