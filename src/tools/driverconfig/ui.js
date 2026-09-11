// Driver Config: the page. State, undo, drafts, and the six sheets. The pure pieces - the format,
// the checks, the Java - live in model.js and codegen.js, where the tests can reach them.

import {
  BUILTIN_ACTIONS, BUILTIN_EVENTS, CHANNELS, CONTROLLER_TYPES, CONTROLS, CURVES, LIBRARY, RUMBLE_PATTERNS,
  STATIC_EVENTS, WHEN,
} from "./catalog.js";
import {
  DRIVE_ROLES, JAVA_IDENT, JAVA_KEYWORDS, ROLE, addProfile, axisName, blankConfig, buttonName, capsFor, changes,
  clone, defaultAxis, deleteProfile, describe, duplicateProfile, inputKey, inputLabel, inputsFor, isMeasured,
  javaPath, layoutOf, newProfile, normalize, pct, renameProfile, roleLabel, sampleConfig, serializeConfig,
  setDefaultProfile, validate,
} from "./model.js";
import { readJava } from "./codegen.js";
import { bindingsFromCode, codeCollisions, scanProject } from "./project.js";
import { curveSvg, patternStrip, playPattern, robotButtonFor, startLive } from "./live.js";
import { openApply, wiringSnippet } from "./apply.js";

