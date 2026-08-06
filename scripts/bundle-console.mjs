// Copy a built Catalyst Console into this app's bundled resources.
//
// The console is a separate repository with its own release cadence, so it is not a build dependency
// — it is an artefact copied in before packaging. If it is missing the app still builds and simply
// does not offer the button, which is the behaviour a contributor without the console checked out
// wants.
//
//   npm run bundle-console                    # looks next to this repo for ../CatalystConsole
//   npm run bundle-console -- path/to/exe     # or point it at a built binary
//
// Run it before `npm run build`. `npm run build:all` does both.

import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "src-tauri", "resources", "console");

const candidates = process.argv[2]
  ? [resolve(process.argv[2])]
  : [
      resolve(root, "../CatalystConsole/src-tauri/target/release/catalyst-console.exe"),
      resolve(root, "../CatalystConsole/src-tauri/target/debug/catalyst-console.exe"),
    ];

const found = candidates.find((p) => existsSync(p));

if (!found) {
  console.error("No Catalyst Console binary found. Looked in:");
  for (const c of candidates) console.error(`  ${c}`);
  console.error("\nBuild it first:  cd ../CatalystConsole && npm run build");
  console.error("The app will still build without it; it just will not offer the console.");
  process.exit(1);
}

mkdirSync(target, { recursive: true });
copyFileSync(found, join(target, "catalyst-console.exe"));

const mb = (statSync(found).size / 1024 / 1024).toFixed(2);
console.log(`bundled catalyst-console.exe (${mb} MB) from ${found}`);
