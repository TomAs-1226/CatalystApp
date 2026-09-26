// What the app knows that is not code: the version it bundles, the tools it ships, the vendor
// libraries it can fetch, and the release history. Facts only — no behaviour lives here.

/*
 * The app's own version is read from the binary at startup, not written here. Keeping a copy in sync
 * with tauri.conf.json by hand failed exactly the way that always fails — the About page claimed
 * 2.0.0 through four releases. The fallback below is only for running the UI in a plain browser,
 * where there is no binary to ask.
 */
export const APP_VERSION_FALLBACK = "dev";

// The FrcCatalyst version bundled inside this app. It must equal the `version` in
// src-tauri/resources/FrcCatalyst.json, which is the file actually written into a project — this
// constant only labels it.
export const LIB_VERSION = "2.0.0-beta.2";
export const LIB_FRC_YEAR = "2027";

// The feed for the line this build is on. Pointing at the stable vendordep would have meant a 2.x
// app watching the 1.x release line: it would never learn that a new 2.0.0 alpha had shipped, and
// would sit reporting "up to date" for the whole beta.
export const LIB_VENDORDEP_URL = "https://tomas-1226.github.io/FrcCatalyst/beta/vendordep/FrcCatalyst.json";

export const TOOLS = [
  { id: "builder", name: "Builder", desc: "Generate ready-to-paste mechanism config code." },
  { id: "motors", name: "Motors", desc: "Every MotorType preset and a gear-ratio calculator." },
  { id: "pid", name: "PID Tuner", desc: "Tune PID gains against a live response sim." },
  { id: "motion", name: "Motion Magic", desc: "Plan Motion Magic velocity and accel profiles." },
  { id: "wiring", name: "Wiring", desc: "CAN bus and power wiring reference." },
  { id: "canids", name: "CAN IDs", desc: "Lay out CAN IDs across five buses and catch conflicts." },
  { id: "aiming", name: "Aiming", desc: "Shoot-on-the-move aiming solver." },
  { id: "auto", name: "Auto", desc: "Sketch an autonomous routine." },
  { id: "statemachine", name: "State Machine", desc: "Paste your graph and see the states." },
  { id: "history", name: "Motor History", desc: "Every motor's hours, peaks and past names, pulled off the robot." },
  { id: "autonomy", name: "Autonomy 2.0", desc: "Plan the logic, see what will actually run, take the code." },
  { id: "driverconfig", name: "Driver Config", desc: "Sticks, buttons and rumble for each driver, written into your robot project." },
];

/*
 * Vendor libraries Catalyst builds against.
 *
 * `url` means the 2027 vendordep is published at a stable address and can be fetched. `manual` means
 * it is not, and the app says so instead of guessing.
 *
 * That distinction matters more than it looks. Phoenix 6 26.70.0-alpha-2 is the first build for
 * WPILib alpha-7 and is what a CTRE robot needs, but CTRE publishes no 2027 vendordep JSON at a
 * discoverable URL — and PathPlanner's canonical PathplannerLib.json still reports frcYear 2026.
 * Fetching either into a 2027 project would write a file that looks installed and fails at build
 * time, which is a worse outcome than telling someone to add it from VS Code's vendor library list,
 * so that is what this does.
 *
 * PathPlanner is marked optional rather than needed. Catalyst depends on it `compileOnly`, so it
 * never reaches a robot's classpath: a robot project needs neither its vendordep nor 3015's maven
 * repository, and asking for it would be asking for a repository nobody has a use for.
 *
 * PhotonVision is gone entirely: there is no 2027 build, and Catalyst is Limelight-first on
 * Systemcore because the pipeline is built into the hardware.
 */
export const DEPS = [
  { file: "LimelightLib.json", name: "LimelightLib", url: "https://limelightvision.github.io/limelightlib-public/LimelightLib.json" },
  { name: "Phoenix 6", manual: "Add 26.70.0-alpha-2 or later from VS Code: Manage Vendor Libraries → Install new libraries (online). It needs 26.70.x firmware on every TalonFX, CANcoder and Pigeon." },
  { name: "PathPlanner", optional: true, manual: "Optional — Catalyst depends on it compileOnly, so it never reaches your robot's classpath. Add it from VS Code only if your own code uses it." },
];

