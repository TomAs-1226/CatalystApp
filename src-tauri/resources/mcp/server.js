#!/usr/bin/env node
/*
 * Catalyst MCP server (dependency-free, stdio).
 *
 * Exposes Catalyst's tools, its bundled knowledge graph, and any graphify knowledge graph on disk
 * to AI agents over the Model Context Protocol. No npm dependencies and no network: it speaks
 * newline-delimited JSON-RPC 2.0 on stdio and reads its data from ./data, so it works offline.
 *
 * Being dependency-free is not a stylistic choice here. graphify ships its own MCP server, and on a
 * stock install it can fail with `ModuleNotFoundError: No module named 'mcp'` because its tool venv
 * has no MCP package - a graph reader that cannot start is worth nothing at the moment an agent
 * needs it. This one is plain Node reading plain JSON, so it starts wherever Node does.
 *
 * The bundled graph in ./data/graph.json ships with each app version and is reachable only through
 * this server (it is never shown in the app UI). Honest note: it is a plain file on disk, so a
 * determined user could open it. "Agent-only" means "served through the agent channel, not surfaced
 * in the UI" - not cryptographically secret.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const SERVER_VERSION = "2.3.1";

/**
 * What a client is told about this server at connect time.
 *
 * MCP's `instructions` field is the only place to say something before the agent has called
 * anything, and the thing most worth saying is an ordering: graph, then docs, then source. An agent
 * that greps a robot project blind burns its context on files it did not need, and an agent that
 * writes Catalyst code from memory writes 1.x code, because that is what the training data holds.
 */
const INSTRUCTIONS = [
  "Catalyst: an FRC robotics library, its documentation, a knowledge graph of it, and the user's own projects.",
  "",
  "Order of work, cheapest first:",
  "  1. catalyst_projects  - where the user's code is, which Catalyst version it builds against,",
  "     whether that build is a pre-release or modified, and whether you may write to it.",
  "  2. catalyst_docs_search / catalyst_docs_read  - the intended API and the house idiom.",
  "     Search this BEFORE writing Catalyst code. Catalyst 2.x is a WPILib 2027 / Commands v3",
  "     library and its API differs from the 1.x code that dominates any training data: there is no",
  "     SubsystemBase, no CommandScheduler.getInstance(), ChassisSpeeds is ChassisVelocities, and",
  "     Timer.getFPGATimestamp() is Timer.getTimestamp(). Assume nothing; look it up.",
  "  3. catalyst_graph_*  - where a symbol lives, what it connects to, what a file reaches.",
  "     Ask the graph before reading source; it is far cheaper than grepping a repository.",
  "  4. catalyst_source_search / catalyst_source_read  - the truth, when the docs are not enough.",
  "",
  "When catalyst_projects reports a pre-release, a locally-built or a modified install, the",
  "project's own sources outrank both the documentation and any released version's notes.",
  "",
  "Writing: reading is always allowed; writing needs the user to have switched it on for that",
  "project in the Catalyst app, and is refused outside a registered project and inside .git, build,",
  "target, node_modules, .gradle and graphify-out. Do not ask the server to relax this - ask the user.",
].join(String.fromCharCode(10));
const DATA = path.join(__dirname, "data");
const motors = JSON.parse(fs.readFileSync(path.join(DATA, "motors.json"), "utf8")).motors;

const log = (...a) => process.stderr.write("[catalyst-mcp] " + a.join(" ") + "\n");

// ---------- helpers ----------
const norm = (s) => String(s || "").toLowerCase().replace(/[\s_\-]+/g, "");
function findMotor(q) {
  const n = norm(q);
  return motors.find((m) => norm(m.id) === n || norm(m.name) === n) ||
         motors.find((m) => norm(m.id).includes(n) || norm(m.name).includes(n));
}
const text = (t) => ({ content: [{ type: "text", text: t }] });
const errText = (t) => ({ content: [{ type: "text", text: t }], isError: true });

// ============================================================================
//  Graphs
//
//  Two shapes exist and an agent should not have to care which it is holding.
//
//    bundled   nodes[{id,label,type,cname,file}]        edges[{s,t,r}]
//    graphify  nodes[{id,label,community_name,          links[{source,target,relation,
//                     source_file,source_location}]            confidence}]
//
//  Both normalise to one internal form at load. Loaded graphs are cached by resolved path, because
//  a real graph is thousands of nodes and an agent asks it several questions in a row.
// ============================================================================

const graphCache = new Map();

function normaliseGraph(raw, origin) {
  const rawNodes = raw.nodes || [];
  const rawEdges = raw.links || raw.edges || [];
  const nodes = rawNodes.map((n) => ({
    id: n.id,
    label: n.label || n.id,
    kind: n.type || n.file_type || "node",
    area: n.community_name || n.cname || "",
    file: n.source_file || n.file || "",
    where: n.source_location || "",
    origin: n._origin || "",
  }));
  const edges = rawEdges.map((e) => ({
    s: e.source !== undefined ? e.source : e.s,
    t: e.target !== undefined ? e.target : e.t,
    r: e.relation || e.r || "related",
    confidence: e.confidence || "",
  }));

  const byId = new Map();
  const byNorm = new Map();
  for (const n of nodes) {
    byId.set(n.id, n);
    const k = norm(n.label);
    if (!byNorm.has(k)) byNorm.set(k, n);
  }
  // Adjacency, built once. Walking every edge per question is fine at 12 000 edges and is not fine
  // when an agent asks twenty questions.
  const adj = new Map();
  for (const e of edges) {
    if (!adj.has(e.s)) adj.set(e.s, []);
    if (!adj.has(e.t)) adj.set(e.t, []);
    adj.get(e.s).push({ other: e.t, r: e.r, out: true });
    adj.get(e.t).push({ other: e.s, r: e.r, out: false });
  }
  const areas = new Map();
  for (const n of nodes) if (n.area) areas.set(n.area, (areas.get(n.area) || 0) + 1);

  return {
    origin, nodes, edges, byId, byNorm, adj, areas,
    hyperedges: raw.hyperedges || (raw.graph && raw.graph.hyperedges) || [],
    commit: raw.built_at_commit || "",
    gods: raw.gods || null,
    meta: raw.meta || null,
  };
}

