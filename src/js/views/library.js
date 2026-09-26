// The Library page: the Catalyst version this app installs, where it goes, and what changed.
//
// Install, the release notes and the update checks are one subject with three tabs, because they
// are three questions about one thing - the version of Catalyst this app puts on a robot.
//
// Two checks on this page are the reason it exists rather than being a button:
//
//   - the season check, which refuses to pretend a 2027 vendordep belongs in a 2026 project, and
//   - the `frcYear` refusal, which will not write a vendor's file that reports the wrong season.
//
// Both catch the same failure: a file that writes cleanly, looks installed, and fails at build with
// an error naming none of this.

import { $, $$, IN_APP, TAURI, escapeHtml, httpGet, invoke, openExternal, pickDirectory, settings } from "../core.js";
import { APP_VERSION_FALLBACK, CHANGELOG, DEPS, LIB_FRC_YEAR, LIB_VENDORDEP_URL, LIB_VERSION } from "../data.js";
import { banner, go } from "../app.js";
import { seasonOf } from "../../season.js";
import { cmpVer } from "../../version.js";

/** The folder the install tab is pointed at. Nothing is written anywhere else. */
let chosenDir = null;

const mode = () => settings.get("updateMode", "ask");

export function init() {
  $("#pickBtn").textContent = "Choose robot project folder…";
  $("#installVer").textContent = "v" + LIB_VERSION;
  $("#libVerMeta").textContent = "Bundled v" + LIB_VERSION;
  $("#includeDeps").checked = settings.getBool("includeDeps", true);
  $("#browserNotice").hidden = IN_APP;

  $("#pickBtn").addEventListener("click", pickFolder);
  $("#installBtn").addEventListener("click", doInstall);
  $("#checkAppBtn").addEventListener("click", () => checkApp(true));
  $("#checkLibBtn").addEventListener("click", () => checkLib(true));

  // It goes to the v1.12.0 tag, not to /releases. That list is ordered newest-first and its top
  // entry is 2.0.0-beta.2, so the button meant for teams that must not run the beta was landing
  // them on it.
  $("#wnOneXBtn").addEventListener("click", () =>
    openExternal("https://github.com/TomAs-1226/FrcCatalyst/releases/tag/v1.12.0"));

  wireUpdateMode();
  renderChangelog();
  paintAppVersion();
}

export function activate(tab) {
  // Someone who changed the default in Settings and then came here should see the default they set,
  // but not have a choice they made on this page overwritten under them.
  if (tab === "install" && !chosenDir) $("#includeDeps").checked = settings.getBool("includeDeps", true);
}

// -------------------------------------------------------------------- install

async function pickFolder() {
  if (!IN_APP) {
    // The notice is already up from init; nothing to throw, and nothing to pick.
    $("#browserNotice").hidden = false;
    return;
  }
  let dir;
  try {
    dir = await pickDirectory("Choose your robot project folder");
  } catch (e) {
    $("#chosenPath").textContent = "Could not open the picker: " + e;
    return;
  }
  if (!dir) return;
  chosenDir = dir;
  $("#chosenPath").textContent = dir;
  // The log belongs to the folder it was written for, so a different folder starts with none.
  $("#installLog").hidden = true;
  $("#installLog").innerHTML = "";
  await runDetect(dir);
}