const TAURI = (() => { try { return window.parent && window.parent.__TAURI__ ? window.parent.__TAURI__ : (window.__TAURI__ || null); } catch { return null; } })();
const IN_APP = !!(TAURI && TAURI.core);
const invoke = (cmd, args) => TAURI.core.invoke(cmd, args);
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
const store = {
  get(k) { try { return localStorage.getItem("catalyst.driverconfig." + k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem("catalyst.driverconfig." + k, v); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem("catalyst.driverconfig." + k); } catch { /* private mode */ } },
};

const S = {
  projects: [],
  project: null,
  sources: null,
  scan: null,
  config: sampleConfig(),
  baseline: sampleConfig(),
  origin: "the sample",
  sel: { profile: "X1", tab: "sticks", axis: 0 },
  undo: [],
  redo: [],
  notices: [],
  listening: false,
  down: new Set(),
};

// ------------------------------------------------------------------ state

const prof = () => S.config.profiles.find((p) => p.name === S.sel.profile) || S.config.profiles[0];
const lay = () => layoutOf(S.config, prof().controller.type);

function draftKey() { return "draft." + (S.project ? S.project.path : "sample"); }
function saveDraft() {
  if (serializeConfig(S.config) === serializeConfig(S.baseline)) { store.del(draftKey()); return; }
  store.set(draftKey(), JSON.stringify({ config: serializeConfig(S.config), baseline: serializeConfig(S.baseline), at: Date.now() }));
}

/** Every edit goes through here, so every edit can be undone. */
function commit(label, mutate) {
  const before = serializeConfig(S.config);
  const next = clone(S.config);
  mutate(next);
  const after = serializeConfig(next);
  if (after === before) { render(); return; }
  S.undo.push({ label, snap: before });
  if (S.undo.length > 300) S.undo.shift();
  S.redo = [];
  S.config = normalize(JSON.parse(after));
  if (!S.config.profiles.some((p) => p.name === S.sel.profile)) S.sel.profile = S.config.defaultProfile;
  saveDraft();
  render();
}

function undoRedo(from, to) {
  const u = from.pop();
  if (!u) return;
  to.push({ label: u.label, snap: serializeConfig(S.config) });
  S.config = normalize(JSON.parse(u.snap));
  if (!S.config.profiles.some((p) => p.name === S.sel.profile)) S.sel.profile = S.config.defaultProfile;
  saveDraft();
  render();
}

function setBaseline(config, origin) {
  S.config = normalize(config);
  S.baseline = clone(S.config);
  S.origin = origin;
  S.undo = [];
  S.redo = [];
  S.sel.profile = S.config.defaultProfile;
  S.sel.axis = 0;
}

// ------------------------------------------------------------------ loading a project

async function loadProjects() {
  if (!IN_APP) return;
  try { S.projects = await invoke("list_projects"); } catch (e) { S.projects = []; note("warn", `Could not read your projects: ${esc(String(e))}`); }
}

/** What a feel-constants block says, read loosely: literals, or a constant the same file defines. */
function feelFromBlock(text) {
  const val = (name) => { const m = new RegExp(`\\b${name}\\s*=\\s*([^;]+);`).exec(text); return m ? m[1].trim() : null; };
  const num = (expr) => {
    if (expr == null) return null;
    if (/^-?\d+(\.\d+)?$/.test(expr)) return Number(expr);
    const id = expr.split(".").pop();
    const m = new RegExp(`\\b${id}\\s*=\\s*(-?\\d+(?:\\.\\d+)?)\\s*;`).exec(text);
    return m ? Number(m[1]) : null;
  };
  const curveJava = (val("DEFAULT_CURVE") || "").split(".").pop();
  return {
    deadband: num(val("DEADBAND")), max: num(val("MAX_SPEED")),
    curve: Object.keys(CURVES).find((k) => CURVES[k].java === curveJava) || null,
    slow: num(val("SLOW_MODE")) ?? num(val("SLOW_MODE_FACTOR")),
  };
}

/** A first config for a project with no Driver Config yet: read from its own code. */
function configFromCode(scan) {
  const c = blankConfig({ package: scan.robot ? scan.robot.pkg : "frc.robot", robotClass: scan.robot ? scan.robot.name : null, swerveField: scan.swerveField });
  const p = c.profiles[0];
  p.name = "Driver 1";
  c.defaultProfile = "Driver 1";
  if (scan.controllers[0] && Number.isInteger(scan.controllers[0].port)) p.controller.port = scan.controllers[0].port;
  // A project that says it drives with a DualSense gets the measured DualSense map. Its numbers are
  // the same gamepad layout either way; the names and the measured marks are what change.
  if (S.sources.some((f) => /DualSense|\bPS5\b/.test(f.text))) p.controller.type = "dualsense";
  p.bindings = bindingsFromCode(scan).imported;
  // Read the feel out of a Driving-style block, but do not start owning it: that needs the team's
  // two marker lines, and the target bar offers it.
  const block = scan.constantsBlocks[0];
  if (block) {
    const src = S.sources.find((f) => f.path === block.path);
    const feel = src ? feelFromBlock(src.text) : {};
    for (const a of p.axes) {
      if (feel.deadband != null) a.deadband = feel.deadband;
      if (feel.curve) a.curve = feel.curve;
      a.scale = 1;
    }
    if (feel.max != null) p.speed.max = feel.max;
    if (feel.slow != null) p.speed.slow = feel.slow;
    p.speed.turbo = 1;
  }
  return normalize(c);
}

async function loadProject(path) {
  S.notices = [];
  S.project = S.projects.find((p) => p.path === path) || null;
  if (!S.project) { loadSample(); return; }
  store.set("project", path);
  render();
  try {
    S.sources = await invoke("project_java_sources", { dir: S.project.path });
  } catch (e) {
    S.sources = [];
    note("warn", `Could not read ${esc(S.project.name)}'s code: ${esc(String(e))}`);
  }
  S.scan = scanProject(S.sources, { className: "DriverConfig" });
  let read = null;
  let from = "";
  const generated = S.scan.generated[0];
  if (S.scan.generated.length > 1) note("warn", `Found ${S.scan.generated.length} files with Driver Config regions; reading ${esc(generated)}.`);
  if (generated) { read = readJava(S.sources.find((f) => f.path === generated).text); from = generated; }
  if (!read || !read.config) {
    const marked = S.scan.constantsBlocks.find((b) => b.marked);
    if (marked) { read = readJava(S.sources.find((f) => f.path === marked.path).text); from = marked.path; }
  }
  if (read && read.config) {
    setBaseline(read.config, from.split("/").pop());
    if (read.handEdited) note("warn", `${esc(from)} was edited by hand inside its generated region. Applying replaces those edits; the preview shows them first.`);
    for (const pr of read.problems || []) note("warn", esc(pr));
  } else {
    const c = configFromCode(S.scan);
    setBaseline(c, "your code");
    const n = c.profiles[0].bindings.length;
    const file = S.scan.robot ? S.scan.robot.path.split("/").pop() : "your code";
    const block = S.scan.constantsBlocks[0];
    note("info", `No Driver Config in ${esc(S.project.name)} yet. This starting point was read from ${esc(file)}: ${n} button${n === 1 ? "" : "s"} it binds to a single call${block ? `, and the feel from ${esc(block.className)}` : ""}. Nothing is written until you Apply.`,
      [...(S.scan.robot && S.scan.robot.name === "X1" ? [["start-sample", "Use the X1 sample instead"]] : []), ["start-blank", "Start blank"]]);
  }
  restoreDraft();
  render();
}

function loadSample() {
  S.project = null;
  S.sources = null;
  S.scan = null;
  setBaseline(sampleConfig(), "the sample");
  S.notices = [];
  note("info", IN_APP
    ? (S.projects.length ? "Showing the Catalyst X1 sample. Pick a project above to edit its own setup." : "Showing the Catalyst X1 sample. Import your robot project on the Projects page to apply a setup to it.")
    : "Browser preview: the X1 sample, the live controller and every check work here. Writing into a project needs the desktop app.",
  IN_APP && !S.projects.length ? [["open-projects", "Open Projects"]] : []);
  restoreDraft();
  render();
}

function restoreDraft() {
  let d = null;
  try { d = JSON.parse(store.get(draftKey())); } catch { d = null; }
  if (!d || !d.config) return;
  const sameBase = d.baseline === serializeConfig(S.baseline);
  if (d.config === serializeConfig(S.baseline)) return;
  const when = new Date(d.at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  if (sameBase) {
    S.config = normalize(JSON.parse(d.config));
    note("info", `Restored the edits you had not applied (${esc(when)}).`, [["discard-draft", "Discard them"]]);
  } else {
    S.pendingDraft = d.config;
    note("warn", `You had edits from ${esc(when)} that were made against an older version of this file.`, [["restore-draft", "Restore them anyway"], ["discard-draft", "Discard them"]]);
  }
}

function note(kind, html, actions = []) { S.notices.push({ kind, html, actions }); }

// ------------------------------------------------------------------ rendering

const findings = () => validate(S.config, S.scan);

/** Rev 1 beside Rev 2, when a value differs from what the project (or the sample) has. */
function rev(key) {
  const a = S.baseFacts.get(key);
  const b = S.facts.get(key);
  if (!b || (a && a.value === b.value)) return "";
  return `<span class="rev" title="was ${esc(a ? a.value : "not set")}">${a ? `<span class="rev-1">${esc(a.value)}</span>` : "<span class=\"cap\">new</span>"}<span class="rev-2">${esc(b.value)}</span></span>`;
}

function render() {
  const keep = document.activeElement && document.activeElement.dataset ? { ...document.activeElement.dataset } : null;
  S.facts = describe(S.config);
  S.baseFacts = describe(S.baseline);
  const all = findings();
  renderHead(all);
  renderTarget();
  renderNotices();
  renderProfiles();
  renderTabs(all);
  renderSheet();
  renderChecks(all);
  if (S.live) S.live.rebuild();
  if (keep && keep.act) {
    const sel = Object.entries(keep).map(([k, v]) => `[data-${k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase())}="${CSS.escape(v)}"]`).join("");
    const el = sel ? document.querySelector(sel) : null;
    if (el && el.focus) el.focus();
  }
}

function renderHead(all) {
  const sel = $("#projSel");
  const opts = S.projects.map((p) => `<option value="${esc(p.path)}"${S.project && S.project.path === p.path ? " selected" : ""}>${esc(p.name)}</option>`);
  opts.push(`<option value=""${S.project ? "" : " selected"}>Sample: Catalyst X1 (no project)</option>`);
  sel.innerHTML = opts.join("");
  $("#projWrite").innerHTML = !S.project ? "" : S.project.agent_write
    ? "<span class=\"proven\" title=\"This project lets Catalyst write into it (Projects page)\">writing on</span>"
    : "<span class=\"attempted\" title=\"Switch on 'Let agents write' for this project on the Projects page\">writing off</span>";
  const u = S.undo[S.undo.length - 1];
  const r = S.redo[S.redo.length - 1];
  $("#undoBtn").disabled = !u;
  $("#undoBtn").title = u ? `Undo: ${u.label} (Ctrl+Z)` : "Nothing to undo";
  $("#redoBtn").disabled = !r;
  $("#redoBtn").title = r ? `Redo: ${r.label} (Ctrl+Shift+Z)` : "Nothing to redo";
  const e = all.filter((f) => f.level === "error").length;
  $("#applyBtn").title = e ? `${e} problem${e === 1 ? "" : "s"} to fix first - see Checks` : "Preview the change, then write it";
}

function renderTarget() {
  const t = S.config.target;
  const scan = S.scan;
  const cls = scan && scan.generated[0] ? scan.generated[0] : javaPath(S.config);
  const blocks = scan ? scan.constantsBlocks : [];
  const blk = t.constants && blocks.find((b) => b.path === t.constants.path && b.className === t.constants.className);
  const robots = scan ? scan.candidates.map((c) => c.name) : (t.robotClass ? [t.robotClass] : []);
  if (t.robotClass && !robots.includes(t.robotClass)) robots.unshift(t.robotClass);
  const nChanged = changes(S.baseline, S.config).length;
  $("#targetBar").innerHTML = `
    <span class="lbl">Writes</span>
    <label class="inv"><input type="checkbox" data-act="toggle-classfile" ${t.classFile ? "checked" : ""}> <span class="path mono">${esc(cls)}</span></label>
    ${t.constants ? `<label class="inv"><input type="checkbox" data-act="toggle-constants" checked> <span class="path mono">${esc(t.constants.className)} in ${esc(t.constants.path.split("/").pop())}</span>
        ${scan ? (blk && blk.marked ? "<span class=\"proven\">markers in place</span>" : "<span class=\"attempted\">needs 2 marker lines</span>") : ""}</label>`
      : blocks.length ? `<button class="btn tiny" data-act="add-constants" data-path="${esc(blocks[0].path)}" data-class="${esc(blocks[0].className)}">Also own ${esc(blocks[0].className)} in ${esc(blocks[0].path.split("/").pop())}</button>` : ""}
    <span class="lbl">Robot class</span>
    <select class="sel-in" data-act="robot-class">${robots.map((r) => `<option${r === t.robotClass ? " selected" : ""}>${esc(r)}</option>`).join("")}<option value=""${t.robotClass ? "" : " selected"}>none</option></select>
    <span class="cap" style="margin-left:auto">${nChanged ? `${nChanged} change${nChanged === 1 ? "" : "s"} not applied` : `matches ${esc(S.origin)}`} · Catalyst ${LIBRARY.version}</span>`;
}

function renderNotices() {
  $("#notices").innerHTML = S.notices.map((n, i) => `<div class="dc-note ${n.kind === "warn" ? "warn" : ""}">${n.html}
    ${n.actions.length ? `<div class="row-btns">${n.actions.map(([act, label]) => `<button class="btn tiny" data-act="${act}" data-i="${i}">${esc(label)}</button>`).join("")}</div>` : ""}</div>`).join("");
}

function renderProfiles() {
  const chips = S.config.profiles.map((p) => `<button class="chip" data-act="pick-profile" data-name="${esc(p.name)}" aria-pressed="${p.name === prof().name}">${esc(p.name)}${p.name === S.config.defaultProfile ? " <span class=\"def\">DEFAULT</span>" : ""}</button>`).join("");
  $("#profiles").innerHTML = `<span class="lbl" style="margin-right:4px">Profiles</span>${chips}<span class="sep"></span>
    <button class="btn tiny" data-act="profile-new">New</button>
    <button class="btn tiny" data-act="profile-dup">Duplicate</button>
    <button class="btn tiny" data-act="profile-rename">Rename</button>
    <button class="btn tiny" data-act="profile-default" ${prof().name === S.config.defaultProfile ? "disabled" : ""}>Make default</button>
    <button class="btn tiny danger" data-act="profile-delete" ${S.config.profiles.length < 2 ? "disabled" : ""}>Delete</button>`;
}

const TABS = [["controller", "Controller"], ["sticks", "Sticks"], ["speed", "Speed"], ["buttons", "Buttons"], ["rumble", "Rumble"], ["changes", "Changes"]];

function renderTabs(all) {
  const mine = all.filter((f) => !f.where.profile || f.where.profile === prof().name);
  $("#tabs").innerHTML = TABS.map(([id, label]) => {
    const e = mine.filter((f) => f.where.tab === id && f.level === "error").length;
    const w = mine.filter((f) => f.where.tab === id && f.level === "warn").length;
    const n = id === "changes" ? changes(S.baseline, S.config).length : 0;
    return `<button class="tab" role="tab" data-act="tab" data-tab="${id}" aria-selected="${S.sel.tab === id}">${label}${e ? `<span class="n e">&#x2715;${e}</span>` : ""}${w ? `<span class="n w">&#x25B2;${w}</span>` : ""}${n ? `<span class="n">${n}</span>` : ""}</button>`;
  }).join("");
}

function renderChecks(all) {
  const errs = all.filter((f) => f.level === "error");
  const warns = all.filter((f) => f.level === "warn");
  const row = (f) => `<div class="find ${f.level}"><span class="g">${f.level === "error" ? "&#x2715;" : "&#x25B2;"}</span><div>${esc(f.message)}
    ${f.where.tab ? ` <button data-act="goto" data-tab="${esc(f.where.tab)}" data-name="${esc(f.where.profile || "")}">Show</button>` : ""}</div></div>`;
  $("#checks").innerHTML = `<div class="side-h"><span class="lbl">Checks</span><span class="cap">${errs.length} to fix · ${warns.length} to read</span></div>
    ${all.length ? `<div class="finds">${[...errs, ...warns].map(row).join("")}</div>`
      : "<p class=\"small\" style=\"margin:0\"><span class=\"proven\">Nothing to fix</span></p>"}
    ${errs.length ? "<p class=\"cap\" style=\"margin-top:8px\">Apply stays shut until the &#x2715; items are fixed: each one would make the robot do something nobody asked for.</p>" : ""}`;
}

function renderSheet() {
  const f = { controller: sheetController, sticks: sheetSticks, speed: sheetSpeed, buttons: sheetButtons, rumble: sheetRumble, changes: sheetChanges }[S.sel.tab] || sheetSticks;
  $("#sheet").innerHTML = f();
}

// --- controller ------------------------------------------------------------------------------

function sheetController() {
  const p = prof();
  const l = lay();
  const axisControls = Object.keys(CONTROLS).filter((k) => CONTROLS[k].kind === "axis");
  const buttonControls = Object.keys(CONTROLS).filter((k) => CONTROLS[k].kind === "button");
  const status = (kind, i) => {
    const m = isMeasured(l, kind, i);
    const fixed = kind === "axis" ? CONTROLLER_TYPES[l.id].measured.axes.includes(i) : CONTROLLER_TYPES[l.id].measured.buttons.includes(i);
    return `<label class="inv" title="${fixed ? "Measured on the Catalyst X1" : "Tick once you have seen this number move on the Driver Station"}"><input type="checkbox" data-act="map-measured" data-kind="${kind}" data-i="${i}" ${m ? "checked" : ""} ${fixed ? "disabled" : ""}><span class="${m ? "proven" : "attempted"}">${m ? "measured" : "assumed"}</span></label>`;
  };
  const option = (ids, current) => `<option value="">not identified</option>` + ids.map((k) => `<option value="${k}"${k === current ? " selected" : ""}>${esc(l.names[k] || CONTROLS[k].label)}</option>`).join("");
  return `<h2>Controller</h2>
    <div class="kv">
      <span class="lbl">Type</span><span><select class="sel-in" data-act="ctl-type">${Object.entries(CONTROLLER_TYPES).map(([id, t]) => `<option value="${id}"${id === p.controller.type ? " selected" : ""}>${esc(t.label)}</option>`).join("")}</select>${rev(`p:${p.name}:controller`)}</span>
      <span class="lbl">Driver Station port</span><span><select class="sel-in" data-act="ctl-port">${[0, 1, 2, 3, 4, 5].map((n) => `<option${n === p.controller.port ? " selected" : ""}>${n}</option>`).join("")}</select></span>
    </div>
    <p class="small" style="margin-top:12px">${esc(l.about)}</p>
    <p class="cap">Layout: ${esc(l.source)}. Rumble: ${l.rumble === "yes" ? "yes" : l.rumble === "no" ? "none - it has no motors" : "not measured through the 2027 Driver Station"}.</p>
    <h2>Which number is which control</h2>
    <p class="small">The robot reads raw numbers, not stick names. This table is the only thing that links the two. <b>Numbers start at 0</b>: they are the n in <span class="mono">getRawAxis(n)</span> and <span class="mono">button(n)</span>, which WPILib 2027 counts from 0 (through 2026, buttons counted from 1).
      To check one, open the Driver Station's USB tab beside this window, move a single control, and see which number moves; then tick it.</p>
    <div class="tb-wrap"><table class="tb">
      <tr><th>Robot axis</th><th>Is</th><th>Status</th></tr>
      ${l.axes.map((id, i) => `<tr><td class="mono">${i}</td><td><select class="sel-in" data-act="map-axis" data-i="${i}">${option(axisControls, id)}</select></td><td>${status("axis", i)}</td></tr>`).join("")}
    </table></div>
    <details style="margin-top:12px"><summary class="lbl" style="cursor:default">Buttons (${l.buttons.length}, numbered 0 to ${l.buttons.length - 1})</summary>
      <div class="tb-wrap" style="margin-top:8px"><table class="tb">
        <tr><th>Robot button</th><th>Is</th><th>Status</th></tr>
        ${l.buttons.map((id, i) => `<tr><td class="mono">${i}</td><td><select class="sel-in" data-act="map-button" data-i="${i}">${option(buttonControls, id)}</select></td><td>${status("button", i)}</td></tr>`).join("")}
      </table></div></details>`;
}

// --- sticks ----------------------------------------------------------------------------------

function axisOptions(l, current) {
  const opts = l.axes.map((id, i) => `<option value="${i}"${i === current ? " selected" : ""}>${i} · ${esc(axisName(l, i) || "not identified")}${isMeasured(l, "axis", i) ? " - measured" : ""}</option>`);
  if (!(current >= 0 && current < l.axes.length)) opts.push(`<option value="${current}" selected>${current} · not reported by this pad</option>`);
  return opts.join("");
}

function sheetSticks() {
  const p = prof();
  const l = lay();
  const i = Math.min(S.sel.axis, p.axes.length - 1);
  const a = p.axes[i];
  const K = (role, f) => `p:${p.name}:${role}:${f}`;
  const rows = p.axes.map((x, k) => `<tr class="${k === i ? "sel" : ""}" data-act="axis-select" data-i="${k}">
      <td><b style="font-weight:600;color:var(--cat-white)">${esc(roleLabel(x.role))}</b><div class="cap">${esc(ROLE[x.role] ? ROLE[x.role].about : "an extra axis: axis(\"" + x.role + "\")")}</div></td>
      <td><select class="sel-in" data-act="axis-index" data-i="${k}">${axisOptions(l, x.axis)}</select>${rev(K(x.role, "axis"))}</td>
      <td><label class="inv"><span class="switch"><input type="checkbox" data-act="axis-invert" data-i="${k}" ${x.invert ? "checked" : ""}><span class="track"></span></span><b>${x.invert ? "INVERTED" : "AS IS"}</b></label>${rev(K(x.role, "invert"))}</td>
      <td><input class="num" type="number" step="0.01" min="0.01" max="0.5" data-act="axis-deadband" data-i="${k}" value="${x.deadband}">${rev(K(x.role, "deadband"))}</td>
      <td><div class="seg">${Object.entries(CURVES).map(([id, c]) => `<button data-act="axis-curve" data-i="${k}" data-v="${id}" aria-pressed="${x.curve === id}" title="${esc(c.about)}">${esc(c.label.toUpperCase())}</button>`).join("")}</div>${rev(K(x.role, "curve"))}</td>
      <td><input class="num" type="number" step="5" min="5" max="100" data-act="axis-scale" data-i="${k}" value="${Math.round(x.scale * 100)}"> %${rev(K(x.role, "scale"))}</td>
      <td><input class="num" type="number" step="0.05" min="0" max="2" data-act="axis-slew" data-i="${k}" value="${x.slew}"> s${rev(K(x.role, "slew"))}</td>
      <td>${DRIVE_ROLES.includes(x.role) ? "" : `<button class="x" data-act="axis-remove" data-i="${k}" title="Remove this axis">Remove</button>`}</td></tr>`).join("");
  const missing = DRIVE_ROLES.filter((r) => !p.axes.some((x) => x.role === r));
  const caps = a ? capsFor(a, p.speed) : null;
  return `<h2>Sticks</h2>
    <p class="small">Each stick direction goes through Catalyst's <span class="mono">DriverProfile</span>: invert, deadband, curve, then the cap. Click a row to see its curve; move the stick to see the dot.</p>
    <div class="tb-wrap"><table class="tb">
      <tr><th>Stick</th><th>Robot axis</th><th>Invert</th><th>Deadband</th><th>Curve</th><th>Scale</th><th>Slew</th><th></th></tr>${rows}
    </table></div>
    <div class="addrow">
      ${missing.map((r) => `<button class="btn tiny" data-act="axis-add-drive" data-role="${r}">Add ${esc(ROLE[r].label.toLowerCase())}</button>`).join("")}
      <input class="txt" id="extraRole" placeholder="extra axis name, e.g. elevator" aria-label="Extra axis name">
      <button class="btn tiny" data-act="axis-add-extra">Add an extra axis</button>
    </div>
    ${a ? `<div class="two">
      <div class="block"><div class="side-h"><span class="lbl">Response · ${esc(roleLabel(a.role))}</span><span class="cap">${esc(CURVES[a.curve] ? CURVES[a.curve].label : a.curve)}</span></div>
        ${curveSvg(a, p.speed)}
        <p class="cap" style="margin-top:6px">${esc(CURVES[a.curve] ? CURVES[a.curve].about : "")} Solid is what the robot does now; dashed is what the slow and turbo buttons switch to. Hatched is the deadband.</p></div>
      <div class="block"><div class="lbl">Stage by stage</div><dl class="stages" id="stages"></dl>
        <p class="cap" style="margin-top:8px">Full stick gives ${pct(caps.normal)} of top speed${DRIVE_ROLES.includes(a.role) ? `, ${pct(caps.slow)} in slow mode and ${pct(caps.turbo)} in turbo` : ""}.
        Slew is Catalyst's SlewRateLimiter: seconds from stop to full stick, 0 is off.</p></div>
    </div>` : ""}`;
}

// --- speed -----------------------------------------------------------------------------------

function speedSvg(s) {
  const W = 520, H = 58, x = (v) => 12 + Math.min(1, v) * (W - 24);
  const mark = (v, label, solid) => `<line x1="${x(v)}" y1="14" x2="${x(v)}" y2="36" style="stroke:${solid ? "var(--cat-white)" : "var(--cat-muted)"};stroke-width:${solid ? 2 : 1.4};${solid ? "" : "stroke-dasharray:4 3"}"/>
    <text x="${x(v)}" y="50" text-anchor="middle" class="svg-t">${label} ${pct(v)}</text>`;
  return `<svg class="plot" viewBox="0 0 ${W} ${H}" role="img" aria-label="Speed caps">
    <style>.svg-t{font:9.5px var(--cat-mono);fill:var(--cat-muted);letter-spacing:.06em}</style>
    <line x1="${x(0)}" y1="25" x2="${x(1)}" y2="25" style="stroke:var(--cat-hair-str)"/>
    ${[0, 0.25, 0.5, 0.75, 1].map((v) => `<line x1="${x(v)}" y1="21" x2="${x(v)}" y2="29" style="stroke:var(--cat-hair-str)"/>`).join("")}
    <text x="${x(0)}" y="10" class="svg-t">0</text><text x="${x(1)}" y="10" text-anchor="end" class="svg-t">DRIVETRAIN TOP SPEED</text>
    ${mark(s.max * s.slow, "SLOW", false)}${mark(Math.min(1, s.max * s.turbo), "TURBO", false)}${mark(s.max, "NORMAL", true)}</svg>`;
}

function sheetSpeed() {
  const p = prof();
  const s = p.speed;
  const K = (f) => `p:${p.name}:${f}`;
  return `<h2>Speed</h2>
    <div class="kv">
      <span class="lbl">Top speed</span><span><input class="num" type="number" step="5" min="5" max="100" data-act="speed-max" value="${Math.round(s.max * 100)}"> % of what the drivetrain can do${rev(K("max"))}</span>
      <span class="lbl">Slow mode</span><span>&times; <input class="num" type="number" step="0.05" min="0.05" max="0.95" data-act="speed-slow" value="${s.slow}"> = ${pct(s.max * s.slow)} while held${rev(K("slow"))}</span>
      <span class="lbl">Turbo</span><span>&times; <input class="num" type="number" step="0.05" min="1" max="3" data-act="speed-turbo" value="${s.turbo}"> = ${pct(Math.min(1, s.max * s.turbo))} while held${rev(K("turbo"))}</span>
    </div>
    <div class="block" style="margin-top:16px">${speedSvg(s)}</div>
    <p class="small" style="margin-top:12px">Top speed and slow mode are <span class="mono">DriverProfile</span>'s own <span class="mono">maxSpeed</span> and <span class="mono">slowMode</span>. The library has no turbo, so turbo is a second DriverProfile with the higher cap, switched in while its button is held; slow wins if both are held. Each stick's Scale multiplies all three. Which buttons hold them is on the Buttons tab.</p>`;
}

// --- buttons ---------------------------------------------------------------------------------

function actionChoices() {
  const t = S.config.target;
  const groups = new Map();
  const add = (group, value, label) => { if (!groups.has(group)) groups.set(group, []); groups.get(group).push([value, label]); };
  for (const [id, b] of Object.entries(BUILTIN_ACTIONS)) if (!b.needsDrive || (t.robotClass && t.swerveField)) add("Driver Config", `builtin:${id}`, b.label);
  const scanned = S.scan ? S.scan.actions : [];
  for (const a of scanned) add(a.group, `cmd:${a.expr}`, a.label);
  for (const p of S.config.profiles) for (const b of p.bindings) {
    if (b.action.kind === "command" && !scanned.some((a) => a.expr === b.action.expr)) add(S.scan ? "Not found in the project" : "In this profile", `cmd:${b.action.expr}`, b.action.label || b.action.expr);
  }
  return groups;
}

function selectAction(k, action) {
  const cur = action.kind === "builtin" ? `builtin:${action.id}` : `cmd:${action.expr}`;
  const seen = new Set();
  const groups = [...actionChoices().entries()].map(([g, list]) => `<optgroup label="${esc(g)}">${list.filter(([v]) => !seen.has(v) && seen.add(v)).map(([v, label]) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(label)}</option>`).join("")}</optgroup>`).join("");
  return `<select class="sel-in" data-act="bind-action" data-i="${k}">${groups}</select>`;
}

function sheetButtons() {
  const p = prof();
  const l = lay();
  const inputs = inputsFor(l);
  for (const b of p.bindings) if (!inputs.some((x) => inputKey(x) === inputKey(b.input))) inputs.push(b.input);
  const inputSelect = (k, cur) => `<select class="sel-in" data-act="bind-input" data-i="${k}">${inputs.map((x) => {
    const m = x.kind === "pov" ? "" : isMeasured(l, x.kind, x.index) ? " - measured" : "";
    return `<option value="${esc(inputKey(x))}"${inputKey(x) === inputKey(cur) ? " selected" : ""}>${esc(inputLabel(l, x))}${m}</option>`;
  }).join("")}</select>`;
  const rows = p.bindings.map((b, k) => {
    const expr = b.action.kind === "builtin" ? (b.action.id === "reseed" ? "reseedHeading(): 0 deg on Blue, 180 on Red" : `Driver Config's ${b.action.id} mode`) : b.action.expr;
    return `<tr data-bind-row="${k}" class="${S.down.has(k) ? "down" : ""}">
      <td>${inputSelect(k, b.input)}${rev(`p:${p.name}:in:${inputKey(b.input)}`)}</td>
      <td><select class="sel-in" data-act="bind-when" data-i="${k}">${Object.entries(WHEN).map(([id, w]) => `<option value="${id}"${id === b.when ? " selected" : ""}>${esc(w.label)}</option>`).join("")}</select></td>
      <td>${selectAction(k, b.action)}<div class="cap mono" style="margin-top:2px">${esc(expr)}</div></td>
      <td><button class="x" data-act="bind-remove" data-i="${k}">Remove</button></td></tr>`;
  }).join("");
  let code = "";
  if (S.scan && S.scan.existingBindings.length) {
    const hits = new Set(codeCollisions(S.scan).flat());
    const file = S.scan.existingBindings[0].file;
    code = `<h2>Already bound in your code</h2>
      <p class="small">What ${esc(file)} binds today, at the raw number each call resolves to on a ${esc(l.label)}. Buttons bound both there and here fire both - the Checks list names them.</p>
      <div class="tb-wrap"><table class="tb"><tr><th>Line</th><th>Code</th><th>Button</th><th>Runs</th></tr>
      ${S.scan.existingBindings.map((e) => `<tr class="${hits.has(e) ? "bad" : ""}"><td class="mono">${e.line}</td><td class="mono">${esc(e.text)}</td>
        <td>${esc(inputLabel(l, e.input))}${e.input.how === "fallback" ? " <span class=\"cap\">(the code's fallback; the robot may store another)</span>" : ""}${hits.has(e) ? "<div class=\"cap\" style=\"color:var(--cat-bad)\">&#x2715; two actions on this button</div>" : ""}</td>
        <td class="cap mono">${esc(e.command.slice(0, 90))}</td></tr>`).join("")}
      </table></div>
      <div class="addrow"><button class="btn tiny" data-act="import-code">Replace this profile's buttons with the importable ones</button>
        <span class="cap">Single calls and slow mode come across; the rest stay in your code.</span></div>`;
  }
  return `<h2>Buttons</h2>
    <p class="small">Numbers are the robot's, from 0 - the n in <span class="mono">button(n)</span>. "Measured" means seen on a Driver Station; everything else follows the layout. Press a button on the pad and its row lights up.</p>
    <div class="tb-wrap"><table class="tb"><tr><th>Button</th><th>When</th><th>Does</th><th></th></tr>${rows || "<tr><td colspan=\"4\" class=\"cap\">No buttons yet.</td></tr>"}</table></div>
    <div class="addrow">
      <button class="btn tiny" data-act="bind-add">Add a button</button>
      <button class="btn tiny" data-act="bind-listen" aria-pressed="${S.listening}">${S.listening ? "Press it on the pad now... (click to stop)" : "Add by pressing it on the pad"}</button>
    </div>${code}`;
}

