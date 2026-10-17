// Refresh the offline MCP graph from a verified graphify export. No model or network calls.
// node scripts/bundle-graph.mjs <library-root>
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (!process.argv[2]) throw new Error("Provide the exact released library checkout.");
const library = resolve(process.argv[2]);
const raw = JSON.parse(readFileSync(join(library, "graphify-out/graph.json"), "utf8"));
const commit = execFileSync("git", ["-C", library, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (raw.built_at_commit !== commit) throw new Error("Graph is stale; run graphify update in the library first.");
const bundled = JSON.parse(readFileSync(join(root, "src-tauri/resources/FrcCatalyst.json"), "utf8"));
const version = readFileSync(join(library, "build.gradle"), "utf8").match(/^version\s*=\s*['"](.+?)['"]/m)?.[1];
if (version !== bundled.version) throw new Error("Graph source and bundled vendordep versions disagree.");
const nodes = raw.nodes.map(n => ({ id: n.id, label: n.label || n.id, type: n.file_type || "code",
  file: n.source_file || "", source_location: n.source_location || "", cname: n.community_name || "" }));
const edges = (raw.links || []).map(e => ({ s: e.source, t: e.target, r: e.relation || "related", confidence: e.confidence || "" }));
if (!nodes.length || !edges.length) throw new Error("Refusing an empty library graph.");
const ids = new Set(nodes.map(n => n.id));
if (edges.some(e => !ids.has(e.s) || !ids.has(e.t))) throw new Error("Graph contains an unresolved endpoint.");
const data = { meta: { libraryVersion: version, generated: new Date().toISOString().slice(0, 10),
  source: "graphify structural AST export; no LLM or network", nodeCount: nodes.length, edgeCount: edges.length },
  built_at_commit: commit, nodes, edges };
writeFileSync(join(root, "src-tauri/resources/mcp/data/graph.json"), JSON.stringify(data) + "\n");
console.log(`bundle-graph: ${nodes.length} nodes / ${edges.length} edges, FrcCatalyst ${version}, ${commit}`);