async function runDetect(dir) {
  const el = $("#detectResult");
  el.hidden = false;
  el.innerHTML = `<div class="hint">Reading the project…</div>`;

  let info;
  try {
    info = await invoke("detect_project", { dir });
  } catch (e) {
    el.innerHTML = detectRow("bad", "Could not read that folder", escapeHtml(String(e)));
    $("#installOptions").hidden = true;
    return;
  }

  const rows = [`<div class="cat-card__title">${escapeHtml(info.project_name || "Selected folder")}</div>`];

  rows.push(info.is_wpilib
    ? detectRow("ok", "WPILib / GradleRIO project")
    : detectRow("bad", "Does not look like a WPILib project", escapeHtml((info.reasons || []).join("; "))));

  // Not a failure - it is the normal state of a project you are about to install into - so it is a
  // warning, not a cross. A page where the expected case is marked red is a page nobody reads.
  rows.push(info.has_catalyst
    ? detectRow("ok", `FrcCatalyst ${escapeHtml(info.catalyst_version || "?")} installed`,
        `Installing will update it to v${LIB_VERSION}.`)
    : detectRow("warn", "FrcCatalyst not installed yet"));

  // Season mismatch is the failure worth catching here. A 2027 vendordep in a 2026 project writes
  // cleanly, looks installed, and then fails at build with an error that mentions none of this.
  if (info.project_year && seasonOf(info.project_year) !== LIB_FRC_YEAR) {
    rows.push(detectRow("bad", `This is a ${escapeHtml(info.project_year)} project`,
      `Catalyst ${LIB_VERSION} targets ${LIB_FRC_YEAR}. Import it as a ${LIB_FRC_YEAR} project in `
      + `WPILib VS Code first — installing into a ${escapeHtml(info.project_year)} project will `
      + `build against the wrong WPILib.`));
  }

  el.innerHTML = rows.join("");
  $("#installOptions").hidden = !info.is_wpilib;
  // Note what is NOT here: the install log is left alone. An install finishes by re-detecting, so
  // clearing it here threw away the record of what had just been written half a second after it
  // appeared - which is what the previous version did, and why an install looked like it had done
  // nothing at all.
}

/* The same row shape the Doctor reports a finding in, so "✓ / ▲ / ✕" means one thing across the
 * app. `what` and `detail` are already escaped by the callers that interpolate a project's own
 * text into them. */
function detectRow(level, what, detail = "") {
  const mark = level === "ok" ? "✓" : level === "warn" ? "▲" : "✕";
  return `<div class="finding ${level}">
      <span class="finding__mark">${mark}</span>
      <div>
        <div class="finding__what">${what}</div>
        ${detail ? `<div class="finding__detail">${detail}</div>` : ""}
      </div>
    </div>`;
}

async function doInstall() {
  const log = $("#installLog");
  log.innerHTML = "";
  log.hidden = false;
  /* The level, not a boolean: a library the app cannot fetch and you do not need is not a failed
   * install. PathPlanner used to be logged with a red ✕ beside the things that genuinely went
   * wrong, which is how a finished install reads as a broken one. */
  const w = (level, message) => log.insertAdjacentHTML("beforeend", detectRow(level, escapeHtml(message)));

  try {
    const content = await invoke("read_bundled_vendordep");
    w("ok", await invoke("write_vendordep", { dir: chosenDir, filename: "FrcCatalyst.json", content }));
  } catch (e) {
    w("bad", "FrcCatalyst: " + e);
  }

  if ($("#includeDeps").checked) {
    for (const dep of DEPS) {
      if (dep.manual) {
        w(dep.optional ? "ok" : "warn",
          dep.optional ? `${dep.name}: not needed. ${dep.manual}`
            : `${dep.name}: no 2027 vendordep is published at a fetchable URL. ${dep.manual}`);
        continue;
      }
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
        w("ok", await invoke("write_vendordep", { dir: chosenDir, filename: dep.file, content }));
      } catch (e) {
        w("bad", `${dep.name}: ${e} — add it from Manage Vendor Libraries instead`);
      }
    }
  }

  markRecent(chosenDir);
  w("ok", "Done. Reopen the project in WPILib VS Code and build once while online.");
  await runDetect(chosenDir);
}

/*
 * Installing into a folder is the strongest statement of "this is the project I am working on", so
 * it goes to the front of Home's recent list.
 *
 * Only the order is written. Home builds that list out of the registry - which is the copy the MCP
 * server and the workspace already agree on - and this key says nothing except which order they
 * were last touched in. A folder that has never been imported still will not appear there; it is
 * not registered, so nothing knows its name or whether an agent may read it.
 */
function markRecent(dir) {
  let order = [];
  try { order = JSON.parse(settings.get("recentOrder", "[]")); } catch (_) { /* start a new one */ }
  settings.set("recentOrder", JSON.stringify([dir, ...order.filter((p) => p !== dir)].slice(0, 6)));
}

// ------------------------------------------------------------------- release