// --- rumble ----------------------------------------------------------------------------------

function eventChoices(cur) {
  const groups = new Map();
  const add = (g, v, label) => { if (!groups.has(g)) groups.set(g, []); groups.get(g).push([v, label]); };
  for (const [id, e] of Object.entries(BUILTIN_EVENTS)) add("Driver Config", `builtin:${id}`, e.label);
  for (const [id, e] of Object.entries(STATIC_EVENTS)) add(`Catalyst ${LIBRARY.version}`, `static:${id}`, e.param ? `${e.label}...` : e.label);
  for (const e of (S.scan ? S.scan.events : [])) add(e.group, `trigger:${e.expr}`, e.label);
  const v = cur.kind === "builtin" ? `builtin:${cur.id}` : cur.kind === "static" ? `static:${cur.id}` : cur.kind === "input" ? `input:${inputKey(cur.input)}` : `trigger:${cur.expr}`;
  if (![...groups.values()].flat().some(([x]) => x === v)) add(S.scan ? "Not found in the project" : "In this profile", v, cur.label || cur.expr || v);
  return { groups, v };
}

function sheetRumble() {
  const p = prof();
  const l = lay();
  const op = S.config.operator;
  const rows = p.rumble.map((r, k) => {
    const { groups, v } = eventChoices(r.event);
    const s = r.event.kind === "static" ? STATIC_EVENTS[r.event.id] : null;
    return `<tr>
      <td><select class="sel-in" data-act="rumble-event" data-i="${k}">${[...groups.entries()].map(([g, list]) => `<optgroup label="${esc(g)}">${list.map(([x, label]) => `<option value="${esc(x)}"${x === v ? " selected" : ""}>${esc(label)}</option>`).join("")}</optgroup>`).join("")}</select>
        ${s && s.param ? `<input class="num" type="number" data-act="rumble-param" data-i="${k}" min="${s.param.min}" max="${s.param.max}" step="0.5" value="${r.event.param}"> ${esc(s.param.unit)}` : ""}</td>
      <td><select class="sel-in" data-act="rumble-pattern" data-i="${k}">${Object.entries(RUMBLE_PATTERNS).map(([id, x]) => `<option value="${id}"${id === r.pattern ? " selected" : ""}>${esc(x.label)} (${x.ms} ms)</option>`).join("")}</select>
        <div style="margin-top:4px">${patternStrip(r.pattern)}</div></td>
      <td><select class="sel-in" data-act="rumble-channel" data-i="${k}">${Object.entries(CHANNELS).map(([id, c]) => `<option value="${id}"${id === r.channel ? " selected" : ""}>${esc(c.label)}</option>`).join("")}</select></td>
      <td style="white-space:nowrap"><button class="btn tiny" data-act="rumble-test" data-i="${k}" title="Play it on the pad plugged into this computer">Feel it</button> <button class="x" data-act="rumble-remove" data-i="${k}">Remove</button></td></tr>`;
  }).join("");
  return `<h2>Rumble</h2>
    <p class="small">Catalyst's <span class="mono">RumbleEvents</span>: when something happens, a pattern on the driver's pad, the operator's, or both. The library runs both motors together at full strength - Ramp climbs over 0.3 s - and has no per-side or per-strength setting, so neither does this page. ${l.rumble === "no" ? `<b>A ${esc(l.label)} has no rumble motors.</b>` : ""}</p>
    <div class="kv" style="margin-top:12px">
      <span class="lbl">Operator pad</span><span><select class="sel-in" data-act="op-type"><option value="">none</option>${Object.entries(CONTROLLER_TYPES).map(([id, t]) => `<option value="${id}"${op && op.type === id ? " selected" : ""}>${esc(t.label)}</option>`).join("")}</select>
        ${op ? `port <select class="sel-in" data-act="op-port">${[0, 1, 2, 3, 4, 5].map((n) => `<option${n === op.port ? " selected" : ""}>${n}</option>`).join("")}</select>` : ""}
        <span class="cap">only used to rumble the operator</span>${rev("operator")}</span>
    </div>
    <div class="tb-wrap" style="margin-top:12px"><table class="tb"><tr><th>When</th><th>Pattern</th><th>Pad</th><th></th></tr>${rows || "<tr><td colspan=\"4\" class=\"cap\">No rumble rules.</td></tr>"}</table></div>
    <div class="addrow"><button class="btn tiny" data-act="rumble-add">Add a rumble rule</button></div>`;
}