/** Where a project's graph lives. Accepts the graph file, its directory, or the project root. */
function resolveGraphPath(where) {
  if (!where || norm(where) === "bundled") return path.join(DATA, "graph.json");
  const p = path.resolve(where);
  if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  for (const c of [path.join(p, "graph.json"), path.join(p, "graphify-out", "graph.json")]) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function loadGraph(where) {
  const p = resolveGraphPath(where);
  if (!p) {
    const looked = where ? `${path.resolve(where)}, its graph.json, or its graphify-out/graph.json` : "the bundled graph";
    throw new Error(`No graph found at ${looked}. Run catalyst_graph_build on the project first, or pass a path to a graph.json.`);
  }
  const stat = fs.statSync(p);
  const key = p + "#" + stat.mtimeMs;
  if (graphCache.has(key)) return graphCache.get(key);
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  const g = normaliseGraph(raw, p);
  graphCache.clear();          // one graph at a time; an agent works in one project
  graphCache.set(key, g);
  log(`loaded ${g.nodes.length} nodes / ${g.edges.length} edges from ${p}`);
  return g;
}

function findNode(g, q) {
  if (g.byId.has(q)) return g.byId.get(q);
  const n = norm(q);
  if (g.byNorm.has(n)) return g.byNorm.get(n);
  return g.nodes.find((x) => norm(x.label).includes(n)) || null;
}

const describe = (n) => `${n.label}${n.kind && n.kind !== "node" ? "  [" + n.kind + "]" : ""}${n.area ? "  in " + n.area : ""}${n.file ? "  (" + n.file + (n.where ? " " + n.where : "") + ")" : ""}`;

/** Breadth-first shortest path. Undirected: "how are these two related" ignores arrow direction. */
function shortestPath(g, fromId, toId, maxDepth = 8) {
  if (fromId === toId) return [fromId];
  const prev = new Map([[fromId, null]]);
  let frontier = [fromId];
  for (let depth = 0; depth < maxDepth && frontier.length; depth++) {
    const next = [];
    for (const id of frontier) {
      for (const link of g.adj.get(id) || []) {
        if (prev.has(link.other)) continue;
        prev.set(link.other, id);
        if (link.other === toId) {
          const out = [toId];
          let cur = toId;
          while ((cur = prev.get(cur)) !== null && cur !== undefined) out.unshift(cur);
          return out;
        }
        next.push(link.other);
      }
    }
    frontier = next;
  }
  return null;
}

// ============================================================================
//  Documentation
//
//  Bundled rather than read from a library checkout, because an agent writing Catalyst code usually
//  has the *robot* project open and the library is not on the machine at all. Loaded on first use:
//  a session that never asks a documentation question pays nothing for it.
//
//  Cached against the file's size and mtime, not merely "have we loaded it". An agent session
//  outlives an app update - this server is a long-running process, and updating Catalyst rewrites
//  docs.json underneath it - so a load-once cache serves whatever the docs were when the session
//  connected and never says otherwise. That is the exact failure this file exists to prevent, and it
//  was caught here first: the server quoted a paragraph that had been corrected on disk minutes
//  earlier. One stat() per call is nothing next to being confidently wrong.
// ============================================================================

let docsCache = null;
let docsStamp = "";
function docs() {
  const p = path.join(DATA, "docs.json");
  let stamp = "";
  try {
    const st = fs.statSync(p);
    stamp = `${st.size}:${st.mtimeMs}`;
  } catch {
    // Gone or unreadable. Fall through with an empty stamp so a file that comes back reloads.
  }
  if (docsCache !== null && stamp === docsStamp) return docsCache;
  docsStamp = stamp;
  if (!stamp) {
    docsCache = { libraryVersion: "unknown", pages: [] };
    return docsCache;
  }
  try {
    docsCache = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    docsCache = { libraryVersion: "unknown", pages: [] };
  }
  return docsCache;
}

/** The lines around each hit, so a search answers the question rather than only locating it. */
function excerpt(body, re, before = 1, after = 3, max = 3) {
  const lines = body.split("\n");
  const out = [];
  for (let i = 0; i < lines.length && out.length < max; i++) {
    if (!re.test(lines[i])) continue;
    const lo = Math.max(0, i - before);
    const hi = Math.min(lines.length - 1, i + after);
    out.push(lines.slice(lo, hi + 1).join("\n").trim());
    i = hi;   // do not report the same paragraph three times
  }
  return out;
}

// ============================================================================
//  The project registry, and the only door through which this server writes
//
//  The app records the projects you have imported in a JSON file in its data directory. That file
//  is the permission boundary, and the rules are deliberately few:
//
//    1. A path must resolve inside a registered project root. Not near it, not a sibling - inside.
//    2. That project's agentWrite flag must be true. It defaults to false and the only thing that
//       sets it is a person clicking it in the app.
//    3. Some paths are refused inside a granted project anyway: .git, build output, and the
//       registry itself. Nothing an agent legitimately edits lives there, and the damage from
//       getting it wrong is out of proportion to the convenience.
//
//  Everything else - reading, the graph, the source tools - needs none of this. Only writes.
// ============================================================================

/** Where the app keeps its data. Must match projects.rs::data_dir exactly. */
function appDataDir() {
  if (process.platform === "win32") {
    return process.env.APPDATA ? path.join(process.env.APPDATA, "com.frccatalyst.app") : null;
  }
  const home = process.env.HOME;
  if (!home) return null;
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "com.frccatalyst.app");
  }
  const base = process.env.XDG_DATA_HOME || path.join(home, ".local", "share");
  return path.join(base, "com.frccatalyst.app");
}

function registryPath() {
  const d = appDataDir();
  return d ? path.join(d, "projects.json") : null;
}

/** The registered projects, re-read every time: the app may have changed them a second ago. */
function projects() {
  const p = registryPath();
  if (!p || !fs.existsSync(p)) return [];
  try {
    const reg = JSON.parse(fs.readFileSync(p, "utf8"));
    return Array.isArray(reg.projects) ? reg.projects : [];
  } catch {
    return [];
  }
}

function findProject(ref) {
  const list = projects();
  if (!ref) return list.length === 1 ? list[0] : null;
  const want = path.resolve(ref).toLowerCase();
  return list.find((p) => path.resolve(p.path).toLowerCase() === want)
      || list.find((p) => norm(p.name) === norm(ref))
      || null;
}

/** Paths that stay off limits even inside a project the agent may write to. */
const PROTECTED = [".git", "build", "target", "node_modules", ".gradle", "graphify-out"];

/**
 * Resolve `file` for writing, or explain why not.
 *
 * Containment is checked on the resolved real path of the project root, so a path that climbs out
 * with .. or arrives through a symlink is caught by the same test rather than by a special case.
 */
