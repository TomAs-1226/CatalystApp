# Catalyst desktop app

A small cross-platform (Windows / Mac) companion app for **FrcCatalyst**, built with [Tauri](https://tauri.app).
It puts every Catalyst tool in one window and installs the library straight into your robot project.

> **App v1.4.1**, bundling **FrcCatalyst v1.5.0** (Physics Core) — feature-complete: tools,
> installer, offline auto-update, the AI-agent connector, and a
> full settings page. Windows builds locally; the macOS build runs in CI (see
> [`.github/workflows/build-app.yml`](.github/workflows/build-app.yml)).

## What it does

- **Tools** — the Builder, MotorType browser, PID tuner, Motion Magic, Wiring, CAN IDs, Aiming, Auto,
  and State Machine visualizer, all bundled and working offline (the same self-contained tools from
  the docs site, with the app's sleek scrollbar injected into each).
- **Install into a project** — pick your GradleRIO project folder; the app checks it really is a
  WPILib project, tells you if Catalyst is already there (and which version), then drops
  `FrcCatalyst.json` into `vendordeps/` from a bundled copy (offline). It can also fetch the three
  required vendordeps (Phoenix 6, PathPlanner, PhotonVision) in the same click.
- **Auto-update** — offline-graceful checks for a newer app *and* a newer library, with an
  ask / auto / manual setting. See [Auto-update](#auto-update-phase-2).
- **AI-agent connector** — a bundled MCP server exposing the tools and a distilled knowledge graph to
  agents. See [AI-agent connector](#ai-agent-connector-phase-3).
- **Full settings** — accent color (applies live), startup page, install defaults, GitHub/docs links,
  and reset. Plus a **What's New** changelog page and a **Recent projects** list on Home.

## Build / run

### Prerequisites

| Need | Status on this machine | Get it |
|---|---|---|
| **Node** (for the Tauri CLI) | ✅ installed (v24) | — |
| **Rust** (`cargo`) | ✅ installed (1.97) | — |
| **WebView2 runtime** | ✅ installed | ships with Windows 11 |
| **MSVC C++ Build Tools** (the linker) | ✅ installed (14.44 + Win SDK) | `winget install Microsoft.VisualStudio.2022.BuildTools` with the VCTools workload |

All prerequisites are in place; `npm run build` produces the installers under
`src-tauri/target/release/bundle/`. Note: with `createUpdaterArtifacts` on, a local build prompts once
for the updater-key password — set `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (empty if the key has none) or
let CI produce the signed updater artifacts.
Install it once (this is a one-time, ~2–4 GB setup):

```bash
winget install --id Microsoft.VisualStudio.2022.BuildTools --override "--quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

(Or download "Build Tools for Visual Studio 2022" and check the **Desktop development with C++** workload.)

### Run it

```bash
npm install       # already done — installs the Tauri CLI
npm run dev        # launches the app with hot reload
npm run build      # produces an installer in src-tauri/target/release/bundle/
```

## Project layout

```
CatalystApp/
  src/                      frontend (vanilla HTML/CSS/JS — no build step)
    index.html              the shell
    app.js                  nav + installer logic (uses window.__TAURI__)
    styles.css              Catalyst brand (dark navy + coral)
    tools/<tool>/index.html the 9 bundled tools
  src-tauri/                Rust backend
    src/main.rs             commands: detect_project, read_bundled_vendordep, write_vendordep
    tauri.conf.json         window, bundling, resources
    capabilities/           dialog + scoped-HTTP permissions
    resources/FrcCatalyst.json   the version-locked vendordep that gets installed
    icons/                  app icons
```

The frontend runs in a plain browser too (for quick UI work): `python -m http.server` inside `src/`.
In that mode the tools work and the install step is disabled (it needs the desktop app's filesystem access).

## Updating the bundled library

The app ships one version of `FrcCatalyst.json` (currently **v1.3.3**). To cut a new app release that
installs a newer library, drop the new `FrcCatalyst.json` into `src-tauri/resources/`, bump the version
in `tauri.conf.json` + `package.json` + `Cargo.toml`, and rebuild.

## Auto-update (Phase 2)

The **Updates** page keeps two things current, and both checks are best-effort — they skip quietly
when you are offline (nothing errors, the status just reads "Offline"):

- **This app** — uses the Tauri updater plugin. On launch (unless the mode is "manual") it checks the
  endpoint in `tauri.conf.json` for a newer signed build; if found it offers to download, install, and
  relaunch.
- **The FrcCatalyst library** — fetches the live vendordep from the docs site and compares its version
  to the copy bundled in the app. If a newer library exists, it says so and points you at the install
  page.

An **update mode** setting (persisted) controls the behaviour: *auto-install*, *ask first* (default),
or *only when I check here*.

### Publishing an app update

The updater verifies a signature, so releases must be signed with the private key generated in
`.keys/` (keep it secret — it is gitignored). The matching public key is already in `tauri.conf.json`.

```bash
# sign the build (set the key path + password, then build)
export TAURI_SIGNING_PRIVATE_KEY="$(cat .keys/catalyst-updater.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
npm run build
```

`tauri build` then emits the installer plus a `.sig` file and a `latest.json` manifest. Publish
`latest.json` (and the installer) at the endpoint URL in `tauri.conf.json`
(`https://tomas-1226.github.io/FrcCatalyst/app/latest.json`). Bump the version in `tauri.conf.json`,
`package.json`, and `Cargo.toml` for each release; to ship a newer library too, drop the new
`FrcCatalyst.json` into `src-tauri/resources/` first.

## AI-agent connector (Phase 3)

The app bundles a small **MCP server** (`src-tauri/resources/mcp/server.js`) so AI agents — Claude
Desktop, Claude Code, Cursor — can use Catalyst's tools and query its knowledge graph, cleanly and in
order. It is **dependency-free and offline**: no npm packages, no network. It speaks newline-delimited
JSON-RPC 2.0 over stdio and reads its data from `resources/mcp/data`.

Seven tools:

| Tool | What it does |
|---|---|
| `catalyst_motor_specs` | Look up any MotorType's specs (Kraken, Falcon, NEO, Minion…). |
| `catalyst_gear_calc` | Output speed and torque through a gear reduction. |
| `catalyst_build_mechanism` | Generate ready-to-paste Java for a mechanism config. |
| `catalyst_can_conflicts` | Check a CAN device list for duplicate IDs (per bus). |
| `catalyst_graph_search` | Search the Catalyst knowledge graph by name. |
| `catalyst_graph_neighbors` | See what a class or concept connects to. |
| `catalyst_graph_overview` | A map of the library: core abstractions and areas. |

The **Connect an AI agent** page in the app shows the exact config to paste (with the real bundled
server path resolved at runtime):

```json
{ "mcpServers": { "catalyst": { "command": "node", "args": ["<bundled>/resources/mcp/server.js"] } } }
```

**The bundled knowledge graph** (`resources/mcp/data/graph.json`) is distilled from graphify and ships
with each app version — reachable only through the agent server, never shown in the UI. Honest scope:
it is a plain file on disk, so this is *"not surfaced in the app,"* not cryptographically secret. True
secrecy would require hosting it behind an online API instead of bundling it.

The server is tested end-to-end with a stdio harness (`initialize` → `tools/list` → `tools/call` for
every tool): **14/14 checks pass**.

## Roadmap

- ~~Phase 1 — Shell + tools + repo installer~~ ✅
- ~~Phase 2 — Auto-update (app + library), offline-graceful~~ ✅
- ~~Phase 3 — AI-agent connector (bundled MCP server + agent-only knowledge graph)~~ ✅
- **Next** — compile a signed Windows build (needs the MSVC Build Tools), then a Mac build via CI.
