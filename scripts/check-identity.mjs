// The house stylesheet is copied, not imported, so it can drift — and it already did once with the
// bundled tools, which is why `sync-tools --check` exists. This is the same check for the identity.
//
//   node scripts/check-identity.mjs            # report drift, exit 1 if there is any
//   node scripts/check-identity.mjs --write    # copy the library's originals over ours
//   node scripts/check-identity.mjs path/to/docs/assets
//
// With no library checkout on the machine it says so and exits 0: a contributor without the library
// should still be able to build, and a check nobody can act on gets ignored.

import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const write = args.includes("--write");
const given = args.find((a) => !a.startsWith("--"));

// The 2.0 line first, for the same reason sync-tools prefers it: it is the line this app ships.
const candidates = given
  ? [resolve(given)]
  : [
      resolve(root, "../_worktrees/FrcCatalyst-systemcore/docs/assets"),
      resolve(root, "../FrcCatalyst/docs/assets"),
      resolve(root, "../FrcCatalyst-v1.1.0/docs/assets"),
    ];

const FILES = [
  ["identity.css", join("src", "styles", "identity.css")],
  ["motion.js", join("src", "js", "motion.js")],
];

const source = candidates.find((p) => FILES.every(([name]) => existsSync(join(p, name))));
if (!source) {
  console.log("check-identity: no FrcCatalyst checkout found, leaving the identity alone");
  console.log("  looked in:", candidates.join(", "));
  process.exit(0);
}

let drifted = 0;
for (const [name, rel] of FILES) {
  const from = join(source, name);
  const to = join(root, rel);
  const theirs = readFileSync(from, "utf8");
  const ours = existsSync(to) ? readFileSync(to, "utf8") : null;
  if (ours === theirs) continue;
  drifted++;
  if (write) {
    copyFileSync(from, to);
    console.log(`check-identity: copied ${name} from ${source}`);
  } else {
    console.error(`check-identity: ${rel} differs from ${from}`);
  }
}

if (!drifted) {
  console.log(`check-identity: identity matches ${source}`);
} else if (!write) {
  console.error("Run `npm run identity` to copy the library's originals over these.");
  process.exit(1);
}