/*
 * The release history. The panel above it is what this release is and whether to put it on a robot;
 * this is the list of what changed, newest first, one card each.
 *
 * CHANGELOG is app data, not project data, but it goes through the same escape as everything else -
 * an apostrophe or an angle bracket in a release note should not be able to end a card early.
 */
function renderChangelog() {
  $("#changelog").innerHTML = CHANGELOG.map((c, i) => `
      <div class="cat-card">
        <div class="cat-card__head">
          <h2 class="cat-card__title">${escapeHtml(c.t)}
            <span class="cat-wordmark__version">${escapeHtml(c.v)}</span></h2>
          <span class="row">
            ${i === 0 ? `<span class="cat-pill">Latest</span>` : ""}
            <span class="path">${escapeHtml(c.date)}</span>
          </span>
        </div>
        <div class="cat-rail">
          ${c.items.map((it) => `<div class="cat-rail__item"><div class="cat-rail__body">${escapeHtml(it)}</div></div>`).join("")}
        </div>
      </div>`).join("");
}

// ------------------------------------------------------------------- updates

function wireUpdateMode() {
  const current = mode();
  $$('input[name="upmode"]').forEach((r) => {
    r.checked = r.value === current;
    r.addEventListener("change", () => { if (r.checked) settings.set("updateMode", r.value); });
  });
}

/**
 * The boot check: both checks, quietly, without opening this view.
 *
 * The shell calls it whether or not the Library page has ever been looked at, because an update is
 * something the user did not ask about and needs to know. The status lines it writes into are in
 * the document from the start, so they are already correct the first time the page is opened.
 */
export async function checkQuietly() {
  await Promise.all([checkApp(false), checkLib(false)]);
}

async function checkLib(manual) {
  const st = $("#libUpStatus");
  st.textContent = "Checking…";
  st.title = "";
  try {
    const r = await httpGet(LIB_VENDORDEP_URL);
    if (!r.ok) throw new Error("HTTP " + r.status);
    const latest = JSON.parse(await r.text()).version;
    if (cmpVer(latest, LIB_VERSION) > 0) {
      st.textContent = `v${latest} available`;
      if (mode() !== "manual" || manual) {
        banner(`FrcCatalyst v${escapeHtml(latest)} is available (this app bundles v${LIB_VERSION}).`,
          [{ label: "Install into a project", primary: true, onClick: () => go("library/install") }]);
      }
    } else {
      st.textContent = "Up to date";
    }
  } catch (e) {
    // Offline is the ordinary case in a pit, so a quiet check says so and keeps the reason on the
    // element. A check somebody pressed gets the reason itself - they are watching, and "offline"
    // is not an answer when the real problem is a 404.
    st.textContent = manual ? `Couldn't check: ${e}` : "Offline — couldn't check";
    st.title = String(e);
  }
}

async function checkApp(manual) {
  const st = $("#appUpStatus");
  st.textContent = "Checking…";
  st.title = "";
  if (!IN_APP || !TAURI.updater) {
    st.textContent = manual ? "Only available in the app" : "—";
    return;
  }
  try {
    const update = await TAURI.updater.check();
    if (!update || !update.available) { st.textContent = "Up to date"; return; }

    st.textContent = `v${update.version} available`;
    const install = async () => {
      await update.downloadAndInstall();
      await TAURI.process?.relaunch?.();
    };
    if (mode() === "auto") await install();
    else banner(`Catalyst app v${escapeHtml(update.version)} is available.`,
      [{ label: "Update & restart", primary: true, onClick: install }]);
  } catch (e) {
    st.textContent = manual ? `Couldn't check: ${e}` : "Offline — couldn't check";
    st.title = String(e);
  }
}

/**
 * Ask the binary what version it is, and put it everywhere this page shows it.
 *
 * Both elements, including the About line in Settings: whichever page is opened first, the other is
 * already right. The value comes from the binary, so two callers cannot disagree about it.
 */
async function paintAppVersion() {
  let version = APP_VERSION_FALLBACK;
  if (IN_APP) {
    try { version = await invoke("app_version"); } catch (_) { /* fall back to "dev" */ }
  }
  const meta = $("#appVerMeta");
  if (meta) meta.textContent = "Catalyst v" + version;
  const about = $("#aboutApp");
  if (about) about.textContent = version;
}
