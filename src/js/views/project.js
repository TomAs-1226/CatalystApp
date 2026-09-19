// Project health: the Doctor and the vendordeps inventory, the two tabs of one page.
//
// Both read a project and write nothing to it, and both look for the same class of thing: something
// that does not fail at build time. The Doctor's question is "will this run"; the inventory's is
// "what is installed". They share a severity vocabulary and a row shape on purpose - two views of
// the same project that grade the same fact differently are worse than either of them grading it
// wrong, and the Rust side already agrees with itself (doctor.rs and vendordeps.rs read the same
// folder through the same function).
//
// Read-only, deliberately. It would be easy to offer "fix this for me" on the JVM flags, and a tool
// that edits a team's build.gradle for them is a tool they cannot fully trust afterwards. It shows
// the lines and lets them paste.

import { $, IN_APP, escapeHtml, invoke, pickDirectory } from "../core.js";
import { project } from "../app.js";

/*
 * The folder each tab is looking at, kept for the session so returning to a tab does not mean
 * picking the same folder again.
 *
 * Per tab rather than shared: they answer different questions, and silently retargeting one because
 * the other was pointed somewhere else would report a verdict about a project nobody asked about.
 */
const chosen = { doctor: null, vendordeps: null };

const PANELS = {
  doctor: { path: "#docPath", notice: "#docBrowserNotice", run: runDoctor },
  vendordeps: { path: "#vdPath", notice: "#vdBrowserNotice", run: runVendordeps },
};

export function init() {
  // Outside the desktop app there is no file access at all, so the notice is up before anything is
  // clicked rather than appearing as the answer to a button press.
  $("#docBrowserNotice").hidden = IN_APP;
  $("#vdBrowserNotice").hidden = IN_APP;

  $("#docPickBtn").addEventListener("click", () => pick("doctor"));
  $("#vdPickBtn").addEventListener("click", () => pick("vendordeps"));

  // The page is about a project; when the app's open project changes, what is on screen is about
  // the wrong one.
  document.addEventListener("catalyst:project", onProjectChanged);
}

/**
 * Every visit. The first visit after a project is opened elsewhere in the app checks that project,
 * rather than asking someone to pick a folder that is already open.
 */
export async function activate(tab) {
  const which = tab === "vendordeps" ? "vendordeps" : "doctor";
  if (!IN_APP || chosen[which]) return;
  const open = project.get();
  if (!open?.path) return;
  await look(which, open.path);
}

async function pick(which) {
  if (!IN_APP) {
    // Nothing to throw: the notice is already up, and a picker that cannot open is not an error.
    $(PANELS[which].notice).hidden = false;
    return;
  }
  let dir;
  try {
    dir = await pickDirectory("Choose your robot project folder");
  } catch (e) {
    $(PANELS[which].path).textContent = "Could not open the picker: " + e;
    return;
  }
  if (!dir) return;
  await look(which, dir);
}

async function look(which, dir) {
  chosen[which] = dir;
  $(PANELS[which].path).textContent = dir;
  await PANELS[which].run(dir);
}

function onProjectChanged(event) {
  const open = event.detail;
  for (const which of Object.keys(PANELS)) {
    if (chosen[which] === open?.path) continue;
    chosen[which] = null;
    reset(which);
  }
  // Re-run for the tab in front of someone right now; the other one runs when it is next opened.
  const view = $("#view-project");
  if (!open?.path || !IN_APP || view.hidden) return;
  const tab = $('#projectTabs [aria-selected="true"]')?.dataset.tab;
  activate(tab);
}

function reset(which) {
  $(PANELS[which].path).textContent = "No folder chosen yet";
  if (which === "doctor") {
    $("#docVerdict").hidden = true;
    $("#docFindings").innerHTML = "";
    $("#docMigrationPanel").hidden = true;
    $("#docMigration").innerHTML = "";
  } else {
    $("#vdVerdict").hidden = true;
    $("#vdSeason").hidden = true;
    $("#vdNotes").innerHTML = "";
    $("#vdList").innerHTML = "";
  }
}

// ------------------------------------------------------------------- findings

/* One finding, in the shape both tabs report them in: a mark, what was checked, why it matters, and
 * what to do. The vendordeps list reuses it for the problems that belong to the whole folder rather
 * than to any one file. */