export const LINKS = [
  ["GitHub", "https://github.com/TomAs-1226/FrcCatalyst"],
  ["Documentation", "https://tomas-1226.github.io/FrcCatalyst/"],
  ["Report an issue", "https://github.com/TomAs-1226/FrcCatalyst/issues"],
];

export const AGENT_CAPS = [
  ["catalyst_motor_specs", "Look up any MotorType's specs (Kraken, Falcon, NEO, Minion…)."],
  ["catalyst_gear_calc", "Output speed and torque through a gear reduction."],
  ["catalyst_build_mechanism", "Generate ready-to-paste Java for a mechanism config."],
  ["catalyst_can_conflicts", "Check a CAN device list for duplicate IDs."],
  ["catalyst_docs_search", "Search the bundled Catalyst documentation."],
  ["catalyst_graph_overview", "A map of a codebase: its size, its areas, and what everything hangs off."],
  ["catalyst_graph_search", "Find where something lives, by name, with its file and line."],
  ["catalyst_graph_neighbors", "What a class or method connects to, grouped by relation."],
  ["catalyst_graph_path", "How two things are related: the shortest chain between them."],
  ["catalyst_graph_file", "What a file defines and what it reaches outside itself."],
  ["catalyst_graph_build", "Build a graphify graph for any project. Structural, no LLM, no token cost."],
  ["catalyst_source_search", "Regex across the source with context, once the graph says where to look."],
  ["catalyst_source_read", "Read a file, or just the part around one symbol."],
  ["catalyst_projects", "Your imported projects: where they are, and whether writing is allowed."],
  ["catalyst_project_files", "List a project's source files without walking the disk."],
  ["catalyst_write_file", "Write a file — only inside a project you have switched writing on for."],
  ["catalyst_edit_file", "Replace exact text in a file, refusing anything ambiguous."],
];