// --- changes ---------------------------------------------------------------------------------

function sheetChanges() {
  const ch = changes(S.baseline, S.config);
  return `<h2>Changes since ${esc(S.origin)}</h2>
    ${ch.length ? `<div class="changes block">${ch.map((c) => `<div class="change"><span>${esc(c.label)}</span><span class="rev">${c.from != null ? `<span class="rev-1">${esc(c.from)}</span>` : "<span class=\"cap\">added</span>"}${c.to != null ? `<span class="rev-2">${esc(c.to)}</span>` : "<span class=\"cap\">removed</span>"}</span></div>`).join("")}</div>
      <div class="addrow"><button class="btn" data-act="revert-all">Put everything back to ${esc(S.origin)}</button><span class="cap">Undo steps back one edit at a time (Ctrl+Z).</span></div>`
      : `<p class="small"><span class="proven">Nothing changed</span> since ${esc(S.origin)}.</p>`}
    <h2>The profile, as it travels in the file</h2>
    <p class="small">This JSON rides in a comment inside the generated region; it is how the app reads the setup back. The Java beside it is generated from it.</p>
    <pre class="code" style="max-height:360px;overflow:auto">${esc(serializeConfig(S.config))}</pre>`;
}

// ------------------------------------------------------------------ events

function decodeInput(key) {
  if (key.startsWith("pov:")) return { kind: "pov", dir: key.slice(4) };
  const a = /^a(\d+)>(.+)$/.exec(key);
  if (a) return { kind: "axis", index: Number(a[1]), threshold: Number(a[2]) };
  return { kind: "button", index: Number(key.slice(1)) };
}

