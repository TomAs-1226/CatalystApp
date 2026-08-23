// Copy the browser tools out of the FrcCatalyst repo into this app's bundled resources.
//
// The app ships its own copy so the tools work with no network — that is most of the point of the
// desktop app. But they were copied by hand and there was no way to copy them again, so they drifted:
// the app was shipping tools two releases behind the ones on the docs site, still describing a
// roboRIO's single CAN bus and a controller that goes on a regulated 12 V output.
//
// A tool that plans wiring is worse than no tool when it plans the wrong hardware, so this exists to
// make the copy repeatable and `npm test` fails when it has not been run.
//
//   npm run sync-tools                 # looks next to this repo for ../FrcCatalyst
//   npm run sync-tools -- path/to/docs/tools
//   npm run sync-tools -- --check      # report drift without writing (what CI runs)

import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dest = join(root, "src", "tools");

const args = process.argv.slice(2);
const check = args.includes("--check");
const given = args.find((a) => !a.startsWith("--"));

const candidates = given
  ? [resolve(given)]
  : [
      resolve(root, "../FrcCatalyst/docs/tools"),
      resolve(root, "../FrcCatalyst-v1.1.0/docs/tools"),
    ];

const source = candidates.find((p) => existsSync(p));
if (!source) {
  // Not an error. A contributor without the library checked out should still be able to build.
  console.log("sync-tools: no FrcCatalyst checkout found, leaving the bundled tools alone");
  console.log("  looked in:", candidates.join(", "));
  process.exit(0);
}

/** The tools the app actually shows. Anything else in the docs folder is not the app's business. */
const BUNDLED = readdirSync(dest).filter((n) => statSync(join(dest, n)).isDirectory());

/** Line endings differ between the two checkouts and mean nothing here. */
const normalise = (s) => s.replace(/\r\n/g, "\n");

const drifted = [];
for (const tool of BUNDLED) {
  const from = join(source, tool, "index.html");
  const to = join(dest, tool, "index.html");
  if (!existsSync(from)) {
    console.warn(`sync-tools: ${tool} is bundled but not in the library — leaving it`);
    continue;
  }
  if (!existsSync(to) || normalise(readFileSync(from, "utf8")) !== normalise(readFileSync(to, "utf8"))) {
    drifted.push(tool);
  }
}

if (check) {
  if (drifted.length) {
    console.error(`sync-tools: ${drifted.length} bundled tool(s) differ from the library: ${drifted.join(", ")}`);
    console.error("Run `npm run sync-tools` to bring them up to date.");
    process.exit(1);
  }
  console.log(`sync-tools: all ${BUNDLED.length} bundled tools match the library`);
  process.exit(0);
}

for (const tool of drifted) {
  const from = join(source, tool);
  const to = join(dest, tool);
  // Replace rather than merge: a file the library deleted has to disappear here too, or the app
  // keeps serving a page nobody maintains any more.
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true });
  console.log(`  updated ${tool}`);
}

console.log(drifted.length
  ? `sync-tools: updated ${drifted.length} of ${BUNDLED.length} tools from ${source}`
  : `sync-tools: all ${BUNDLED.length} tools already match`);
