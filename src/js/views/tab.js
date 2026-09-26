// Catalyst Tab: the tablet, and the PC-side service that feeds it.
//
// This page is not a dashboard and never will be. The tablet reads the robot itself over
// NetworkTables, and its PC-side companion - Catalyst Link - is a separate program with its own
// window, its own release cadence and its own state directory. Catalyst App has no NetworkTables
// client and no business starting, stopping or driving either of them.
//
// So the page answers the three questions somebody holding a Tab5 for the first time actually has,
// and then says what the thing is for:
//
//   1. Is the PC side running on this machine?  - one unauthenticated GET at 127.0.0.1:8765.
//   2. If not, how do I install and run it?     - the commands out of Catalyst Link's own README.
//   3. How does firmware get onto the tablet?   - it doesn't, from here: it is Link's firmware panel.
//
// The one network call is `GET /link/status`, which is the only route the Link answers without a
// token (`catalyst_link/server.py`, the `/link/status` branch of `Handler.handle`). It is also the
// only thing this app asks for: no token is read, no admin route is touched, and nothing is posted.
// That is deliberate rather than incidental - the Link's admin routes exist for its own app, which
// reads the main token off disk, and a second program reaching for that token would quietly widen a
// boundary somebody drew on purpose.

import { $, IN_APP, escapeHtml, httpGet } from "../core.js";

/** The port and route are the Link's own defaults; `--port` moves it, and then this will not find it. */
export const LINK_ORIGIN = "http://127.0.0.1:8765";
export const LINK_STATUS_URL = `${LINK_ORIGIN}/link/status`;

/** How long to wait before calling it not running. A refused connection on loopback is instant. */
const PROBE_MS = 2500;

// ------------------------------------------------------------------- the status
//
// The pure half, so it can be tested without a DOM or a Link.

/**
 * Read `/link/status` into the four facts it carries, tolerating anything.
 *
 * The unauthenticated body is `{ok, name, version, auth, pairing}` and nothing else - the rest of
 * the fields in `LinkApp.status` are behind `if not authed: return base`. `auth` is therefore always
 * false here, and that is the point: it says we reached a Link and were recognised as nobody, which
 * is exactly the amount of access this page wants.
 *
 * @param {unknown} raw the parsed JSON body
 * @returns {{ok: boolean, name: string|null, version: string|null, auth: boolean, pairing: boolean|null}}
 */
export function readLinkStatus(raw) {
  const s = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const bool = (v) => (typeof v === "boolean" ? v : null);
  return {
    // A Link always sends ok:true. Something else listening on 8765 that answers JSON without it is
    // not a Link, and must not be reported as one.
    ok: s.ok === true,
    name: str(s.name),
    version: str(s.version),
    auth: s.auth === true,
    pairing: bool(s.pairing),
  };
}

/**
 * What a reached Link is, as findings in the shape the Doctor and the install log use.
 *
 * `name` and `version` are strings another process on this machine chose, so they are escaped by
 * the renderer like any other text off the disk.
 */
export function linkFacts(status) {
  const s = readLinkStatus(status);
  const rows = [
    { level: "ok", what: s.name ? `Answering as “${s.name}”` : "Answering, with no name set",
      detail: s.name
        ? "The name the tablet shows for this PC when it looks for a Link (--name, default the hostname)."
        : "It reports no name. The tablet will show it by address instead." },
    { level: s.version ? "ok" : "warn", what: s.version ? `Catalyst Link ${s.version}` : "Version not reported",
      detail: s.version ? "" : "A Link always reports one, so this may not be a Link." },
  ];
  if (s.pairing === true) {
    rows.push({ level: "ok", what: "Pairing by code is on",
      detail: "A tablet finds this PC, you tap it, and the Link shows a six-digit code to type on the tablet." });
  } else if (s.pairing === false) {
    rows.push({ level: "warn", what: "Pairing by code is off",
      detail: "Started with --no-pair, so a tablet needs the Link's token typed in by hand." });
  }
  // Said out loud rather than left implicit: this app saw the one public route and nothing else.
  rows.push({ level: "ok", what: "Read without a token",
    detail: "/link/status is the only route the Link answers unauthenticated. Catalyst App asks for "
      + "nothing else - not the token, not the admin routes its own app uses." });
  return rows;
}

// -------------------------------------------------------------------- the view

export function init() {
  $("#tabCheckBtn").addEventListener("click", () => probe());
}

/** Every visit, because a Link that was started (or quit) since the last look is the whole point. */
export function activate() {
  return probe();
}

let probing = false;

async function probe() {
  if (probing) return;
  probing = true;
  const verdict = $("#tabLinkVerdict");
  const facts = $("#tabLinkFacts");
  const note = $("#tabLinkNote");
  const btn = $("#tabCheckBtn");

  if (!IN_APP) {
    // The Link sends no CORS headers, so a page served from a static server cannot read it however
    // the fetch is written. Saying so beats reporting "not running" about a Link that is running.
    verdict.className = "verdict checking";
    verdict.textContent = "Cannot check from a browser preview";
    facts.innerHTML = "";
    note.textContent = "Finding Catalyst Link needs the desktop app's HTTP access. Everything below "
      + "is the same either way.";
    $("#tabInstallCard").hidden = false;
    probing = false;
    return;
  }

  btn.disabled = true;
  verdict.className = "verdict checking";
  verdict.textContent = "Looking for Catalyst Link…";
  facts.innerHTML = "";
  note.textContent = "";

  let status = null;
  let why = "";
  try {
    const r = await httpGet(LINK_STATUS_URL, { signal: AbortSignal.timeout(PROBE_MS) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    status = readLinkStatus(await r.json());
    if (!status.ok) throw new Error("something is listening on 8765, but it did not answer as a Link");
  } catch (e) {
    why = String(e?.message || e);
  }

  if (status?.ok) {
    verdict.className = "verdict ready";
    verdict.textContent = "Catalyst Link is running on this PC";
    facts.innerHTML = linkFacts(status).map(factRow).join("");
    note.innerHTML = "Its window belongs to <b>Catalyst Link's own app</b> — open it from its tray "
      + "icon, or from the Start menu. Catalyst App cannot show it and does not try to: the two are "
      + "separate programs, and the only thing this page does is ask the one status route above.";
    $("#tabInstallCard").hidden = true;
  } else {
    verdict.className = "verdict waiting";
    verdict.textContent = "Nothing is answering on 127.0.0.1:8765";
    facts.innerHTML = factRow({
      level: "warn",
      what: "No Catalyst Link found",
      detail: why || "the connection was refused",
    });
    note.innerHTML = "That means it is <b>not running</b> — which is not the same as not installed. "
      + "It may never have been installed here, it may be installed and stopped, or it may be "
      + "listening on another port (<code>--port</code>). Below is how to install and start it.";
    $("#tabInstallCard").hidden = false;
  }

  btn.disabled = false;
  probing = false;
}

/* The row shape the Doctor, the vendordeps list and the install log all report a finding in, so a
 * mark means one thing across the app. `detail` is escaped here because some of it is text another
 * process chose. */
function factRow(f) {
  const mark = f.level === "ok" ? "✓" : f.level === "warn" ? "▲" : "✕";
  return `<div class="finding ${f.level === "ok" ? "ok" : f.level === "warn" ? "warn" : "bad"}">
      <span class="finding__mark">${mark}</span>
      <div>
        <div class="finding__what">${escapeHtml(f.what)}</div>
        ${f.detail ? `<div class="finding__detail">${escapeHtml(f.detail)}</div>` : ""}
      </div>
    </div>`;
}