function decodeAction(v) {
  if (v.startsWith("builtin:")) return { kind: "builtin", id: v.slice(8) };
  const expr = v.slice(4);
  const found = S.scan && S.scan.actions.find((a) => a.expr === expr);
  const existing = S.config.profiles.flatMap((p) => p.bindings).find((b) => b.action.expr === expr);
  return { kind: "command", expr, label: found ? found.label : existing ? existing.action.label : expr };
}

function decodeEvent(v, old) {
  const [kind, ...rest] = v.split(":");
  const id = rest.join(":");
  if (kind === "builtin") return { kind, id };
  if (kind === "static") return STATIC_EVENTS[id].param ? { kind, id, param: old.kind === "static" && old.id === id ? old.param : STATIC_EVENTS[id].param.default } : { kind, id };
  if (kind === "input") return { kind, input: decodeInput(id) };
  const found = S.scan && S.scan.events.find((e) => e.expr === id);
  return { kind: "trigger", expr: id, label: found ? found.label : (old.label || id) };
}

function defaultWhen(action) {
  if (action.kind === "builtin") return BUILTIN_ACTIONS[action.id] ? BUILTIN_ACTIONS[action.id].when[0] : "whileTrue";
  const found = S.scan && S.scan.actions.find((a) => a.expr === action.expr);
  return found ? found.when : "whileTrue";
}

