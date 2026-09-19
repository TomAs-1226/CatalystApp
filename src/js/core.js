// The things every view needs: the bridge to Tauri, the settings store, a few DOM helpers, and the
// icon set. Kept in one small module so a view imports one thing and no view reaches for a global.

/* Guarded, because this module is also imported by `node --test`: a pure function a pane depends on
   should be testable without a DOM, and `window.__TAURI__` at module scope would throw before the
   first test ran. Everything else here touches the document only inside a function. */
export const TAURI = (typeof window !== "undefined" && window.__TAURI__) || null;

/**
 * Whether we are inside the desktop app.
 *
 * The UI also runs from a plain static server, which is how it gets looked at during design work and
 * how the tools are checked. Everything that needs the file system is off in that mode and says so,
 * rather than failing at the first `invoke`.
 */
export const IN_APP = !!TAURI;

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const invoke = (cmd, args) => {
  if (!IN_APP) return Promise.reject(new Error("not running in the desktop app"));
  return TAURI.core.invoke(cmd, args);
};

export const httpGet = async (url) => (IN_APP ? TAURI.http.fetch(url, { method: "GET" }) : fetch(url));

export const settings = {
  get: (k, d) => { const v = localStorage.getItem("catalyst." + k); return v === null ? d : v; },
  set: (k, v) => localStorage.setItem("catalyst." + k, v),
  getBool: (k, d) => { const v = localStorage.getItem("catalyst." + k); return v === null ? d : v === "true"; },
  remove: (k) => localStorage.removeItem("catalyst." + k),
};

/* Everything the app renders about a project comes out of that project — file paths, source lines,
 * the contents of build.gradle. That is not hostile input, but it is arbitrary text going into
 * innerHTML, and a stray angle bracket in a source line should render as an angle bracket rather
 * than silently eating the rest of the row. */
export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function openExternal(url) {
  if (IN_APP && TAURI.opener) {
    try { await TAURI.opener.openUrl(url); return; } catch (_) { /* fall through to the browser */ }
  }
  window.open(url, "_blank");
}

export async function pickDirectory(title) {
  if (!IN_APP) return null;
  return TAURI.dialog.open({ directory: true, multiple: false, title });
}

export const appWindow = () => (IN_APP ? TAURI.window.getCurrentWindow() : null);

// ---------------------------------------------------------------- icons ----
// Line icons, drawn on a 24-grid with a 2px stroke so they sit at the same weight as the type.

const ICONS = {
  bolt: '<path d="M13.5 2 5 13h5l-1.5 9L19 10h-5.5z" fill="currentColor" stroke="none"/>',
  home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
  workspace: '<path d="M3 5a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="m9 13 2 2 4-4"/>',
  tools: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  project: '<path d="M11 2v3"/><path d="M17 2v3"/><path d="M8 5h12a1 1 0 0 1 1 1v5a7 7 0 0 1-14 0V6a1 1 0 0 1 1-1z"/><path d="M14 18a3 3 0 1 0 6 0v-3"/><circle cx="20" cy="10" r="1.4"/>',
  library: '<path d="M4 4v16"/><path d="M8 4v16"/><path d="M13 4h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-3z"/><path d="m19.5 5.5 1.6 13.4"/>',
  settings: '<path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>',
  builder: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  motors: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3"/><path d="M12 19v3"/><path d="M2 12h3"/><path d="M19 12h3"/><path d="m4.9 4.9 2.1 2.1"/><path d="m17 17 2.1 2.1"/><path d="m19.1 4.9-2.1 2.1"/><path d="m7 17-2.1 2.1"/>',
  pid: '<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>',
  motion: '<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>',
  wiring: '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>',
  canids: '<line x1="4" x2="20" y1="9" y2="9"/><line x1="4" x2="20" y1="15" y2="15"/><line x1="10" x2="8" y1="3" y2="21"/><line x1="16" x2="14" y1="3" y2="21"/>',
  aiming: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  auto: '<circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/>',
  statemachine: '<rect width="8" height="8" x="3" y="3" rx="2"/><path d="M7 11v4a2 2 0 0 0 2 2h4"/><rect width="8" height="8" x="13" y="13" rx="2"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 5v5h5"/><path d="M12 8v4l3 2"/>',
  autonomy: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
  console: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.2"/><path d="M12 8.8V3"/><path d="m9.2 13.6-4.9 2.9"/><path d="m14.8 13.6 4.9 2.9"/>',
  install: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  min: '<line x1="5" x2="19" y1="12" y2="12"/>',
  max: '<rect x="5" y="5" width="14" height="14" rx="1.5"/>',
  close: '<line x1="6" x2="18" y1="6" y2="18"/><line x1="18" x2="6" y1="6" y2="18"/>',
};

export const svg = (name) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;