function resolveForWrite(file, projectRef) {
  const list = projects();
  if (!list.length) {
    return { error: "No projects are registered. Open the Catalyst app, import your robot project, "
      + "and turn on 'let agents write' for it." };
  }
  const target = path.resolve(file);
  const owner = (projectRef ? [findProject(projectRef)].filter(Boolean) : list).find((p) => {
    let root;
    try { root = fs.realpathSync(p.path); } catch { root = path.resolve(p.path); }
    const rel = path.relative(root, target);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  });
  if (!owner) {
    return { error: `${target} is not inside any registered project. Registered: `
      + list.map((p) => p.path).join(", ") };
  }
  if (!owner.agentWrite && !owner.agent_write) {
    return { error: `"${owner.name}" does not allow agent writes. Turn on 'let agents write' for it `
      + `in the Catalyst app's Projects page. Reading is unaffected.` };
  }
  let root;
  try { root = fs.realpathSync(owner.path); } catch { root = path.resolve(owner.path); }
  const rel = path.relative(root, target).split(path.sep);
  const hit = rel.find((seg) => PROTECTED.includes(seg));
  if (hit) {
    return { error: `Refusing to write inside "${hit}" - that is build output or version control, `
      + `not source. Nothing an agent should be editing lives there.` };
  }
  return { path: target, project: owner };
}

/** The interpreter that can import graphify, or null. */
function graphifyPython(root) {
  const marker = root ? path.join(path.resolve(root), "graphify-out", ".graphify_python") : null;
  const candidates = [];
  if (marker && fs.existsSync(marker)) candidates.push(fs.readFileSync(marker, "utf8").trim());
  const home = process.env.APPDATA || process.env.HOME || "";
  if (home) candidates.push(path.join(home, "uv", "tools", "graphifyy", "Scripts", "python.exe"),
                            path.join(home, "uv", "tools", "graphifyy", "bin", "python"));
  candidates.push("python3", "python");
  for (const c of candidates) {
    if (!c) continue;
    const r = spawnSync(c, ["-c", "import graphify"], { timeout: 20000 });
    if (r.status === 0) return c;
  }
  return null;
}

