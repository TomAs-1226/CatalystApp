# AGENTS.md: CatalystApp

Instructions for AI coding agents working in this repo: Claude Code, and whatever model runs
when Claude isn't available. For humans, `README.md` is the guide.

## What this is

The Catalyst desktop app, a Tauri 2 app. It installs the FrcCatalyst library into robot projects,
ships the library's browser tools so they work offline, and carries the `catalyst` MCP server that
AI agents use. Active work is on `systemcore` (the 2027 port); `main` is the 2026 line. Run
`git branch --show-current` before anything else.

| Path | What it is |
|---|---|
| `src/` | Frontend: vanilla HTML/CSS/JS with no build step |
| `src/index.html`, `src/js/` | The shell (`js/app.js` router, rail, palette), the views (`js/views/`) and the workspace panes (`js/workspace/`) |
| `src/styles/identity.css` | **A copy** of FrcCatalyst's `docs/assets/identity.css` — the house tokens. Don't edit it here |
| `src/styles/app.css` | This app's own layout, on top of the identity |
| `src/vendor/` | Monaco and xterm, copied out of node_modules by `npm run vendor` (gitignored) |
| `src/tools/<tool>/index.html` | **Copies** of FrcCatalyst's `docs/tools/`. Don't edit them here |
| `src-tauri/` | Rust backend (`main.rs`, `projects.rs`, `doctor.rs`, `vendordeps.rs`, and the workspace's `pty.rs`, `workspace.rs`, `agent.rs`) and `tauri.conf.json` |
| `src-tauri/resources/FrcCatalyst.json` | The version-locked vendordep the app installs |
| `src-tauri/resources/mcp/` | The catalyst MCP server: `server.js` (dependency-free Node), `build_graph.py`, `data/graph.json`, `data/docs.json` |
| `src-tauri/resources/console/` | A built Catalyst Console, copied in by `npm run bundle-console` (gitignored) |
| `scripts/` | The sync and bundle scripts |

## Commands

- `npm install` once, then `npm run vendor` to put Monaco and xterm in `src/vendor/`.
- `npm test` checks that the bundled tools match the library (`sync-tools --check`), then runs
  `node --test "src/**/*.test.js"`.
- `npm run harness` serves the real `src/` with a stubbed `window.__TAURI__` whose file commands read
  the disk for real and whose writes do nothing — the way to look at the workspace, the editor and
  the panes in a browser, since outside the desktop app every command rejects by design.
  `npm run harness -- src <project dir> <port>` picks the project it opens.
- `npm run dev` runs the app with hot reload. `npm run build` syncs the tools, bundles the console
  and docs, then runs `tauri build`.
- Refreshing copies from sibling checkouts (`../FrcCatalyst` or `../FrcCatalyst-v1.1.0`, and
  `../CatalystConsole`): `npm run sync-tools`, `node scripts/bundle-docs.mjs`, `npm run bundle-console`.

## Invariants

- **Tools.** Edit them in the FrcCatalyst repo (`docs/tools/<tool>/index.html`), then run
  `npm run sync-tools` here. `npm test` fails while the copies have drifted. The sync looks for the
  2.0 line first (`../_worktrees/FrcCatalyst-systemcore`), because that is the line this app ships.
- **The identity.** `src/styles/identity.css` and `src/js/motion.js` are copies of the library's
  `docs/assets/` originals, shared with Catalyst Console. Change them there and copy them across;
  a colour, a corner or a curve invented in `app.css` is the thing this file exists to prevent.
- **Nothing is fetched at run time.** Monaco and xterm are devDependencies vendored into
  `src/vendor/` by `scripts/vendor.mjs`. The app must keep working with no network — that is most
  of the point of it — so never add a runtime dependency or a CDN link.
- **The terminal's first moment.** On Windows the PTY child does not start until the terminal
  answers a cursor-position query, so a pane must have `listen('pty://data', ...)` and its
  `onData -> pty_write` wiring in place *before* it awaits `pty_open`. Attach the listener late and
  the pane hangs blank with no error. Measured against ConPTY; see `src-tauri/src/pty.rs`.
- **Writing into a project.** `ws_write` and `agent_prepare` refuse any path outside a folder in the
  projects registry. That is the same boundary the MCP server uses; don't add a second one.
- **Version.** Bump `tauri.conf.json`, `package.json` and `src-tauri/Cargo.toml` together. The UI
  reads the version from Rust (`app_version()`). Never reintroduce a hand-kept version constant in
  JS; the last one said 2.0.0 for four releases.
- **Bundled library.** The vendordep is pinned on purpose. Neither the app nor its changelog may
  advertise library features the bundled version doesn't have.
- **Project registry.** The app (`src-tauri/src/projects.rs`) writes `projects.json` and the MCP
  server reads it. Each computes the path on its own, so a change to one must be mirrored in the
  other. The registry is the MCP server's write-permission boundary; don't loosen its checks.
- **`src-tauri/resources/mcp/package.json`** exists only to set `"type": "commonjs"`. The app's own
  `package.json` is ESM, so without that file `require` throws.
- **Signing.** `.keys/` holds the updater signing key. Never read, print, copy or commit anything in
  it. Releases are signed builds published for the updater; leave them to the user.

## Docs

The README is the app's documentation. Keep the per-release sections and the "Project layout" tree
accurate to the code. Library docs live in the FrcCatalyst repo, not here.

## Git and files

- Don't commit, push, tag or release unless the user asks for it in the current session.
- `origin` is GitHub only for now, because Forgejo mirroring hasn't been added to this repo yet.
- Files are UTF-8 without a BOM. In Windows PowerShell 5.1, don't round-trip them through
  `Get-Content` / `Set-Content`: that adds a BOM or garbles `—` and `·`. Use an editor tool, or .NET
  `ReadAllText` / `WriteAllText`.

## If you are a fallback model

Fine to take on: README edits, version bumps across the three files (prove them with `npm test`),
and re-running the sync scripts.

Stop and leave notes for Claude on: Rust changes, the MCP server's permission logic, the updater and
signing, and releases.
