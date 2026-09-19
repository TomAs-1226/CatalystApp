// Copy the third-party editor and terminal builds into src/vendor/, where the frontend can load them.
//
// The frontend has no bundler and its CSP is `script-src 'self'`: nothing may be fetched from a CDN
// at run time and nothing may be compiled at build time. So the parts of monaco-editor and xterm
// that actually run in the window are copied out of node_modules as files the page can <script src>
// and `import` directly. node_modules itself is not shipped inside the app bundle, which is why a
// copy has to exist under src/.
//
// The copy is a build artefact, not source: src/vendor/ is gitignored and this script is what puts
// it back. `npm run prepare-resources` runs it, so `npm run build` cannot produce an app whose
// editor pane is a blank rectangle.
//
//   npm run vendor          # or: node scripts/vendor.mjs
//
// It is idempotent - each destination is removed and rewritten, so a file the upstream package
// dropped does not linger here - and it fails loudly rather than leaving a half-vendored tree.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const modules = join(root, "node_modules");
const vendor = join(root, "src", "vendor");

/*
 * What gets copied, and nothing else.
 *
 * Monaco: the whole of `min/vs`. It is 24 MB and most of that is language workers this app never
 * starts, but they cannot simply be deleted - `vs/editor/editor.main` lists the worker modules among
 * its AMD dependencies, so the loader fetches them while starting the editor. Trimming means
 * trimming only `assets/` and `language/ * /*.worker.js`, which are fetched solely when a Worker is
 * constructed; that is a size decision for whoever measures the installer, not one to take blind.
 *
 * xterm: the built library and the fit addon, in both module formats. `.mjs` is what an ES module
 * imports; the UMD `.js` is what a <script> tag would use. Both are kept because the terminal pane
 * is written by someone else and should not have to re-run this script to change its mind.
 *
 * Source maps are left behind deliberately: they are only read by devtools and they point at
 * TypeScript sources that are not vendored, so shipping them would add megabytes to say nothing.
 */
const ITEMS = [
  { pkg: "monaco-editor",     from: "min/vs",              to: "monaco/vs" },
  { pkg: "monaco-editor",     from: "LICENSE",             to: "monaco/LICENSE" },
  { pkg: "@xterm/xterm",      from: "lib/xterm.js",        to: "xterm/xterm.js" },
  { pkg: "@xterm/xterm",      from: "lib/xterm.mjs",       to: "xterm/xterm.mjs" },
  { pkg: "@xterm/xterm",      from: "css/xterm.css",       to: "xterm/xterm.css" },
  { pkg: "@xterm/xterm",      from: "LICENSE",             to: "xterm/LICENSE" },
  { pkg: "@xterm/addon-fit",  from: "lib/addon-fit.js",    to: "xterm/addon-fit.js" },
  { pkg: "@xterm/addon-fit",  from: "lib/addon-fit.mjs",   to: "xterm/addon-fit.mjs" },
  { pkg: "@xterm/addon-fit",  from: "LICENSE",             to: "xterm/addon-fit.LICENSE" },
];

/** Every destination this script owns. Whatever else lands in src/vendor/ is left alone. */
const OWNED = ["monaco", "xterm"];

const fail = (...lines) => {
  for (const line of lines) console.error(line);
  process.exit(1);
};

/** Files and bytes under a path, so the script can report what it actually wrote. */
function measure(path) {
  const st = statSync(path);
  if (!st.isDirectory()) return { files: 1, bytes: st.size };
  let files = 0;
  let bytes = 0;
  for (const entry of readdirSync(path)) {
    const sub = measure(join(path, entry));
    files += sub.files;
    bytes += sub.bytes;
  }
  return { files, bytes };
}

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(2) + " MB";

/** The version actually installed, so the log says what was vendored and not what was asked for. */
function installedVersion(pkg) {
  try {
    return JSON.parse(readFileSync(join(modules, pkg, "package.json"), "utf8")).version;
  } catch {
    return "unknown";
  }
}

// Check everything before writing anything: a tree that is half old and half new is harder to
// diagnose than one that was never written.
const missing = [];
for (const item of ITEMS) {
  if (!existsSync(join(modules, item.pkg, item.from))) missing.push(`${item.pkg}/${item.from}`);
}
if (missing.length) {
  fail(
    `vendor: ${missing.length} source path(s) are not in node_modules:`,
    ...missing.map((m) => `  node_modules/${m}`),
    "",
    "Run `npm install` first. If a path moved, the package layout changed and this script needs",
    "updating - do not guess a replacement, the frontend loads these by exact path.",
  );
}

for (const name of OWNED) rmSync(join(vendor, name), { recursive: true, force: true });

const versions = new Map();
let totalFiles = 0;
let totalBytes = 0;

for (const item of ITEMS) {
  const from = join(modules, item.pkg, item.from);
  const to = join(vendor, item.to);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });

  const { files, bytes } = measure(to);
  totalFiles += files;
  totalBytes += bytes;
  versions.set(item.pkg, installedVersion(item.pkg));
  console.log(`  src/vendor/${item.to}  ${files} file${files === 1 ? "" : "s"}, ${mb(bytes)}  <- ${item.pkg}/${item.from}`);
}

const named = [...versions].map(([pkg, v]) => `${pkg}@${v}`).join(", ");
console.log(`vendor: ${totalFiles} files, ${mb(totalBytes)} into src/vendor/ from ${named}`);
