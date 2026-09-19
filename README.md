# Catalyst App

The desktop companion for **FrcCatalyst**: it installs the library straight into your robot project
and puts every Catalyst tool in one window, working offline.

**App 2.7.0** · installs **FrcCatalyst 2.0.0-beta.2** · Windows and macOS · built with
[Tauri](https://tauri.app) — a Rust backend and a plain HTML/CSS/JS frontend, no framework. Windows
builds locally; the macOS build runs in CI
([`.github/workflows/build-app.yml`](.github/workflows/build-app.yml)).

**The Catalyst family.** [FrcCatalyst](https://github.com/TomAs-1226/FrcCatalyst) is the library that
runs on the robot. **Catalyst App** installs it and holds the design-time tools.
[Catalyst Console](https://github.com/TomAs-1226/CatalystConsole) is the driver-station dashboard that
watches it run. [Catalyst X1](https://github.com/TomAs-1226/CatalystX1) is team 5805's swerve test
drivebase, where 2.x is being brought up on hardware.

## Before you install 2.x into a robot project

Catalyst 2.0.0-beta.2 is a **pre-season beta**, pinned to a WPILib **alpha**.

| | |
|---|---|
| Requires | WPILib 2027.0.0-alpha-7, Systemcore OS beta 14, Java 25 |
| Beside it | LimelightLib 2.0.0-beta8-alpha7. **Phoenix 6 and PathPlannerLib have no alpha-7 release yet**; the 26.50.0-alpha-1 and 2027.0.0-alpha-3 it compiles against are alpha-5/6 builds |
| Tests | 867, 0 failures |
| Driven on a robot | **never.** The bench runs (a Pigeon on `can_s0`, the onboard IMU, the board's own status topics) were the alpha-6 builds before it, on OS beta 13. Swerve, mechanisms, autos and vision have not been driven. |

The OS pairing is hard rather than advisory: a build made against alpha-7 aborts on Systemcore OS
beta 13 before your robot code runs. Flash the OS first.

**A robot with CTRE motors cannot run this yet.** There is no Phoenix 6 release for WPILib
alpha-7, so on OS beta 14 its motors have nothing to run them. Keep that robot on OS beta 13 with
Catalyst 2.0.0-alpha.3, a source build, which this app does not install. See
[Versions and compatibility](https://tomas-1226.github.io/FrcCatalyst/versions.html).

So put it on an offseason robot, over the offseason, and have the port done before January rather
than during it. **If you are competing, stay on 1.x** — tag `v1.12.0`, WPILib 2026, roboRIO. This app
does not bundle 1.x; that vendordep comes from the
[library's own releases](https://github.com/TomAs-1226/FrcCatalyst/releases).

## Versions and compatibility

| Robot | App |
|---|---|
| Catalyst 1.12.0 on a roboRIO | **App 1.4.3**: branch `main`, release `app-v1.4.3`. This app does not bundle 1.x. |
| Catalyst 2.0.0-alpha.3 on Systemcore OS image 13 (WPILib alpha-6), which is what runs CTRE motors today | This app's tools work; its install button does not help, because it installs beta.1. Add alpha.3 from a source build. |
| Catalyst 2.0.0-beta.2 on Systemcore OS image 14 (WPILib alpha-7) | **App 2.7.0**: this branch, `systemcore`. Not a GitHub release yet. |

The whole map (library, Console, agent, vendor libraries and Systemcore images) is on
[Versions and compatibility](https://tomas-1226.github.io/FrcCatalyst/versions.html).

## What it does

- **Tools** — eleven, bundled and working offline: Builder, Motors, PID Tuner, Motion Magic, Wiring,
  CAN IDs, Aiming, Auto, State Machine, Motor History, Autonomy 2.0. They are the same self-contained
  pages the docs site serves.
- **Install into a project** — pick your GradleRIO project folder; the app checks it really is a
  WPILib project, tells you if Catalyst is already there (and which version), then drops
  `FrcCatalyst.json` into `vendordeps/` from a bundled copy (offline). It fetches LimelightLib in the
  same click. It does not fetch Phoenix 6 or PathPlanner, and for WPILib alpha-7 there is nothing to
  fetch yet: neither has an alpha-7 release, so a robot with CTRE devices cannot use what this
  installs (see above). PhotonVision is not offered at
  all — there is no 2027 build of it.
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

On a machine without the MSVC Build Tools, install them once (~2–4 GB):

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
    index.html              the shell: title bar, rail, one section per view
    js/app.js               the router, the rail, the command palette, the banner
    js/core.js              the bridge to Tauri, settings, the icon set
    js/data.js              the bundled library version, the tools, the changelog
    js/views/<view>.js      one module per view (home, tools, project, library, settings, workspace)
    js/workspace/           the workspace panes: tree, editor, terminal, agent, runner
    js/motion.js            the house springs — a copy of the library's docs/assets/motion.js
    styles/identity.css     the house tokens — a copy of the library's docs/assets/identity.css
    styles/app.css          this app's own layout
    styles/workspace.css    the workspace panes' own styles
    vendor/                 Monaco and xterm, put there by `npm run vendor` (gitignored)
    tools/<tool>/index.html the bundled tools, copied from the library (gitignored drift check in `npm test`)
  src-tauri/                Rust backend
    src/main.rs             the command surface
    src/projects.rs         the project registry, and the write boundary agents are held to
    src/doctor.rs           the project checks · src/vendordeps.rs  what is installed
    src/pty.rs              terminals: the shell, devtools, and the Claude session
    src/workspace.rs        the file tree, reading and writing a project's files
    src/agent.rs            finds the Claude CLI and wires a project for it
    tauri.conf.json         window, bundling, resources
    capabilities/           dialog + scoped-HTTP permissions
    resources/FrcCatalyst.json   the version-locked vendordep that gets installed
    resources/mcp/          the catalyst MCP server an outside agent connects to
    icons/                  app icons
```

The frontend runs in a plain browser too (for quick UI work): `python -m http.server` inside `src/`.
In that mode the tools work and everything that touches the file system is off, and says so, because
it needs the desktop app.

## The workspace

Open a robot project and the app becomes the place you work on it, rather than the place you install
a library and then leave.

- **Files and an editor.** The tree reads one level at a time and never walks `build`, `.git` or
  `node_modules`. The editor is Monaco, vendored into `src/vendor/` — no network, no CDN — themed
  from the same tokens as the rest of the app. Ctrl+S writes through the Rust side, which refuses any
  path outside a registered project.
- **A terminal, and your own build.** The dock runs a real PTY. Its Build tab runs
  `devtools gradle -- build` and `devtools gradle -- deploy` with the project as the working
  directory, which is what this machine's devtools expects. Deploy asks first, every time.
- **Claude Code, already pointed at the project.** The Claude pane starts the CLI in the project
  folder. "Set this project up" writes two files into it: a `.mcp.json` entry for the bundled Catalyst
  MCP server (merged — another team's servers are left alone), and a `CLAUDE.md` if there isn't one.
  So the session starts knowing the Catalyst 2.x API, the project's own structure, and how it builds.
  Authentication comes from the desktop app, so this is a real interactive session, not `claude -p`.

Nothing in the workspace reaches outside a project the registry knows about: the same boundary the
MCP server has always had, applied to the app's own editor.

## Updating the bundled library

The app ships one version of `FrcCatalyst.json` (currently **2.0.0-beta.2**). To cut a new app release that
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

Eighteen tools. Seven of them answer a design question straight out:

| Tool | What it does |
|---|---|
| `catalyst_motor_specs` | Look up any MotorType's specs (Kraken, Falcon, NEO, Minion…). |
| `catalyst_gear_calc` | Output speed and torque through a gear reduction. |
| `catalyst_build_mechanism` | Generate ready-to-paste Java for a mechanism config. |
| `catalyst_can_conflicts` | Check a CAN device list for duplicate IDs (per bus). |
| `catalyst_graph_search` | Search the Catalyst knowledge graph by name. |
| `catalyst_graph_neighbors` | See what a class or concept connects to. |
| `catalyst_graph_overview` | A map of the library: core abstractions and areas. |

The other eleven read graphs, docs, registered projects and source. They arrived in 2.3.0 and 2.4.0
and are described in those sections below.

The **Connect an AI agent** page in the app shows the exact config to paste (with the real bundled
server path resolved at runtime):

```json
{ "mcpServers": { "catalyst": { "command": "node", "args": ["<bundled>/resources/mcp/server.js"] } } }
```

**The bundled knowledge graph** (`resources/mcp/data/graph.json`) is distilled from graphify and ships
with each app version — reachable only through the agent server, never shown in the UI. Honest scope:
it is a plain file on disk, so this is *"not surfaced in the app,"* not cryptographically secret. True
secrecy would require hosting it behind an online API instead of bundling it.

## Roadmap

- ~~Phase 1 — Shell + tools + repo installer~~ ✅
- ~~Phase 2 — Auto-update (app + library), offline-graceful~~ ✅
- ~~Phase 3 — AI-agent connector (bundled MCP server + agent-only knowledge graph)~~ ✅

## Motor History tool (2.1.0)

Fetches the robot program's motor history off the Systemcore (`catalyst-agent` 2.0.3 on port
9010) and shows every motor by serial number: lifetime powered, turning and loaded hours,
revolutions, peak current and temperature, hot time, boots, and every id, name and firmware the
motor has ever carried. **Save JSON** keeps the file as the robot wrote it; **Save CSV** is one row
per device for a spreadsheet. Also opens a saved file, so the history of a robot that is not on
the bench can still be read. The page itself lives in the FrcCatalyst docs (`docs/tools/history`)
like the other tools and is synced in at build time.

## Autonomy 2.0 Planner (2.2.0)

Assemble the robot's autonomy logic and see what it will actually do before deploying it. Add tasks
with a score and the mechanisms they need, and the planner runs the same greedy rule `TaskArbiter`
runs on the robot: which tasks win, which are held, and which resource each loser lost. The conflict
matrix answers the question worth asking before a competition - can these two behaviours *ever* run
together, or does everything need the drivetrain so nothing shares the robot.

The Power tab does the same for `ShedCore`: give each mechanism a limit, a floor and a priority, ask
for some amps back, and see what gets shed and what the floors refuse to give. The floor is the
current a mechanism needs just to hold its load, and the planner shows a shortfall rather than
pretending an elevator can be shed to nothing.

The Code tab emits ready-to-paste Catalyst. Watching it run live is the Console's job - it holds the
NetworkTables connection and its **Autonomy** tile shows the real decisions on the same schema.

## MCP server 2.0 (app 2.3.0)

The bundled MCP server grew from 7 tools to 12, and from "search a graph we shipped" to "understand
any codebase". An agent can now build a graphify knowledge graph for a project
(`catalyst_graph_build` - structural AST pass, no LLM, no token cost), then ask it where something
lives, what it connects to, how two things are related, and what a file reaches outside itself,
before reading a single line of source. The graph tools take the bundled Catalyst graph, any
project's `graphify-out/graph.json`, or a path, through one normalising reader, so an agent never
has to know which shape it is holding.

The bundled Catalyst graph was refreshed to the current library - it was still describing v1.7.0 and
knew nothing about Commands v3 or the autonomy package - and its areas are now named by Java package
rather than by whichever method happened to be a cluster hub.

Two fixes worth naming. The server directory now declares `"type": "commonjs"`, without which
`require` fails whenever the server runs from the repository rather than an installed app. And
graphify's own MCP server, which this complements rather than replaces, fails to start on a stock
install with `ModuleNotFoundError: No module named 'mcp'`; this one has no dependency that can be
missing.

## Projects, and agent access to your code (app 2.4.0)

A **Projects** page. Import a robot project once and Catalyst remembers it: where it is, which
Catalyst version and WPILib season it uses, and any note you leave on it. Come back a week later and
it is still there.

The point is the second half. That registry is a JSON file in the app's data directory, and the
bundled MCP server reads the same file, so an AI agent can find your code without being told where
it is. It can read a registered project immediately. It can **write** only where you have switched
*let agents write* on, per project, and that switch defaults to off.

The rules are deliberately few and live in one place. A path must resolve inside a registered
project root; containment is checked against the resolved real path, so `..` and symlinks are caught
by the same test rather than by special cases. The project's write switch must be on. And `.git`,
`build`, `target`, `node_modules`, `.gradle` and `graphify-out` are refused even inside a granted
project. Everything else the server does — the graph, the Catalyst tools, reading source — needs
none of this.

Editing goes through an exact-text replace that refuses when the text is missing or appears more
than once, because an ambiguous edit is the one that silently lands somewhere you did not mean.

The registry lives in localStorage's place for a reason: localStorage belongs to the webview, and
the MCP server is a separate Node process that cannot see it.