function findingRow(f) {
  return `<div class="finding ${levelClass(f.level)}">
      <span class="finding__mark">${levelMark(f.level)}</span>
      <div>
        <div class="finding__what">${escapeHtml(f.what)}</div>
        ${f.detail ? `<div class="finding__detail">${escapeHtml(f.detail)}</div>` : ""}
        ${fixBlock(f.fix)}
      </div>
    </div>`;
}

/* Rust grades a finding blocker/warn/ok; the stylesheet colours a row ok/warn/bad. The translation
 * lives here, in one place, so a row can never end up unstyled because a level was passed through
 * verbatim. */
const levelClass = (level) => (level === "ok" ? "ok" : level === "warn" ? "warn" : "bad");

/* The severity glyph, shared with the vendordeps list. There is no colour-only signalling anywhere
 * in either tab: every level has its own mark as well. */
const levelMark = (level) => (level === "ok" ? "✓" : level === "warn" ? "▲" : "✕");

/* The fix is shown as a block only when it is something to paste. A one-line instruction reads
 * better as a sentence than as a code block pretending to be a command. */
function fixBlock(fix) {
  if (!fix) return "";
  return fix.includes("\n") || fix.includes("{")
    ? `<pre class="finding__fix">${escapeHtml(fix)}</pre>`
    : `<div class="finding__fix hint">${escapeHtml(fix)}</div>`;
}

// --------------------------------------------------------------------- doctor

async function runDoctor(dir) {
  const verdict = $("#docVerdict");
  const list = $("#docFindings");
  verdict.hidden = false;
  verdict.className = "verdict checking";
  verdict.textContent = "Checking…";
  list.innerHTML = "";
  $("#docMigrationPanel").hidden = true;
  $("#docMigration").innerHTML = "";

  let result;
  try {
    result = await invoke("diagnose_project", { dir });
  } catch (e) {
    // The message is shown. The previous version built an `error` field that no markup ever
    // rendered, so a failure here read as a verdict over an empty list with the reason nowhere on
    // the page.
    verdict.className = "verdict blocked";
    verdict.textContent = "Could not read the project";
    list.innerHTML = findingRow({ level: "blocker", what: "The project could not be read", detail: String(e) });
    return;
  }

  verdict.className = `verdict ${result.ready ? "ready" : "blocked"}`;
  verdict.textContent = result.summary;
  list.innerHTML = (result.findings || []).map((f) => findingRow(f)).join("");

  await runMigrationScan(dir);
}

async function runMigrationScan(dir) {
  const panel = $("#docMigrationPanel");
  const list = $("#docMigration");

  let usages;
  try {
    usages = await invoke("scan_migration", { dir });
  } catch (e) {
    panel.hidden = false;
    list.innerHTML = findingRow({ level: "blocker", what: "Could not scan the source", detail: String(e) });
    return;
  }

  panel.hidden = usages.length === 0;
  if (!usages.length) return;

  /* Grouped by file, because that is the unit somebody opens. A flat list of forty lines across six
   * files is the same information arranged so nobody can act on it. */
  const byFile = new Map();
  for (const u of usages) {
    if (!byFile.has(u.file)) byFile.set(u.file, []);
    byFile.get(u.file).push(u);
  }

  list.innerHTML = `<div class="stack">${[...byFile.entries()].map(([file, rows]) => `
      <div class="section">
        <div class="row">
          <span class="path">${escapeHtml(file)}</span>
          <span class="hint">${rows.length} call site${rows.length === 1 ? "" : "s"}</span>
        </div>
        ${rows.map(usageRow).join("")}
      </div>`).join("")}</div>`;
}

function usageRow(u) {
  const rename = u.newName
    ? `<code>${escapeHtml(u.oldName)}</code> → <code>${escapeHtml(u.newName)}</code>`
    : `<code>${escapeHtml(u.oldName)}</code> → removed`;
  return `<div class="finding warn">
      <span class="finding__mark">▲</span>
      <div>
        <div class="finding__what">${rename} <span class="path">line ${escapeHtml(u.line)}</span></div>
        <div class="finding__detail">${escapeHtml(u.why)}</div>
        <pre class="finding__fix">${escapeHtml(u.text)}</pre>
      </div>
    </div>`;
}