// ---------- tools ----------
const TOOLS = {
  catalyst_motor_specs: {
    description: "Look up the specs of a Catalyst MotorType (Kraken X60, Falcon 500, NEO, Minion, etc.), or list every motor if none is given. Nominal 12 V.",
    inputSchema: { type: "object", properties: { motor: { type: "string", description: "Motor name or id, e.g. 'Kraken X60' or 'KRAKEN_X60'. Omit to list all." } } },
    run: ({ motor }) => {
      if (!motor) {
        const rows = motors.map((m) => `${m.id.padEnd(15)} ${String(m.stallTorqueNm).padStart(5)} Nm  ${String(m.freeSpeedRPM).padStart(6)} RPM  ${String(m.stallCurrentA).padStart(4)} A stall  (${m.vendor})`);
        return text("Catalyst MotorType presets (12 V nominal):\n" + rows.join("\n"));
      }
      const m = findMotor(motor);
      if (!m) return errText(`No motor matching "${motor}". Known: ${motors.map((x) => x.id).join(", ")}`);
      return text(`${m.name} (${m.id}, ${m.vendor})\n  stall torque:  ${m.stallTorqueNm} Nm\n  free speed:    ${m.freeSpeedRPM} RPM (${(m.freeSpeedRPM / 60).toFixed(1)} rps)\n  stall current: ${m.stallCurrentA} A\n  free current:  ${m.freeCurrentA} A\n  Catalyst: .motorType(MotorType.${m.id})`);
    },
  },

  catalyst_gear_calc: {
    description: "Compute output speed and torque for a motor through a gear reduction. Same math as the MotorType Browser calculator.",
    inputSchema: {
      type: "object",
      required: ["motor", "gearRatio"],
      properties: {
        motor: { type: "string", description: "Motor name or id" },
        gearRatio: { type: "number", description: "Reduction as motor:mechanism, e.g. 10 means 10:1" },
        motorCount: { type: "number", description: "Number of motors on the mechanism (default 1)" },
      },
    },
    run: ({ motor, gearRatio, motorCount = 1 }) => {
      const m = findMotor(motor);
      if (!m) return errText(`No motor matching "${motor}".`);
      if (!(gearRatio > 0)) return errText("gearRatio must be > 0.");
      const outRPM = m.freeSpeedRPM / gearRatio;
      const outTorque = m.stallTorqueNm * gearRatio * motorCount;
      return text(`${m.name} through ${gearRatio}:1${motorCount > 1 ? ` x${motorCount} motors` : ""}\n  max mechanism speed: ${outRPM.toFixed(0)} RPM  (${(outRPM / 60).toFixed(2)} rps)\n  stall torque @ output: ${outTorque.toFixed(1)} Nm\n  stall current draw: ${(m.stallCurrentA * motorCount)} A`);
    },
  },

  catalyst_build_mechanism: {
    description: "Generate ready-to-paste Java for a Catalyst mechanism config, like the Builder tool. Returns a LinearMechanism / RotationalMechanism / FlywheelMechanism (etc.) builder chain.",
    inputSchema: {
      type: "object",
      required: ["type", "name", "motorId"],
      properties: {
        type: { type: "string", description: "linear | rotational | flywheel | roller | winch | servo | claw | pneumatic | turret" },
        name: { type: "string" },
        motorId: { type: "number", description: "CAN id of the lead motor" },
        motorType: { type: "string", description: "MotorType id (default KRAKEN_X60)" },
        gearRatio: { type: "number" },
        followerId: { type: "number" },
        followerInverted: { type: "boolean" },
        range: { type: "array", items: { type: "number" }, description: "[min, max] in meters (linear) or degrees (rotational)" },
        pid: { type: "array", items: { type: "number" }, description: "[kP, kI, kD]" },
        gravityGain: { type: "number" },
        currentLimit: { type: "number" },
        positions: { type: "object", description: "named setpoints, e.g. { STOW: 0.0, HIGH: 1.1 }" },
      },
    },
    run: (a) => {
      const cls = {
        linear: "LinearMechanism", rotational: "RotationalMechanism", flywheel: "FlywheelMechanism",
        roller: "RollerMechanism", winch: "WinchMechanism", servo: "ServoMechanism",
        claw: "ClawMechanism", pneumatic: "PneumaticMechanism", turret: "TurretMechanism",
      }[String(a.type || "").toLowerCase()];
      if (!cls) return errText(`Unknown mechanism type "${a.type}". Try: linear, rotational, flywheel, roller, winch, servo, claw, turret.`);
      const L = [];
      L.push(`.name("${a.name}")`);
      L.push(`.motor(${a.motorId})`);
      if (a.followerId != null) L.push(`.follower(${a.followerId}, ${!!a.followerInverted})`);
      L.push(`.motorType(MotorType.${a.motorType || "KRAKEN_X60"})`);
      if (a.gearRatio != null) L.push(`.gearRatio(${a.gearRatio})`);
      if (Array.isArray(a.range) && a.range.length === 2) L.push(`.range(${a.range[0]}, ${a.range[1]})`);
      if (Array.isArray(a.pid) && a.pid.length === 3) L.push(`.pid(${a.pid.join(", ")})`);
      if (a.gravityGain != null) L.push(`.gravityGain(${a.gravityGain})`);
      if (a.currentLimit != null) L.push(`.currentLimit(${a.currentLimit})`);
      if (a.positions) for (const [k, v] of Object.entries(a.positions)) L.push(`.position("${k}", ${v})`);
      const body = L.map((s) => "        " + s).join("\n");
      const code = `${cls} ${a.name.replace(/[^A-Za-z0-9]/g, "").replace(/^./, (c) => c.toLowerCase())} = new ${cls}(\n    ${cls}.Config.builder()\n${body}\n        .build());`;
      return text("```java\n" + code + "\n```");
    },
  },

  catalyst_can_conflicts: {
    description: "Check a list of CAN devices for duplicate IDs. CAN ids must be unique per bus (each bus is a separate id space).",
    inputSchema: {
      type: "object",
      required: ["devices"],
      properties: {
        devices: {
          type: "array",
          description: "e.g. [{name:'FL drive', id:1, bus:'can_s2'}, {name:'FL steer', id:1}]",
          items: { type: "object", required: ["id"], properties: { name: { type: "string" }, id: { type: "number" }, bus: { type: "string" } } },
        },
      },
    },
    run: ({ devices }) => {
      if (!Array.isArray(devices) || !devices.length) return errText("Provide a non-empty devices array.");
      const byKey = {};
      for (const d of devices) { const k = `${d.bus || "rio"}#${d.id}`; (byKey[k] ||= []).push(d.name || `id ${d.id}`); }
      const conflicts = Object.entries(byKey).filter(([, v]) => v.length > 1);
      if (!conflicts.length) return text(`No conflicts. ${devices.length} devices, all ids unique per bus.`);
      return errText("CAN ID conflicts found:\n" + conflicts.map(([k, v]) => {
        const [bus, id] = k.split("#"); return `  bus '${bus}' id ${id}: ${v.join(", ")}`;
      }).join("\n"));
    },
  },

  // ------------------------------------------------------------------ graph

  catalyst_graph_overview: {
    description: "Open a knowledge graph and describe it: size, main areas, and the most-connected nodes. Start here. Works on the bundled Catalyst graph or any project's graphify-out/graph.json.",
    inputSchema: {
      type: "object",
      properties: {
        graph: { type: "string", description: "Project root, a graphify-out directory, a graph.json path, or 'bundled' for the shipped Catalyst graph. Default bundled." },
      },
    },
    run: ({ graph }) => {
      const g = loadGraph(graph);
      const areas = [...g.areas.entries()].sort((a, b) => b[1] - a[1]);
      // Degree from the adjacency we already built.
      const hubs = [...g.adj.entries()]
        .map(([id, links]) => ({ node: g.byId.get(id), degree: links.length }))
        .filter((x) => x.node)
        .sort((a, b) => b.degree - a.degree)
        .slice(0, 12);
      const lines = [
        `${g.origin === path.join(DATA, "graph.json") ? "Bundled Catalyst graph" : g.origin}`,
        `${g.nodes.length} nodes, ${g.edges.length} edges, ${g.areas.size} areas${g.commit ? `, built at commit ${g.commit.slice(0, 8)}` : ""}`,
        "",
        "Most connected:",
        ...hubs.map((h) => `  ${h.node.label}  (${h.degree} connections)${h.node.area ? "  — " + h.node.area : ""}`),
        "",
        `Areas (largest first): ${areas.slice(0, 24).map(([a, n]) => `${a} (${n})`).join(", ")}`,
      ];
      if (g.hyperedges.length) {
        lines.push("", `${g.hyperedges.length} hyperedge(s) - multi-node concepts:`,
          ...g.hyperedges.slice(0, 8).map((h) => `  ${h.label || h.id}  (${(h.nodes || []).length} nodes)`));
      }
      return text(lines.join("\n"));
    },
  },

  catalyst_graph_search: {
    description: "Search a knowledge graph for nodes by name. Use this to find where something lives before asking for its neighbours or a path.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string" },
        graph: { type: "string", description: "Project root or graph path. Default bundled." },
        area: { type: "string", description: "Only nodes in this community/area." },
        limit: { type: "number", description: "default 20" },
      },
    },
    run: ({ query, graph, area, limit = 20 }) => {
      const g = loadGraph(graph);
      const q = norm(query);
      const a = area ? norm(area) : null;
      const hits = g.nodes.filter((n) =>
        (norm(n.label).includes(q) || norm(n.id).includes(q) || (n.file && norm(n.file).includes(q)))
        && (!a || norm(n.area).includes(a)));
      if (!hits.length) return text(`No nodes matching "${query}"${area ? ` in area "${area}"` : ""} among ${g.nodes.length}.`);
      // Exact label matches first: an agent searching "TaskArbiter" wants the class, not every
      // method that mentions it.
      hits.sort((x, y) => (norm(y.label) === q ? 1 : 0) - (norm(x.label) === q ? 1 : 0)
                       || x.label.length - y.label.length);
      const shown = hits.slice(0, limit);
      return text(`${hits.length} match(es) for "${query}"${hits.length > shown.length ? `, showing ${shown.length}` : ""}:\n`
        + shown.map((n) => "  " + describe(n)).join("\n"));
    },
  },

  catalyst_graph_neighbors: {
    description: "Show what a node connects to, and how. Pass an id or a label from catalyst_graph_search.",
    inputSchema: {
      type: "object",
      required: ["node"],
      properties: {
        node: { type: "string", description: "node id or label" },
        graph: { type: "string", description: "Project root or graph path. Default bundled." },
        relation: { type: "string", description: "Only edges with this relation, e.g. 'calls', 'contains'." },
        limit: { type: "number", description: "default 30" },
      },
    },
    run: ({ node, graph, relation, limit = 30 }) => {
      const g = loadGraph(graph);
      const target = findNode(g, node);
      if (!target) return errText(`No node matching "${node}". Try catalyst_graph_search first.`);
      const rel = relation ? norm(relation) : null;
      const links = (g.adj.get(target.id) || []).filter((l) => !rel || norm(l.r).includes(rel));
      if (!links.length) {
        return text(`${describe(target)}\n\nNo${relation ? ` '${relation}'` : ""} connections.`);
      }
      const byRel = new Map();
      for (const l of links.slice(0, limit)) {
        const other = g.byId.get(l.other);
        const key = l.r;
        if (!byRel.has(key)) byRel.set(key, []);
        byRel.get(key).push(`${l.out ? "→" : "←"} ${other ? other.label : l.other}`);
      }
      const body = [...byRel.entries()].map(([r, list]) => `  ${r}:\n${list.map((s) => "    " + s).join("\n")}`);
      return text(`${describe(target)}\n\n${links.length} connection(s)${links.length > limit ? `, showing ${limit}` : ""}:\n${body.join("\n")}`);
    },
  },

  catalyst_graph_path: {
    description: "How are two things related? Returns the shortest chain of connections between two nodes, which is the fastest way to understand an unfamiliar coupling.",
    inputSchema: {
      type: "object",
      required: ["from", "to"],
      properties: {
        from: { type: "string" },
        to: { type: "string" },
        graph: { type: "string", description: "Project root or graph path. Default bundled." },
      },
    },
    run: ({ from, to, graph }) => {
      const g = loadGraph(graph);
      const a = findNode(g, from);
      const b = findNode(g, to);
      if (!a) return errText(`No node matching "${from}".`);
      if (!b) return errText(`No node matching "${to}".`);
      const ids = shortestPath(g, a.id, b.id);
      if (!ids) return text(`${a.label} and ${b.label} are not connected within 8 hops. They are in ${a.area === b.area ? "the same area" : `different areas (${a.area || "?"} and ${b.area || "?"})`}.`);
      const steps = ids.map((id, i) => {
        const n = g.byId.get(id);
        if (i === 0) return `  ${n.label}`;
        const link = (g.adj.get(ids[i - 1]) || []).find((l) => l.other === id);
        return `    --${link ? link.r : "?"}-->  ${n.label}`;
      });
      return text(`${ids.length - 1} hop(s) from ${a.label} to ${b.label}:\n${steps.join("\n")}`);
    },
  },

  catalyst_graph_file: {
    description: "What a source file contains and what it touches, from the graph. The quickest way to orient in an unfamiliar file before reading it.",
    inputSchema: {
      type: "object",
      required: ["file"],
      properties: {
        file: { type: "string", description: "Path or fragment, e.g. 'TaskArbiter.java' or 'autonomy/'" },
        graph: { type: "string", description: "Project root or graph path. Default bundled." },
      },
    },
    run: ({ file, graph }) => {
      const g = loadGraph(graph);
      const q = norm(file);
      const inFile = g.nodes.filter((n) => n.file && norm(n.file).includes(q));
      if (!inFile.length) return text(`No graph nodes from a file matching "${file}".`);
      const files = [...new Set(inFile.map((n) => n.file))];
      const ids = new Set(inFile.map((n) => n.id));
      const outward = new Map();
      for (const n of inFile) {
        for (const l of g.adj.get(n.id) || []) {
          if (ids.has(l.other)) continue;
          const other = g.byId.get(l.other);
          if (!other) continue;
          const key = `${l.r} ${other.label}${other.file ? " (" + other.file + ")" : ""}`;
          outward.set(key, (outward.get(key) || 0) + 1);
        }
      }
      const lines = [
        `${files.length} file(s) matching "${file}": ${files.slice(0, 6).join(", ")}${files.length > 6 ? ` and ${files.length - 6} more` : ""}`,
        "",
        `Defines ${inFile.length} node(s):`,
        ...inFile.slice(0, 30).map((n) => `  ${n.label}${n.where ? "  " + n.where : ""}`),
      ];
      if (outward.size) {
        lines.push("", `Reaches outside itself (${outward.size}):`,
          ...[...outward.keys()].slice(0, 25).map((k) => "  " + k));
      }
      return text(lines.join("\n"));
    },
  },

  catalyst_graph_build: {
    description: "Build or refresh a graphify knowledge graph for a project, so the other graph tools can answer questions about it. Structural (AST) pass only: no LLM, no network, no token cost. Writes <root>/graphify-out/graph.json.",
    inputSchema: {
      type: "object",
      required: ["root"],
      properties: {
        root: { type: "string", description: "Project root directory to analyse." },
        out: { type: "string", description: "Output directory (default <root>/graphify-out)." },
      },
    },
    run: ({ root, out }) => {
      if (!root) return errText("Pass the project root to analyse.");
      const dir = path.resolve(root);
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return errText(`Not a directory: ${dir}`);
      const py = graphifyPython(dir);
      if (!py) {
        return errText("graphify is not installed for any Python this server can find. Install it with "
          + "`uv tool install graphifyy` (or `pip install graphifyy`), then try again. "
          + "The other graph tools still work on any graph.json that already exists.");
      }
      const script = path.join(__dirname, "build_graph.py");
      const args = [script, dir, "--json"];
      if (out) args.push("--out", out);
      const r = spawnSync(py, args, { encoding: "utf8", timeout: 15 * 60 * 1000, maxBuffer: 32 * 1024 * 1024 });
      if (r.error) return errText(`Could not run the builder: ${r.error.message}`);
      if (r.status !== 0) return errText(`Build failed (exit ${r.status}):\n${(r.stderr || "").trim().slice(-1500)}`);
      let summary;
      try { summary = JSON.parse((r.stdout || "").trim().split("\n").pop()); } catch { summary = null; }
      if (!summary) return text((r.stdout || "built").trim());
      graphCache.clear();
      return text(`Built ${summary.nodes} nodes and ${summary.edges} edges across ${summary.communities} areas `
        + `from ${summary.files} code files in ${summary.seconds}s.\n`
        + `Graph: ${summary.graph}\n`
        + `${summary.note}. Query it by passing graph: "${dir}" to the other graph tools.`);
    },
  },

  // ------------------------------------------------------------------ documentation

  catalyst_docs_search: {
    description: "Search the FrcCatalyst documentation. Use this BEFORE writing Catalyst code - it is how you find the intended API and the house idiom rather than guessing a plausible-looking one.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "Words or a regular expression, e.g. 'swerve heading lock' or 'PhysicsConstraints'." },
        limit: { type: "number", description: "Pages to report, default 6" },
      },
    },
    run: ({ query, limit = 6 }) => {
      const d = docs();
      if (!d.pages.length) return errText("No documentation is bundled with this build.");

      // A multi-word query OR-ed together matches almost every page: "swerve heading lock" reported
      // 26 of 30 pages, which is the same as reporting nothing. So each term is matched on its own
      // and a page must carry *all* of them to count - with a fall back to any-term when that finds
      // nothing, because an over-strict search that says "no results" is its own failure.
      const raw = query.trim();
      const terms = raw.split(/\s+/).filter(Boolean);
      const compile = (t) => {
        try { return new RegExp(t, "i"); }
        catch { return new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"); }
      };
      const res = terms.map(compile);
      const any = compile(terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"));

      const rank = (page, needed) => {
        const hay = page.title + "\n" + page.headings.join("\n") + "\n" + page.body;
        const present = res.filter((r) => r.test(hay)).length;
        if (present < needed) return null;
        let score = 0;
        for (const r of res) {
          if (r.test(page.title)) score += 10;
          score += page.headings.filter((h) => r.test(h)).length * 4;
        }
        // Proximity beats frequency: a page that uses the terms in one paragraph is answering the
        // question, a page that mentions each of them fifty lines apart merely contains the words.
        const lines = page.body.split("\n");
        let together = 0;
        for (let i = 0; i < lines.length; i++) {
          const win = lines.slice(i, i + 4).join(" ");
          if (res.every((r) => r.test(win))) together++;
        }
        score += Math.min(together, 10) * 3;
        const hits = (page.body.match(new RegExp(any.source, "gi")) || []).length;
        score += Math.min(hits, 12);
        return score > 0 ? { page, score, hits } : null;
      };

      let scored = d.pages.map((p) => rank(p, terms.length)).filter(Boolean);
      let strict = true;
      if (!scored.length) {
        scored = d.pages.map((p) => rank(p, 1)).filter(Boolean);
        strict = false;
      }
      if (!scored.length) {
        return text(`Nothing in the documentation matches "${query}".\n\nPages available:\n`
          + d.pages.map((p) => `  ${p.path}  ${p.title}`).join("\n"));
      }
      scored.sort((a, b) => b.score - a.score);
      const shown = scored.slice(0, limit);
      const body = shown.map(({ page, hits }) => {
        const bits = excerpt(page.body, any);
        return `## ${page.title}   (${page.path}, ${hits} mention${hits === 1 ? "" : "s"})\n`
          + (bits.length ? bits.map((b) => "    " + b.replace(/\n/g, "\n    ")).join("\n    ---\n") : "    (title/heading match)");
      });
      const how = strict || terms.length < 2 ? "" : " (no page carries every term, so these match on any of them)";
      return text(`FrcCatalyst ${d.libraryVersion} documentation - ${scored.length} page(s) match "${query}"${how}:\n\n`
        + body.join("\n\n")
        + `\n\nShowing ${shown.length} of ${scored.length}. Read a whole page with catalyst_docs_read.`);
    },
  },

  catalyst_docs_read: {
    description: "Read a documentation page in full, or list every page when no page is named.",
    inputSchema: {
      type: "object",
      properties: {
        page: { type: "string", description: "Path or title fragment, e.g. 'advanced/physics.md' or 'physics'. Omit to list all pages." },
        section: { type: "string", description: "Only the part under this heading." },
      },
    },
    run: ({ page, section }) => {
      const d = docs();
      if (!d.pages.length) return errText("No documentation is bundled with this build.");
      if (!page) {
        return text(`FrcCatalyst ${d.libraryVersion} documentation, ${d.pages.length} pages:\n`
          + d.pages.map((p) => `  ${p.path.padEnd(34)} ${p.title}`).join("\n"));
      }
      const q = norm(page);
      const hit = d.pages.find((p) => norm(p.path) === q)
               || d.pages.find((p) => norm(p.title) === q)
               || d.pages.find((p) => norm(p.path).includes(q) || norm(p.title).includes(q));
      if (!hit) {
        return errText(`No page matching "${page}". Try catalyst_docs_search, or omit the page to list them.`);
      }
      if (!section) {
        return text(`# ${hit.title}   (${hit.path})\n\n${hit.body}`);
      }
      const sq = norm(section);
      const lines = hit.body.split("\n");
      const start = lines.findIndex((l) => /^#{2,4}\s/.test(l) && norm(l.replace(/^#+\s*/, "")).includes(sq));
      if (start < 0) {
        return text(`"${section}" is not a heading in ${hit.path}. Headings:\n`
          + hit.headings.map((h) => "  " + h).join("\n"));
      }
      const level = (lines[start].match(/^#+/) || ["##"])[0].length;
      let end = lines.length;
      for (let i = start + 1; i < lines.length; i++) {
        const m = lines[i].match(/^(#{2,4})\s/);
        if (m && m[1].length <= level) { end = i; break; }
      }
      return text(`# ${hit.title} > ${section}   (${hit.path})\n\n${lines.slice(start, end).join("\n").trim()}`);
    },
  },

  // ------------------------------------------------------------------ projects

  catalyst_projects: {
    description: "The robot projects the user has imported into the Catalyst app: where they are, which Catalyst and WPILib season they use, any note the user left, and whether you may write to them. Call this first when you need to work on the user's code - it tells you where it is.",
    inputSchema: { type: "object", properties: {} },
    run: () => {
      const list = projects();
      const where = registryPath();
      if (!list.length) {
        return text("No projects are registered.\n\nThe user imports them in the Catalyst app "
          + "(Projects page). Until then you have the bundled Catalyst knowledge graph and the "
          + "read-only tools, but no path to their code."
          + (where ? `\n\nRegistry: ${where}` : ""));
      }
      const rows = list.map((p) => {
        const a = p.analysis || {};
        const bits = [
          p.catalyst_version ? `Catalyst ${p.catalyst_version}` : "no Catalyst vendordep",
          p.year ? `WPILib ${p.year}` : null,
          a.resolves_from ? `from ${a.resolves_from}` : null,
          (p.agentWrite || p.agent_write) ? "you may write here" : "read-only to you",
        ].filter(Boolean);
        const lines = [`  ${p.name}`, `    ${p.path}`];
        if (a.kind) lines.push(`    ${a.kind}`);
        lines.push("    " + bits.join("  ·  "));
        if (p.note) lines.push(`    note: ${p.note}`);
        // The findings are the point: they say when this install is not the one the docs describe.
        for (const n of a.notes || []) lines.push(`    ! ${n}`);
        return lines.join(String.fromCharCode(10));
      });
      // Naming the documentation's version beside the projects' is what makes a mismatch visible.
      // An agent that sees the docs describe 2.0.0-alpha.2 while the project builds something else
      // will go and check; one that never sees the two numbers together will not think to.
      const dv = docs().libraryVersion;
      const versions = [...new Set(list.map((p) => p.catalyst_version).filter(Boolean))];
      const drift = dv !== "unknown" && versions.length > 0 && !versions.includes(dv);

      return text(`${list.length} registered project(s), most recently opened first:\n\n${rows.join("\n\n")}`
        + `\n\nRegistry: ${where}`
        + `\n\nThe bundled documentation describes FrcCatalyst ${dv}.`
        + (drift ? ` No project above is on that version - where the two could differ, the project's own sources decide.` : "")
        + `\n\nBefore writing Catalyst code here: search catalyst_docs_search for the intended API, `
        + `and where a note above says the install is a pre-release, modified, or locally built, `
        + `confirm the signature in the project's own sources rather than trusting a released `
        + `version's documentation.`);
    },
  },

  catalyst_project_files: {
    description: "List the source files in a registered project, so you can see its shape without walking the disk yourself.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project path or name from catalyst_projects. Omit when only one is registered." },
        extensions: { type: "string", description: "Comma-separated filter, e.g. 'java'. Default java,kt,json,gradle,md." },
        limit: { type: "number", description: "default 200" },
      },
    },
    run: ({ project, extensions, limit = 200 }) => {
      const proj = findProject(project);
      if (!proj) {
        const list = projects();
        return errText(list.length
          ? `Name the project. Registered: ${list.map((p) => p.name).join(", ")}`
          : "No projects are registered. The user imports them in the Catalyst app.");
      }
      const exts = (extensions || "java,kt,json,gradle,md").split(",")
        .map((e) => "." + e.trim().replace(/^\./, "").toLowerCase());
      const SKIP = new Set(PROTECTED.concat([".idea", ".vscode", "__pycache__", "logs"]));
      const found = [];
      const walk = (d) => {
        if (found.length >= limit) return;
        let entries;
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (found.length >= limit) return;
          if (e.isDirectory()) { if (!SKIP.has(e.name) && !e.name.startsWith(".")) walk(path.join(d, e.name)); continue; }
          if (exts.includes(path.extname(e.name).toLowerCase()) || e.name === "build.gradle") {
            found.push(path.relative(proj.path, path.join(d, e.name)));
          }
        }
      };
      walk(proj.path);
      if (!found.length) return text(`No matching files in ${proj.name}.`);
      return text(`${proj.name} (${proj.path})\n${found.length} file(s)${found.length >= limit ? ", truncated" : ""}:\n`
        + found.map((f) => "  " + f).join("\n"));
    },
  },

  catalyst_write_file: {
    description: "Write a file inside a registered project the user has allowed you to write to. Creates parent directories. Refuses anything outside a granted project, and refuses .git and build output inside one.",
    inputSchema: {
      type: "object",
      required: ["file", "content"],
      properties: {
        file: { type: "string", description: "Absolute path, or relative to the project when 'project' is given." },
        content: { type: "string", description: "The complete new contents of the file." },
        project: { type: "string", description: "Project path or name, when 'file' is relative or ambiguous." },
      },
    },
    run: ({ file, content, project }) => {
      if (typeof content !== "string") return errText("content must be a string.");
      let target = file;
      if (project && !path.isAbsolute(file)) {
        const proj = findProject(project);
        if (!proj) return errText(`No registered project matching "${project}".`);
        target = path.join(proj.path, file);
      }
      const g = resolveForWrite(target, project);
      if (g.error) return errText(g.error);
      try {
        const dir = path.dirname(g.path);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const existed = fs.existsSync(g.path);
        const before = existed ? fs.readFileSync(g.path, "utf8").split(/\r?\n/).length : 0;
        fs.writeFileSync(g.path, content, "utf8");
        const after = content.split(/\r?\n/).length;
        return text(`${existed ? "Updated" : "Created"} ${g.path}\n`
          + `${existed ? `${before} lines -> ${after} lines` : `${after} lines`}  (project "${g.project.name}")`);
      } catch (e) {
        return errText(`Could not write ${g.path}: ${e.message}`);
      }
    },
  },

  catalyst_edit_file: {
    description: "Replace an exact string in a file inside a granted project. Prefer this over rewriting a whole file: it fails loudly when the text is not found or appears more than once, which is what catches an edit aimed at the wrong place.",
    inputSchema: {
      type: "object",
      required: ["file", "find", "replace"],
      properties: {
        file: { type: "string" },
        find: { type: "string", description: "Exact text to replace. Must appear exactly once." },
        replace: { type: "string" },
        project: { type: "string", description: "Project path or name, when 'file' is relative." },
      },
    },
    run: ({ file, find, replace, project }) => {
      if (typeof find !== "string" || !find.length) return errText("find must be a non-empty string.");
      if (typeof replace !== "string") return errText("replace must be a string.");
      let target = file;
      if (project && !path.isAbsolute(file)) {
        const proj = findProject(project);
        if (!proj) return errText(`No registered project matching "${project}".`);
        target = path.join(proj.path, file);
      }
      const g = resolveForWrite(target, project);
      if (g.error) return errText(g.error);
      if (!fs.existsSync(g.path)) return errText(`No such file: ${g.path}`);
      let body;
      try { body = fs.readFileSync(g.path, "utf8"); } catch (e) { return errText(`Could not read: ${e.message}`); }
      const count = body.split(find).length - 1;
      if (count === 0) {
        return errText(`That text does not appear in ${path.basename(g.path)}. Read it first - the `
          + `file may have changed since you last saw it.`);
      }
      if (count > 1) {
        return errText(`That text appears ${count} times in ${path.basename(g.path)}. Include enough `
          + `surrounding lines to make it unique, so the edit lands where you meant it to.`);
      }
      try {
        fs.writeFileSync(g.path, body.replace(find, replace), "utf8");
        const at = body.slice(0, body.indexOf(find)).split(/\r?\n/).length;
        return text(`Edited ${g.path} at line ${at}  (project "${g.project.name}")`);
      } catch (e) {
        return errText(`Could not write: ${e.message}`);
      }
    },
  },

  // ------------------------------------------------------------------ source

  catalyst_source_search: {
    description: "Search source files for a regular expression and return matching lines with context. Use after the graph tools have told you where to look.",
    inputSchema: {
      type: "object",
      required: ["pattern", "root"],
      properties: {
        pattern: { type: "string", description: "JavaScript regular expression." },
        root: { type: "string", description: "Directory to search." },
        extensions: { type: "string", description: "Comma-separated, e.g. 'java,kt'. Default all text files." },
        context: { type: "number", description: "Lines of context either side (default 0)." },
        limit: { type: "number", description: "Max matches (default 40)." },
      },
    },
    run: ({ pattern, root, extensions, context = 0, limit = 40 }) => {
      let re;
      try { re = new RegExp(pattern, "i"); } catch (e) { return errText(`Bad pattern: ${e.message}`); }
      const dir = path.resolve(root);
      if (!fs.existsSync(dir)) return errText(`No such directory: ${dir}`);
      const exts = extensions ? extensions.split(",").map((s) => "." + s.trim().replace(/^\./, "").toLowerCase()) : null;
      const SKIP = new Set(["node_modules", ".git", "build", "target", "dist", "graphify-out", ".gradle", "__pycache__"]);
      const out = [];
      let scanned = 0;

      const walk = (d) => {
        if (out.length >= limit) return;
        let entries;
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (out.length >= limit) return;
          const p = path.join(d, e.name);
          if (e.isDirectory()) { if (!SKIP.has(e.name) && !e.name.startsWith(".")) walk(p); continue; }
          if (exts && !exts.includes(path.extname(e.name).toLowerCase())) continue;
          let body;
          try {
            if (fs.statSync(p).size > 2 * 1024 * 1024) continue;   // not source; do not read it
            body = fs.readFileSync(p, "utf8");
          } catch { continue; }
          if (body.includes(String.fromCharCode(0))) continue;                    // binary
          scanned++;
          const lines = body.split(/\r?\n/);
          for (let i = 0; i < lines.length && out.length < limit; i++) {
            if (!re.test(lines[i])) continue;
            const lo = Math.max(0, i - context);
            const hi = Math.min(lines.length - 1, i + context);
            const block = [];
            for (let j = lo; j <= hi; j++) block.push(`${String(j + 1).padStart(5)}${j === i ? ">" : " "} ${lines[j]}`);
            out.push(`${path.relative(dir, p)}:${i + 1}\n${block.join("\n")}`);
          }
        }
      };
      walk(dir);
      if (!out.length) return text(`No match for /${pattern}/ in ${scanned} file(s) under ${dir}.`);
      return text(`${out.length} match(es) in ${scanned} file(s):\n\n` + out.join("\n\n"));
    },
  },

  catalyst_source_read: {
    description: "Read a source file, or just the part of it around a symbol. Prefer the symbol form: it returns the declaration and its body rather than a thousand lines.",
    inputSchema: {
      type: "object",
      required: ["file"],
      properties: {
        file: { type: "string", description: "Path to the file." },
        symbol: { type: "string", description: "Class, method or field name. Omit to read the whole file." },
        before: { type: "number", description: "Lines before the symbol (default 8, to catch its javadoc)." },
        after: { type: "number", description: "Lines after (default 60)." },
      },
    },
    run: ({ file, symbol, before = 8, after = 60 }) => {
      const p = path.resolve(file);
      if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return errText(`No such file: ${p}`);
      let body;
      try { body = fs.readFileSync(p, "utf8"); } catch (e) { return errText(`Could not read: ${e.message}`); }
      const lines = body.split(/\r?\n/);
      if (!symbol) {
        if (lines.length > 800) {
          return text(`${p} is ${lines.length} lines. First 400:\n\n`
            + lines.slice(0, 400).map((l, i) => `${String(i + 1).padStart(5)}  ${l}`).join("\n")
            + `\n\n... ${lines.length - 400} more lines. Pass a symbol to read a specific part.`);
        }
        return text(`${p} (${lines.length} lines):\n\n` + lines.map((l, i) => `${String(i + 1).padStart(5)}  ${l}`).join("\n"));
      }
      // A declaration, not a mention: the name followed by ( or = or whitespace-then-{, and not
      // preceded by a dot.
      const esc = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const decl = new RegExp(`(^|[^.\\w])${esc}\\s*[(<{=;]|\\b(class|interface|enum|record)\\s+${esc}\\b`);
      let at = lines.findIndex((l) => decl.test(l));
      if (at < 0) at = lines.findIndex((l) => l.includes(symbol));
      if (at < 0) return text(`"${symbol}" does not appear in ${path.basename(p)}.`);
      const lo = Math.max(0, at - before);
      const hi = Math.min(lines.length - 1, at + after);
      const block = [];
      for (let i = lo; i <= hi; i++) block.push(`${String(i + 1).padStart(5)}${i === at ? ">" : " "} ${lines[i]}`);
      return text(`${p} around "${symbol}" (line ${at + 1} of ${lines.length}):\n\n` + block.join("\n"));
    },
  },
};

