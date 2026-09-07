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

const SERVER_VERSION = "2.0.0";
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