// ---------------------------------------------------------------- vendordeps

/*
 * What is actually in vendordeps/, file by file.
 *
 * The Doctor answers in one verdict; this answers one row per file, because a team that has to fix
 * a vendordep has to open a specific file and a verdict does not tell them which. The file leads
 * the row for the same reason - the library inside can name itself something else entirely.
 */
async function runVendordeps(dir) {
  const verdict = $("#vdVerdict");
  const season = $("#vdSeason");
  const notes = $("#vdNotes");
  const list = $("#vdList");

  verdict.hidden = false;
  verdict.className = "verdict checking";
  verdict.textContent = "Reading vendordeps…";
  season.hidden = true;
  notes.innerHTML = "";
  list.innerHTML = "";

  let report;
  try {
    report = await invoke("inspect_vendordeps", { dir });
  } catch (e) {
    verdict.className = "verdict blocked";
    verdict.textContent = "Could not read the vendordeps folder";
    list.innerHTML = findingRow({ level: "blocker", what: "The folder could not be read", detail: String(e) });
    return;
  }

  verdict.className = `verdict ${report.ready ? "ready" : "blocked"}`;
  verdict.textContent = report.summary;

  // The season everything below is graded against, stated rather than assumed. When the project
  // declares none, the report already carries a note saying so - repeating it here would be two
  // sentences about one fact.
  if (report.projectYear) {
    season.hidden = false;
    season.innerHTML = `<div class="row">
        <span class="cat-chip cat-chip--on">${escapeHtml(report.projectYear)}</span>
        <span class="hint">The season this project declares, from
          <code>.wpilib/wpilib_preferences.json</code>. Every file below is graded against it.</span>
      </div>`;
  }

  // Wrong with the set rather than with any one file, so there is no row to hang them on.
  notes.innerHTML = (report.notes || []).map((f) => findingRow(f)).join("");
  list.innerHTML = (report.deps || []).map(depRow).join("");
}

function depRow(dep) {
  const title = escapeHtml(dep.name || stem(dep.file));
  const version = dep.version
    ? `<span class="path">${escapeHtml(dep.version)}</span>`
    : `<span class="path">version not stated</span>`;

  return `<div class="finding ${levelClass(dep.level)}">
      <span class="finding__mark">${levelMark(dep.level)}</span>
      <div>
        <div class="finding__what">${title} ${version}</div>
        <div class="finding__detail row">
          ${seasonChip(dep)}
          <span>from <span class="path">vendordeps/${escapeHtml(dep.file)}</span></span>
        </div>
        ${(dep.problems || []).map(problemBlock).join("")}
      </div>
    </div>`;
}

/*
 * The season the file itself declares.
 *
 * `.cat-chip--on` is the identity's "this is the one" chip and it is the signal colour, which is
 * exactly right for a file on the project's own season. A file that disagrees has to read
 * differently from one that agrees, so it is re-tinted from the warn tokens - no invented colour,
 * and no new stylesheet. (A `.cat-chip--warn` modifier in identity.css would be its proper home.)
 */
const WARN_CHIP = "background:var(--cat-warn-tint);border-color:var(--cat-warn);color:var(--cat-warn)";

function seasonChip(dep) {
  if (dep.malformed) return "";
  const year = escapeHtml(dep.frcYear ?? "");
  switch (dep.yearState) {
    case "match": return `<span class="cat-chip cat-chip--on">${year}</span>`;
    case "mismatch": return `<span class="cat-chip" style="${WARN_CHIP}">${year}</span>`;
    // No frcYear in the file at all, or nothing to compare it against because the project declares
    // no season. Both are ungraded, and the file's own problems say which one this is.
    case "missing": return `<span class="cat-chip">no season</span>`;
    default: return `<span class="cat-chip">${year || "no season"}</span>`;
  }
}

/* A file's own problems, under its row. The row's mark is the worst of them, so these carry their
 * wording rather than a second set of glyphs that would all be tinted by the row's level. */
function problemBlock(p) {
  return `<div class="finding__detail">
      <span class="finding__what">${escapeHtml(p.what)}</span>${p.detail ? ` — ${escapeHtml(p.detail)}` : ""}
    </div>${fixBlock(p.fix)}`;
}

const stem = (file) => String(file).replace(/\.json$/i, "");