function firstFreeInput(p, l) {
  const used = new Set(p.bindings.map((b) => inputKey(b.input)));
  return inputsFor(l).find((x) => !used.has(inputKey(x))) || { kind: "button", index: 0 };
}

async function ask(title, label, value = "") {
  const dlg = $("#askDlg");
  dlg.innerHTML = `<form method="dialog"><div class="dlg-h"><h2>${esc(title)}</h2></div>
    <div class="dlg-b"><label class="lbl" for="askIn">${esc(label)}</label><br><input class="txt" id="askIn" style="width:100%;margin-top:6px" maxlength="40" value="${esc(value)}"></div>
    <div class="dlg-f"><button class="btn" value="">Cancel</button><button class="btn primary" value="ok">OK</button></div></form>`;
  dlg.showModal();
  const input = dlg.querySelector("#askIn");
  input.select();
  return new Promise((resolve) => {
    dlg.onclose = () => resolve(dlg.returnValue === "ok" ? input.value.trim() : null);
  });
}

async function onClick(e) {
  const el = e.target.closest("[data-act]");
  if (!el || el.tagName === "SELECT" || (el.tagName === "INPUT" && el.type !== "button")) return;
  const act = el.dataset.act;
  const i = Number(el.dataset.i);
  const p = prof();
  const l = lay();
  switch (act) {
    case "tab": S.sel.tab = el.dataset.tab; render(); break;
    case "goto":
      if (el.dataset.name) S.sel.profile = el.dataset.name;
      S.sel.tab = el.dataset.tab === "profiles" || el.dataset.tab === "project" ? S.sel.tab : el.dataset.tab;
      render();
      $("#sheet").scrollIntoView({ behavior: "smooth", block: "start" });
      break;
    case "pick-profile": S.sel.profile = el.dataset.name; S.sel.axis = 0; render(); break;
    case "profile-new": {
      const name = await ask("New profile", "Name, e.g. the driver's", "");
      if (!name) break;
      let made = "";
      commit(`add profile ${name}`, (c) => { const r = addProfile(c, newProfile(name, p.controller.type, p.controller.port)); Object.assign(c, r.config); made = r.name; });
      S.sel.profile = made || name; render();
      break;
    }
    case "profile-dup": {
      let made = "";
      commit(`duplicate ${p.name}`, (c) => { const r = duplicateProfile(c, p.name); Object.assign(c, r.config); made = r.name; });
      S.sel.profile = made; render();
      break;
    }
    case "profile-rename": {
      const name = await ask("Rename profile", "New name", p.name);
      if (!name || name === p.name) break;
      try {
        const c = renameProfile(S.config, p.name, name);
        commit(`rename ${p.name} to ${name}`, (x) => Object.assign(x, c));
        S.sel.profile = name; render();
      } catch (err) { note("warn", esc(err.message)); render(); }
      break;
    }
    case "profile-default": commit(`make ${p.name} the default`, (c) => Object.assign(c, setDefaultProfile(c, p.name))); break;
    case "profile-delete": {
      const sure = await ask(`Delete ${p.name}?`, "Type the profile's name to delete it (Undo brings it back)", "");
      if (sure !== p.name) break;
      commit(`delete ${p.name}`, (c) => Object.assign(c, deleteProfile(c, p.name)));
      break;
    }
    case "axis-select": if (S.sel.axis !== i) { S.sel.axis = i; render(); } break;
    case "axis-curve": commit(`${roleLabel(p.axes[i].role)} curve`, (c) => { cp(c).axes[i].curve = el.dataset.v; }); break;
    case "axis-remove": commit(`remove ${p.axes[i].role}`, (c) => { cp(c).axes.splice(i, 1); }); S.sel.axis = 0; break;
    case "axis-add-drive": commit(`add ${el.dataset.role}`, (c) => { cp(c).axes.push(defaultAxis(el.dataset.role, p.controller.type)); }); break;
    case "axis-add-extra": {
      const name = ($("#extraRole").value || "").trim();
      if (!JAVA_IDENT.test(name) || JAVA_KEYWORDS.has(name) || DRIVE_ROLES.includes(name)) { note("warn", "An extra axis needs a name made of letters and digits, starting with a letter - it becomes <span class=\"mono\">axis(\"name\")</span> in Java."); render(); break; }
      const used = new Set(p.axes.map((a) => a.axis));
      const free = l.axes.findIndex((_, k) => !used.has(k));
      commit(`add axis ${name}`, (c) => { cp(c).axes.push({ role: name, axis: Math.max(0, free), invert: false, deadband: 0.08, curve: "linear", scale: 1, slew: 0 }); });
      break;
    }
    case "bind-add": commit("add a button", (c) => { const action = { kind: "builtin", id: "slow" }; cp(c).bindings.push({ input: firstFreeInput(p, l), when: defaultWhen(action), action }); }); break;
    case "bind-remove": commit(`remove ${inputLabel(l, p.bindings[i].input)}`, (c) => { cp(c).bindings.splice(i, 1); }); break;
    case "bind-listen": S.listening = !S.listening; render(); break;
    case "import-code": {
      const imported = bindingsFromCode(S.scan).imported;
      commit(`import ${imported.length} buttons from code`, (c) => { cp(c).bindings = clone(imported); });
      break;
    }
    case "rumble-add": commit("add a rumble rule", (c) => { cp(c).rumble.push({ event: { kind: "static", id: "RobotState.lateMatch", param: 20 }, pattern: "LONG", channel: "DRIVER" }); }); break;
    case "rumble-remove": commit("remove a rumble rule", (c) => { cp(c).rumble.splice(i, 1); }); break;
    case "rumble-test":
      if (!playPattern(p.rumble[i].pattern)) {
        el.textContent = "No pad here can rumble";
        setTimeout(() => { el.textContent = "Feel it"; }, 1800);
      }
      break;
    case "revert-all": commit(`put everything back to ${S.origin}`, (c) => Object.assign(c, clone(S.baseline))); break;
    case "add-constants": commit("own the constants block", (c) => { c.target.constants = { path: el.dataset.path, className: el.dataset.class }; }); break;
    case "open-projects": try { window.parent.postMessage({ type: "catalyst:navigate", view: "projects" }, "*"); } catch { /* not in the app */ } break;
    case "start-sample": commit("start from the X1 sample", (c) => Object.assign(c, sampleConfig())); S.sel.profile = S.config.defaultProfile; S.notices.splice(i, 1); render(); break;
    case "start-blank": commit("start blank", (c) => Object.assign(c, blankConfig(S.config.target))); S.sel.profile = S.config.defaultProfile; S.notices.splice(i, 1); render(); break;
    case "discard-draft": store.del(draftKey()); S.config = clone(S.baseline); S.pendingDraft = null; S.notices.splice(i, 1); render(); break;
    case "restore-draft": if (S.pendingDraft) commit("restore unapplied edits", (c) => Object.assign(c, normalize(JSON.parse(S.pendingDraft)))); S.notices.splice(i, 1); render(); break;
    default: break;
  }
}