// ---------- MCP / JSON-RPC over stdio ----------
function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  try {
    if (method === "initialize") {
      return reply(id, {
        protocolVersion: (params && params.protocolVersion) || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "catalyst", version: SERVER_VERSION },
        instructions: INSTRUCTIONS,
      });
    }
    if (method === "notifications/initialized" || method === "notifications/cancelled") return;
    if (method === "ping") return reply(id, {});
    if (method === "tools/list") {
      return reply(id, {
        tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })),
      });
    }
    if (method === "tools/call") {
      const t = TOOLS[params && params.name];
      if (!t) return replyErr(id, -32602, `Unknown tool: ${params && params.name}`);
      let result;
      try {
        result = t.run(params.arguments || {});
      } catch (e) {
        // A tool that throws is a failed call, not a dead server. An agent mid-task should get a
        // message it can act on rather than a transport that has gone away.
        result = errText(String((e && e.message) || e));
      }
      return reply(id, result);
    }
    if (isRequest) return replyErr(id, -32601, `Method not found: ${method}`);
  } catch (e) {
    if (isRequest) return replyErr(id, -32603, "Internal error: " + (e && e.message));
    log("error in notification", method, e && e.message);
  }
}
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }
function reply(id, result) { send({ jsonrpc: "2.0", id, result }); }
function replyErr(id, code, message) { send({ jsonrpc: "2.0", id, error: { code, message } }); }

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (e) { log("bad JSON:", line.slice(0, 80)); continue; }
    handle(msg);
  }
});
process.stdin.on("end", () => process.exit(0));
log(`ready — ${Object.keys(TOOLS).length} tools`);
