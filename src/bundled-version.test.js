import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LIB_VERSION } from "./js/data.js";

const root = new URL("../", import.meta.url);
const read = path => readFileSync(new URL(path, root), "utf8");
test("bundled library labels, vendordep, docs and graph describe the same version", () => {
  const dep = JSON.parse(read("src-tauri/resources/FrcCatalyst.json"));
  const docs = JSON.parse(read("src-tauri/resources/mcp/data/docs.json"));
  const graph = JSON.parse(read("src-tauri/resources/mcp/data/graph.json"));
  assert.equal(LIB_VERSION, dep.version);
  assert.equal(docs.libraryVersion, dep.version);
  assert.equal(graph.meta.libraryVersion, dep.version);
  const html = read("src/index.html");
  assert.ok(html.includes(`<code>v${dep.version}</code>`), "install notice names the bundled release");
  assert.ok(html.includes(`class="cat-wordmark__version">${dep.version}</span>`), "release card names the bundled release");
  assert.doesNotMatch(html, /never been driven on a robot|beta 14/, "current page does not repeat stale stack claims");
  assert.ok(graph.built_at_commit && graph.nodes.length > 0 && graph.edges.length > 0);
});