/** The profile on screen inside a config being edited. */
function cp(c) { return c.profiles.find((x) => x.name === S.sel.profile) || c.profiles[0]; }

function onChange(e) {
  const el = e.target.closest("[data-act]");
  if (!el) return;
  const act = el.dataset.act;
  const i = Number(el.dataset.i);
  const v = el.type === "checkbox" ? el.checked : el.value;
  const p = prof();
  const num = Number(v);
  switch (act) {
    case "ctl-type": commit(`controller type ${v}`, (c) => { cp(c).controller.type = v; }); break;
    case "ctl-port": commit(`port ${v}`, (c) => { cp(c).controller.port = num; }); break;
    case "map-axis": case "map-button": {
      const kind = act === "map-axis" ? "axes" : "buttons";
      commit(`map ${kind === "axes" ? "axis" : "button"} ${i}`, (c) => {
        const cur = layoutOf(c, p.controller.type);
        const m = c.maps[p.controller.type] = c.maps[p.controller.type] || {};
        m[kind] = [...cur[kind]];
        m[kind][i] = v || null;
      });
      break;
    }
    case "map-measured": {
      const key = el.dataset.kind === "axis" ? "measuredAxes" : "measuredButtons";
      commit(`${v ? "measured" : "not measured"}: ${el.dataset.kind} ${i}`, (c) => {
        const m = c.maps[p.controller.type] = c.maps[p.controller.type] || {};
        const set = new Set(m[key] || []);
        if (v) set.add(i); else set.delete(i);
        m[key] = [...set].sort((a, b) => a - b);
      });
      break;
    }
    case "axis-index": commit(`${roleLabel(p.axes[i].role)} axis ${v}`, (c) => { cp(c).axes[i].axis = num; }); break;
    case "axis-invert": commit(`${roleLabel(p.axes[i].role)} ${v ? "inverted" : "not inverted"}`, (c) => { cp(c).axes[i].invert = !!v; }); break;
    case "axis-deadband": commit(`${roleLabel(p.axes[i].role)} deadband`, (c) => { cp(c).axes[i].deadband = v === "" ? NaN : num; }); break;
    case "axis-scale": commit(`${roleLabel(p.axes[i].role)} scale`, (c) => { cp(c).axes[i].scale = v === "" ? NaN : num / 100; }); break;
    case "axis-slew": commit(`${roleLabel(p.axes[i].role)} slew`, (c) => { cp(c).axes[i].slew = v === "" ? NaN : num; }); break;
    case "speed-max": commit("top speed", (c) => { cp(c).speed.max = v === "" ? NaN : num / 100; }); break;
    case "speed-slow": commit("slow multiplier", (c) => { cp(c).speed.slow = v === "" ? NaN : num; }); break;
    case "speed-turbo": commit("turbo multiplier", (c) => { cp(c).speed.turbo = v === "" ? NaN : num; }); break;
    case "bind-input": commit("button", (c) => { cp(c).bindings[i].input = decodeInput(v); }); break;
    case "bind-when": commit("when it fires", (c) => { cp(c).bindings[i].when = v; }); break;
    case "bind-action": commit("what it does", (c) => {
      const b = cp(c).bindings[i];
      b.action = decodeAction(v);
      if (b.action.kind === "builtin" && !BUILTIN_ACTIONS[b.action.id].when.includes(b.when)) b.when = defaultWhen(b.action);
    }); break;
    case "rumble-event": commit("rumble event", (c) => { const r = cp(c).rumble[i]; r.event = decodeEvent(v, r.event); }); break;
    case "rumble-param": commit("rumble threshold", (c) => { cp(c).rumble[i].event.param = num; }); break;
    case "rumble-pattern": commit("rumble pattern", (c) => { cp(c).rumble[i].pattern = v; }); break;
    case "rumble-channel": commit("rumble pad", (c) => { cp(c).rumble[i].channel = v; }); break;
    case "op-type": commit("operator pad", (c) => { c.operator = v ? { type: v, port: c.operator ? c.operator.port : 1 } : null; }); break;
    case "op-port": commit("operator port", (c) => { c.operator.port = num; }); break;
    case "toggle-classfile": commit(v ? "write DriverConfig.java" : "do not write DriverConfig.java", (c) => { c.target.classFile = !!v; }); break;
    case "toggle-constants": if (!v) commit("stop owning the constants block", (c) => { c.target.constants = null; }); break;
    case "robot-class": {
      S.scan = S.sources ? scanProject(S.sources, { className: "DriverConfig", robotClass: v || undefined }) : S.scan;
      const robot = S.scan && S.scan.robot;
      commit(`robot class ${v || "none"}`, (c) => {
        c.target.robotClass = v || null;
        if (robot && v) { c.target.package = robot.pkg; c.target.swerveField = S.scan.swerveField; } else if (!v) c.target.swerveField = null;
      });
      break;
    }
    default: break;
  }
}

