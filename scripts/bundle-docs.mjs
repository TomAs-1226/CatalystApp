// Bundle the FrcCatalyst documentation into the MCP server's data directory.
//
// An agent writing Catalyst code needs Catalyst's docs, and it usually has the *robot* project open,
// not the library. So the docs travel with the app rather than being read from a checkout that may
// not be on the machine at all.
//
// One JSON file rather than 30 markdown files: the server answers a search by scanning it once, with
// no directory walking and no per-page reads. 485 KB of markdown becomes a file the server loads in
// a few milliseconds and keeps.
//
//   node scripts/bundle-docs.mjs                 # looks next to this repo for the library
//   node scripts/bundle-docs.mjs path/to/docs
//
// Run by `npm run build`. With no library checkout it leaves the bundled copy alone and says so,
// the same way sync-tools does, so a build on a machine without the library still succeeds.

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dest = join(root, "src-tauri", "resources", "mcp", "data", "docs.json");

const given = process.argv.slice(2).find((a) => !a.startsWith("--"));
// The 2.0 line first, for the same reason sync-tools looks there first: this app ships 2.x, and the
// library keeps its 2027 work on the `systemcore` branch, which on this machine is a worktree beside
// the repo. A 1.x checkout is still a fallback rather than an error, so without this a plain
// `npm run build` quietly rebuilt the bundle from 1.x docs and shipped an MCP server that answers an
// agent writing 2.x code with the 1.12.0 API — no SubsystemBase, ChassisSpeeds and getFPGATimestamp
// are exactly what changed between the lines, so the wrong bundle is wrong about the things it is
// asked about most, and nothing in the build says so.
//
// The names above went stale exactly as predicted, and the prediction did not help: the 2.x worktree
// was renamed, `FrcCatalyst-systemcore` stopped existing, and a routine `npm run build` silently
// rebuilt the bundle from the 1.x docs — shipping an MCP server that answers an agent writing 2.x code
// with the 1.12.0 API. The list is only half the fix; a list can always go stale again. So a 1.x
// fallback is now LOUD, and refuses outright under CI.
const candidates = given
  ? [resolve(given)]
  : [
      // The 2.x line that ships. `systemcore-alpha6` was merged into `upgrade/alpha-7` on 2026-09-25.
      resolve(root, "../_worktrees/FrcCatalyst-alpha7/docs"),
      resolve(root, "../_worktrees/FrcCatalyst-alpha6/docs"),
      // Legacy worktree names, kept for a machine checked out before the consolidations.
      resolve(root, "../_worktrees/FrcCatalyst-systemcore/docs"),
      // 1.x, last: correct only if there is genuinely no 2.x checkout here.
      resolve(root, "../FrcCatalyst/docs"),
      resolve(root, "../FrcCatalyst-v1.1.0/docs"),
    ];
const source = candidates.find((p) => existsSync(p));

if (!source) {
  console.log("bundle-docs: no FrcCatalyst checkout found, leaving the bundled docs alone");
  console.log("  looked in:", candidates.join(", "));
  process.exit(0);
}

// `v1.1.0` and a bare `FrcCatalyst` are the 1.x checkouts. Bundling from one while the app installs a
// 2.x library is the specific mistake this script has now made once, so say so unmissably.
const isOneX = /FrcCatalyst(-v1[.\d]*)?[\\/]docs$/.test(source) && !source.includes("_worktrees");
if (isOneX) {
  console.warn("");
  console.warn("  bundle-docs: WARNING - bundling from a 1.x checkout:");
  console.warn("    " + source);
  console.warn("  The app installs a 2.x library, so the bundled MCP docs would describe the wrong API:");
  console.warn("  no SubsystemBase, ChassisSpeeds vs ChassisVelocities, getFPGATimestamp vs getTimestamp");
  console.warn("  are exactly what an agent asks about, and it would be confidently wrong about all three.");
  console.warn("  Set CATALYST_DOCS_DIR to a 2.x docs folder, or check out the 2.x worktree.");
  console.warn("");
  if (process.env.CI) {
    console.error("bundle-docs: refusing to bundle 1.x docs under CI");
    process.exit(2);
  }
}

/** Every .md under the docs tree, excluding the tool pages (they are apps, not prose). */
function walk(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "assets" || e.name === "_includes" || e.name === "vendordep") continue;
      walk(p, acc);
    } else if (e.name.endsWith(".md")) {
      acc.push(p);
    }
  }
  return acc;
}

/** Front matter gives a real title; fall back to the first heading, then the filename. */
function parse(file) {
  const raw = readFileSync(file, "utf8");
  let body = raw;
  let title = null;

  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (fm) {
    const t = fm[1].match(/^title:\s*(.+)$/m);
    if (t) title = t[1].trim().replace(/^["']|["']$/g, "");
    body = raw.slice(fm[0].length);
  }
  if (!title) {
    const h = body.match(/^#\s+(.+)$/m);
    title = h ? h[1].trim() : file.split(/[\\/]/).pop().replace(/\.md$/, "");
  }

  // Headings make a cheap table of contents an agent can scan before pulling a whole page.
  const headings = [...body.matchAll(/^(#{2,4})\s+(.+)$/gm)]
    .map((m) => m[2].trim().replace(/\{:.*?\}\s*$/, "").trim())
    .filter((h) => h && !/^table of contents$/i.test(h));

  return { path: relative(source, file).replace(/\\/g, "/"), title, headings, body: body.trim() };
}

const pages = walk(source).map(parse).sort((a, b) => a.path.localeCompare(b.path));

// The library version these docs describe, so the server can say what it is quoting.
let version = "unknown";
const gradle = resolve(source, "..", "build.gradle");
if (existsSync(gradle)) {
  const m = readFileSync(gradle, "utf8").match(/^version\s*=\s*['"](.+?)['"]/m);
  if (m) version = m[1];
}

mkdirSync(dirname(dest), { recursive: true });
writeFileSync(dest, JSON.stringify({
  libraryVersion: version,
  generated: new Date().toISOString().slice(0, 10),
  source: relative(root, source).replace(/\\/g, "/"),
  pages,
}), "utf8");

const bytes = statSync(dest).size;
console.log(`bundle-docs: ${pages.length} pages, ${(bytes / 1024).toFixed(0)} KB, `
  + `documenting FrcCatalyst ${version}`);