export const CHANGELOG = [
  { v: "2.8.0", t: "The wiring tool plans ports, and draws the loom", date: "2026-09-22", items: [
    "Wiring is a planner now, not a diagram. Pick the channel every device sits in — the board's own numbering — and get a run list naming both ends of every run: PDH 7 to BR Steer, MPM F0 to LEDs, with the gauge, the length and the voltage drop. You could not wire from the old picture, because it never said which channel anything went in.",
    "Breakouts are first-class. An MPM, VRM, RPM or Servo Hub takes a channel on the main board and provides its own, and a device goes into one the same way it goes into the board. A device that needs regulated power will only go where regulated power exists.",
    "The drawing shows the loom: a terminal pad per channel, runs in their own lanes at a stroke width that tracks the gauge, and breakout feeds leaving to the left toward the board they power. CAN is drawn as the daisy chain it is rather than a rail with taps.",
    "Six times the devices — brushed motors and the controllers they need, Talon FXS and SRX, Thrifty Nova, CANrange, CANifier, Limelight cameras, switches, servos, limit switches, analog and quadrature inputs.",
    "The tool used to attribute a regulator recommendation, a connector name and a wire gauge to Limelight, and none of the three is in any Limelight or WPILib document. The advice stays — a controller that browns out mid-match is not a mistake worth inheriting from a diagram — but it now reads as something to confirm against your hardware."] },
  { v: "2.7.0", t: "One identity, a workspace, and Catalyst 2.0.0-beta.2", date: "2026-09-19", items: [
    "Installs Catalyst 2.0.0-beta.2: a top speed for a robot aiming while it drives, a slip-current measurement that tells a wheel carrying no weight from a robot that is rolling, and three fixes. All of it measured on a robot this week.",
    "The app, the Console, the tools and the docs now share one set of colours, type, corners and motion — the launch identity, as tokens. Status colours mean status and nothing else.",
    "A workspace: open your robot project and get its files, an editor, a terminal wired to devtools, and a Claude Code session that already knows the project and the Catalyst API.",
    "Six places in the sidebar instead of twenty. Tools are one grid, Doctor and Vendordeps are two tabs of Project health, and Install, the release notes and Updates are three tabs of Library."] },
  { v: "2.6.1", t: "Catalyst 2.0.0-beta.1, and one look across all three", date: "2026-09-09", items: [
    "Installs Catalyst 2.0.0-beta.2. The old notice told you to wait for WPILib alpha-7 before the newer features were installable — alpha-7 arrived, so everything the app advertises is in the version it installs.",
    "It needs WPILib 2027 alpha-7 and Systemcore OS beta 14, and that pairing is not optional: a build made against alpha-7 aborts on beta 13 before your robot code runs. Flash the OS first.",
    "The app, the Console and the docs site now share one set of colours, spacing and type. Status colours mean status and nothing else, and numbers that change no longer shift width as they do."] },
  { v: "2.6.0", t: "Import a project as it is", date: "2026-09-07", items: [
    "Import an existing robot project without installing anything into it. Catalyst reads it and says what it found: which Catalyst version it builds against, where that library comes from, and what else is in vendordeps.",
    "It now names a pre-release or a hand-edited install rather than reporting a version and leaving you to find out.",
    "Your AI agent gets the same reading, plus the Catalyst documentation — 31 pages it can search and quote.",
    "The agent re-reads the documentation when Catalyst updates it. Its server is a long-running process and loaded the docs once, so a session that started before an update kept quoting the old ones.",
    "Your project list is now kept twice. Losing it loses every folder you imported and every permission you granted; if the live copy is ever gone or unreadable, Catalyst puts the last good one back."] },
  { v: "2.5.0", t: "Version drift, fixed at the root", date: "2026-09-07", items: [
    "The About page said 2.0.0 for four releases, because the version was typed in two places. It is now read from the binary, so it cannot drift again.",
    "The install page states plainly which library version it installs and why that is not the newest one in the source."] },
  { v: "2.4.0", t: "Your projects, and agent access on your terms", date: "2026-09-07", items: [
    "A Projects page. Import a robot project once and Catalyst remembers where it is, which Catalyst version and WPILib season it uses, and any note you leave on it.",
    "The same registry lets an AI agent find your code. Reading is immediate; writing is off until you switch it on per project, and is refused inside .git and build output even then."] },
  { v: "2.3.0", t: "MCP server 2.0", date: "2026-09-07", items: [
    "An agent can now build a knowledge graph of your project and ask it where something lives, what it connects to, and how two things are related — before reading a line of source.",
    "The bundled Catalyst graph was refreshed; it had been describing v1.7.0 and knew nothing of Commands v3 or the autonomy package."] },
  { v: "2.2.0", t: "Autonomy 2.0 Planner", date: "2026-09-06", items: [
    "Assemble your autonomy logic and see what it will actually do: which tasks win, which are held, and which mechanism each loser lost.",
    "The conflict matrix answers the question worth asking before a competition — can these two behaviours ever run together, or does everything need the drivetrain?"] },
  { v: "2.1.0", t: "Motor History", date: "2026-09-05", items: [
    "Every motor by serial number: its lifetime hours, revolutions, peak current and temperature, and every id and name it has ever carried.",
    "A motor's id and name change; its serial does not. Pull the history off the robot as JSON or CSV."] },
  { v: "2.0.0", t: "WPILib 2027 and Limelight Systemcore", date: "2026-08-23", items: [
    "Catalyst 2.x targets WPILib 2027 on Systemcore: five CAN buses, Commands v3, the onboard IMU, and a machine that reports its own processor, temperature, storage and flash wear.",
    "This app installs the 2027 vendordep and bundles the Systemcore-aware tools. It will not install into a 2026 project — keep Catalyst 1.x and the previous app for a roboRIO."] },
  { v: "1.7.0", t: "Physics Core validated in simulation", date: "2026-08-05", items: [
    "A ground-truth simulator marks Physics Core against the RFC acceptance criteria — fused velocity is now 48% closer to the truth through a slip than raw encoders.",
    "Building it found three real defects that 300 unit tests had missed."] },
  { v: "1.4.0", t: "Catalyst Desktop (optional companion app)", date: "2026-07-30", items: [
    "Every Catalyst tool in one native window, one-click install into your robot project, offline auto-update, and an AI-agent connector.",
    "The desktop app is optional — the library works exactly the same without it."] },
];