function onKey(e) {
  const typing = e.target && (e.target.tagName === "INPUT" && e.target.type === "text");
  if (typing || !(e.ctrlKey || e.metaKey)) return;
  const k = e.key.toLowerCase();
  if (k === "z" && !e.shiftKey) { e.preventDefault(); undoRedo(S.undo, S.redo); }
  else if ((k === "z" && e.shiftKey) || k === "y") { e.preventDefault(); undoRedo(S.redo, S.undo); }
}

// ------------------------------------------------------------------ start

async function init() {
  // Follow the accent the app is set to, so this page's one colour is the app's.
  try {
    const parentRoot = window.parent.document.documentElement;
    for (const v of ["--coral", "--coral-lt"]) {
      const val = getComputedStyle(parentRoot).getPropertyValue(v).trim();
      if (val) document.documentElement.style.setProperty(v, val);
    }
  } catch { /* opened on its own */ }

  document.addEventListener("click", onClick);
  document.addEventListener("change", onChange);
  document.addEventListener("keydown", onKey);
  $("#undoBtn").addEventListener("click", () => undoRedo(S.undo, S.redo));
  $("#redoBtn").addEventListener("click", () => undoRedo(S.redo, S.undo));
  $("#projSel").addEventListener("change", (e) => (e.target.value ? loadProject(e.target.value) : loadSample()));
  $("#applyBtn").addEventListener("click", () => openApply($("#applyDlg"), applyContext()));

  S.live = startLive($("#live"), () => ({ profile: prof(), layout: lay(), selectedAxis: S.sel.tab === "sticks" ? Math.min(S.sel.axis, prof().axes.length - 1) : null }), {
    onDown(down) {
      const before = [...S.down].join();
      S.down = down;
      if (before !== [...down].join() && S.sel.tab === "buttons") {
        document.querySelectorAll("[data-bind-row]").forEach((tr) => tr.classList.toggle("down", down.has(Number(tr.dataset.bindRow))));
      }
    },
    onBrowserButton(k, snap, l) {
      if (!S.listening) return;
      const robot = robotButtonFor(snap, l, k);
      S.listening = false;
      if (robot === null) { note("warn", `That button (browser ${k}) has no robot number on a ${esc(l.label)}. Check the map on the Controller tab.`); render(); return; }
      const p = prof();
      const input = { kind: "button", index: robot };
      const exists = p.bindings.findIndex((b) => inputKey(b.input) === inputKey(input));
      if (exists >= 0) { S.sel.tab = "buttons"; render(); return; }
      const action = { kind: "builtin", id: "slow" };
      commit(`add ${inputLabel(l, input)}`, (c) => { cp(c).bindings.push({ input, when: defaultWhen(action), action }); });
    },
  });

  await loadProjects();
  const last = store.get("project");
  if (IN_APP && S.projects.length) await loadProject(S.projects.some((p) => p.path === last) ? last : S.projects[0].path);
  else loadSample();
}

function applyContext() {
  return {
    config: S.config, baseline: S.baseline, origin: S.origin, project: S.project, scan: S.scan, sources: S.sources,
    invoke, inApp: IN_APP,
    async refreshProjects() {
      await loadProjects();
      if (S.project) S.project = S.projects.find((p) => p.path === S.project.path) || S.project;
      render();
    },
    refreshed: () => applyContext(),
    async onWritten() {
      S.baseline = clone(S.config);
      S.origin = "what was just written";
      store.del(draftKey());
      if (S.project) {
        try {
          S.sources = await invoke("project_java_sources", { dir: S.project.path });
          S.scan = scanProject(S.sources, { className: "DriverConfig", robotClass: S.config.target.robotClass || undefined });
        } catch { /* the write succeeded; a stale scan only affects warnings */ }
      }
      render();
    },
  };
}

// Exposed for the page's own checks in a browser console; nothing else uses it.
window.__driverConfig = { S, wiringSnippet };
init();
