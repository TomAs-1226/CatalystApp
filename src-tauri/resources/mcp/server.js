#!/usr/bin/env node
/*
 * Catalyst MCP server (dependency-free, stdio).
 *
 * Exposes Catalyst's tools and its bundled knowledge graph to AI agents over the Model Context
 * Protocol. No npm dependencies and no network: it speaks newline-delimited JSON-RPC 2.0 on stdio
 * and reads its data from ./data, so it works completely offline.
 *
 * The knowledge graph in ./data/graph.json ships with each app version and is reachable only through
 * this server (it is never shown in the app UI). Honest note: it is a plain file on disk, so a
 * determined user could open it. "Agent-only" means "served through the agent channel, not surfaced
 * in the UI" — not cryptographically secret. True secrecy would require hosting it behind an API.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const SERVER_VERSION = "1.4.2";
const DATA = path.join(__dirname, "data");
const motors = JSON.parse(fs.readFileSync(path.join(DATA, "motors.json"), "utf8")).motors;
const graph = JSON.parse(fs.readFileSync(path.join(DATA, "graph.json"), "utf8"));

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
    description: "Check a list of CAN devices for duplicate IDs. CAN ids must be unique per bus (the 'rio' bus and a CANivore are separate id spaces).",
    inputSchema: {
      type: "object",
      required: ["devices"],
      properties: {
        devices: {
          type: "array",
          description: "e.g. [{name:'FL drive', id:1, bus:'rio'}, {name:'FL steer', id:1}]",
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

  catalyst_graph_search: {
    description: "Search the Catalyst knowledge graph for classes, methods, or concepts by name. Use this to find where something lives before asking for its neighbors.",
    inputSchema: { type: "object", required: ["query"], properties: { query: { type: "string" }, limit: { type: "number", description: "default 15" } } },
    run: ({ query, limit = 15 }) => {
      const q = norm(query);
      const hits = graph.nodes.filter((n) => norm(n.label).includes(q) || norm(n.id).includes(q)).slice(0, limit);
      if (!hits.length) return text(`No graph nodes matching "${query}".`);
      return text(`${hits.length} match(es) for "${query}":\n` + hits.map((n) => `  ${n.label}  [${n.type}]  in ${n.cname}${n.file ? "  (" + n.file + ")" : ""}`).join("\n"));
    },
  },

  catalyst_graph_neighbors: {
    description: "Show what a node in the Catalyst knowledge graph connects to (its edges and relations). Pass an id from catalyst_graph_search, or a label.",
    inputSchema: { type: "object", required: ["node"], properties: { node: { type: "string", description: "node id or label" }, limit: { type: "number", description: "default 25" } } },
    run: ({ node, limit = 25 }) => {
      const q = norm(node);
      const target = graph.nodes.find((n) => n.id === node) || graph.nodes.find((n) => norm(n.label) === q) || graph.nodes.find((n) => norm(n.label).includes(q));
      if (!target) return errText(`No node matching "${node}". Try catalyst_graph_search first.`);
      const lbl = {}; graph.nodes.forEach((n) => (lbl[n.id] = n.label));
      const nbrs = [];
      for (const e of graph.edges) {
        if (e.s === target.id) nbrs.push(`${target.label} --${e.r}--> ${lbl[e.t] || e.t}`);
        else if (e.t === target.id) nbrs.push(`${lbl[e.s] || e.s} --${e.r}--> ${target.label}`);
        if (nbrs.length >= limit) break;
      }
      return text(`${target.label}  [${target.type}]  in community "${target.cname}"\n${target.file ? "defined in " + target.file + "\n" : ""}${nbrs.length} connection(s):\n` + nbrs.map((s) => "  " + s).join("\n"));
    },
  },

  catalyst_graph_overview: {
    description: "A map of the Catalyst library from the knowledge graph: its most-connected core abstractions (god nodes) and its main areas (communities).",
    inputSchema: { type: "object", properties: {} },
    run: () => {
      const gods = graph.gods.slice(0, 12).map((g) => `  ${g.label}  (${g.degree} connections)  — ${g.cname}`).join("\n");
      const comms = Object.values(graph.communities).filter((v, i, a) => a.indexOf(v) === i).slice(0, 24).join(", ");
      return text(`Catalyst v${graph.meta.libraryVersion} — ${graph.meta.nodeCount} nodes, ${graph.meta.edgeCount} edges.\n\nCore abstractions (most connected):\n${gods}\n\nMain areas: ${comms}`);
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
    if (method === "notifications/initialized" || method === "notifications/cancelled") return; // notifications
    if (method === "ping") return reply(id, {});
    if (method === "tools/list") {
      return reply(id, {
        tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })),
      });
    }
    if (method === "tools/call") {
      const t = TOOLS[params && params.name];
      if (!t) return replyErr(id, -32602, `Unknown tool: ${params && params.name}`);
      const result = t.run(params.arguments || {});
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
log(`ready — ${Object.keys(TOOLS).length} tools, graph ${graph.meta.nodeCount} nodes`);
