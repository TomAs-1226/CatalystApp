// A `window.__TAURI__` good enough to drive the Catalyst app's UI in a browser.
//
// The file commands are answered from the real disk through the harness server; everything that
// would change something reports success and does nothing. A terminal is faked well enough to prove
// the pane's wiring: it answers the cursor-position query the way ConPTY would, echoes what is typed
// and exits on `exit`.

(() => {
  const get = async (path, params) => {
    const url = new URL(path, location.origin);
    for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  };

  const listeners = new Map();          // event name -> Set of callbacks
  const emit = (name, payload) => {
    for (const fn of listeners.get(name) || []) fn({ event: name, payload });
  };

  let sessions = 0;
  const alive = new Map();

  /** Enough of a terminal to prove the pane talks to one. */
  function openPty(req) {
    const id = `fake-${++sessions}`;
    const banner = req.kind === "claude"
      ? "Claude Code (fake session)\r\n\r\n> "
      : req.kind === "devtools"
        ? `devtools ${(req.args || []).join(" ")}\r\n\r\n`
        : `${req.cwd}> `;
    alive.set(id, { kind: req.kind, cwd: req.cwd, line: "" });
    // ConPTY sends ESC[6n before the child starts; a pane that never answers hangs. Ours answers
    // itself after a tick, so a pane that fails to wire `onData` still shows something — but the
    // handshake is visible in the data stream, which is what we are here to look at.
    setTimeout(() => emit("pty://data", { id, data: "\u001b[6n" }), 10);
    setTimeout(() => emit("pty://data", { id, data: banner }), 60);
    return id;
  }

  const COMMANDS = {
    // --- the workspace, from the real disk -----------------------------------
    ws_tree: ({ dir }) => get("/__fs/tree", { dir }),
    ws_read: ({ path }) => get("/__fs/read", { path }),
    ws_files: ({ dir }) => get("/__fs/files", { dir }),
    ws_search: ({ dir, query }) => get("/__fs/search", { dir, q: query }),
    ws_write: async ({ path }) => { console.info("[harness] ws_write ignored:", path); },

    // --- the project registry ------------------------------------------------
    list_projects: async () => {
      const { dir } = await get("/__fs/project");
      return [{
        name: dir.split(/[\\/]/).pop(), path: dir, catalyst_version: "2.0.0-beta.1",
        year: "2027", agent_write: false, note: "", analysis: { kind: "release", vendordeps: ["FrcCatalyst.json", "Phoenix6.json"], notes: [] },
      }];
    },
    projects_registry_path: async () => "(harness) projects.json",
    register_project: async ({ dir }) => ({ name: dir.split(/[\\/]/).pop(), path: dir }),
    forget_project: async () => {},
    set_agent_write: async () => {},
    set_project_note: async () => {},

    // --- the rest of the app -------------------------------------------------
    app_version: async () => "harness",
    console_available: async () => false,
    mcp_server_path: async () => "C:/Users/yu_th/AppData/Local/Catalyst/resources/mcp/server.js",
    read_bundled_vendordep: async () => '{"name":"FrcCatalyst","version":"2.0.0-beta.1","frcYear":"2027"}',
    detect_project: async ({ dir }) => ({
      project_name: dir.split(/[\\/]/).pop(), is_wpilib: true, reasons: [],
      has_catalyst: true, catalyst_version: "2.0.0-beta.1", project_year: "2027",
    }),
    diagnose_project: async () => ({
      ready: false, summary: "One thing will stop this building",
      findings: [
        { level: "blocker", what: "The JVM flags Commands v3 needs are missing", detail: "Without both --add-opens the robot boots and dies on the first command.", fix: 'jvmArgs = ["--add-opens=java.base/java.lang=ALL-UNNAMED", "--add-opens=java.base/jdk.internal.misc=ALL-UNNAMED"]' },
        { level: "warn", what: "Gradle 8.11 cannot read Java 25 class files", detail: "Unsupported class file major version 69.", fix: "Update the wrapper to 9.7.1" },
        { level: "ok", what: "Java 25", detail: "sourceCompatibility = JavaVersion.VERSION_25" },
      ],
    }),
    scan_migration: async () => [
      { file: "src/main/java/frc/robot/Robot.java", line: 42, oldName: "andThen", newName: "then", why: "v3 returns a group builder, so the name could not be kept.", text: "return drive().andThen(stop());" },
    ],
    inspect_vendordeps: async () => ({
      ready: false, summary: "One vendordep is from last season", projectYear: "2027", notes: [],
      deps: [
        { name: "FrcCatalyst", version: "2.0.0-beta.1", frcYear: "2027", yearState: "match", file: "FrcCatalyst.json", problems: [] },
        { name: "PathplannerLib", version: "2026.2.1", frcYear: "2026", yearState: "mismatch", file: "PathplannerLib.json", problems: ["Declares 2026 in a 2027 project"] },
      ],
    }),
    agent_status: async () => ({
      cli_path: "C:/Users/yu_th/AppData/Roaming/Claude/claude-code/2.1.271/claude.exe",
      cli_version: "2.1.271", mcp_wired: false, claude_md: false, project_registered: true,
    }),
    agent_prepare: async () => ({
      cli_path: "C:/Users/yu_th/AppData/Roaming/Claude/claude-code/2.1.271/claude.exe",
      cli_version: "2.1.271", mcp_wired: true, claude_md: true, project_registered: true,
    }),

    // --- terminals -----------------------------------------------------------
    pty_open: async ({ req }) => openPty(req),
    pty_write: async ({ id, data }) => {
      const s = alive.get(id);
      if (!s) return;
      if (data.startsWith("\u001b")) return;          // the cursor report; swallow it as a pty would
      emit("pty://data", { id, data });               // a real pty echoes
      s.line += data;
      if (data.includes("\r")) {
        const line = s.line.trim();
        s.line = "";
        if (line === "exit") {
          emit("pty://exit", { id, code: 0 });
          alive.delete(id);
          return;
        }
        emit("pty://data", { id, data: `\r\n(harness) ran: ${line}\r\n${s.cwd}> ` });
      }
    },
    pty_resize: async () => {},
    pty_close: async ({ id }) => { alive.delete(id); },
    pty_list: async () => [...alive.entries()].map(([id, s]) => ({ id, kind: s.kind, cwd: s.cwd, alive: true, exit_code: null })),
  };

  window.__TAURI__ = {
    core: {
      invoke: async (cmd, args) => {
        const fn = COMMANDS[cmd];
        if (!fn) throw new Error(`(harness) no stub for ${cmd}`);
        return fn(args || {});
      },
    },
    event: {
      listen: async (name, cb) => {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name).add(cb);
        return () => listeners.get(name).delete(cb);
      },
    },
    window: {
      getCurrentWindow: () => ({
        minimize: async () => {}, toggleMaximize: async () => {}, close: async () => {},
      }),
    },
    dialog: { open: async () => (await get("/__fs/project")).dir },
    http: { fetch: (url, init) => fetch(url, init) },
    opener: { openUrl: async (url) => window.open(url, "_blank") },
    process: { relaunch: async () => {} },
  };

  console.info("[harness] fake Tauri in place — file commands are real and read-only");
})();
