import { test } from "node:test";
import assert from "node:assert/strict";

import { cliSearchPlaces, isReady, normalizeStatus, prepareSummary, statusChips } from "./agent.js";

const READY = {
  cli_path: "C:\\Users\\x\\AppData\\Roaming\\Claude\\claude-code\\2.1.271\\claude.exe",
  cli_version: "2.1.271",
  mcp_wired: true,
  claude_md: true,
  project_registered: true,
};

// --- reading the status -----------------------------------------------------

test("an AgentStatus is understood in either spelling", () => {
  // serde keeps the Rust field names unless the struct carries rename_all = "camelCase", and which
  // of those the backend ends up with is not this module's decision. Guessing wrong would paint a
  // strip reporting everything missing on a machine where everything is present.
  const snake = normalizeStatus(READY);
  const camel = normalizeStatus({
    cliPath: READY.cli_path,
    cliVersion: "2.1.271",
    mcpWired: true,
    claudeMd: true,
    projectRegistered: true,
  });
  assert.deepEqual(snake, camel);
  assert.equal(snake.cli_version, "2.1.271");
});

test("a missing status reads as nothing found, not as ready", () => {
  for (const nothing of [null, undefined, "", 7, []]) {
    const s = normalizeStatus(nothing);
    assert.equal(s.cli_path, null);
    assert.equal(s.mcp_wired, false);
    assert.equal(isReady(nothing), false);
  }
});

test("an empty cli_path is not a CLI", () => {
  // The backend types it Option<String>; an empty string that slipped through must not light the
  // chip green and open a terminal on nothing.
  assert.equal(normalizeStatus({ cli_path: "" }).cli_path, null);
  assert.equal(normalizeStatus({ cli_path: "   " }).cli_path, null);
  assert.equal(isReady({ ...READY, cli_path: "" }), false);
});

test("ready means all four, not three", () => {
  assert.equal(isReady(READY), true);
  for (const key of ["cli_path", "mcp_wired", "claude_md", "project_registered"]) {
    const broken = { ...READY, [key]: key === "cli_path" ? null : false };
    assert.equal(isReady(broken), false, `${key} missing must not read as ready`);
  }
});

// --- the strip --------------------------------------------------------------

test("the strip carries the four facts that decide whether the answers will be about this project", () => {
  const chips = statusChips(READY);
  assert.deepEqual(chips.map((c) => c.id), ["cli", "mcp", "claudemd", "registered"]);
  for (const chip of chips) assert.equal(chip.tone, "ok");
  assert.equal(chips[0].value, "2.1.271", "the version is the value when there is one");
  assert.equal(chips[0].detail, READY.cli_path);
});

test("a CLI with no version still reads as found", () => {
  const chip = statusChips({ ...READY, cli_version: null })[0];
  assert.equal(chip.tone, "ok");
  assert.equal(chip.value, "found");
});

test("a missing CLI is bad and an unwired server is a warning", () => {
  // They are not the same severity. No CLI means no pane at all; an unwired MCP server means a
  // session that answers fluently out of training data about a library whose API has changed.
  const chips = statusChips({ cli_path: null, mcp_wired: false, claude_md: false, project_registered: false });
  const byId = Object.fromEntries(chips.map((c) => [c.id, c]));
  assert.equal(byId.cli.tone, "bad");
  assert.equal(byId.cli.value, "not found");
  assert.equal(byId.mcp.tone, "warn");
  assert.equal(byId.claudemd.tone, "warn");
  assert.equal(byId.registered.tone, "warn");
  assert.ok(byId.mcp.detail, "an unwired server has to say what that costs");
});

test("the places the app looked are listed in the order it looked, env var first", () => {
  // "Claude Code was not found" with no list is unactionable, and the way out - the environment
  // variable - is the first thing tried.
  const places = cliSearchPlaces();
  assert.equal(places.length, 3);
  assert.match(places[0], /CATALYST_CLAUDE_EXE/);
  assert.match(places[1], /PATH/);
  assert.match(places[2], /claude-code/);
});

// --- what prepare did -------------------------------------------------------

test("prepare reports wiring the server and writing CLAUDE.md", () => {
  const before = { cli_path: "x", mcp_wired: false, claude_md: false, project_registered: true };
  const after = { ...before, mcp_wired: true, claude_md: true };
  const summary = prepareSummary(before, after);
  assert.match(summary, /wired the Catalyst MCP server/);
  assert.match(summary, /wrote CLAUDE.md/);
});

test("an existing CLAUDE.md is reported as left alone, not as written", () => {
  // agent_prepare never overwrites one. Saying "wrote CLAUDE.md" when it did not is how someone
  // goes looking for instructions that were never added.
  const before = { cli_path: "x", mcp_wired: true, claude_md: true, project_registered: true };
  const summary = prepareSummary(before, before);
  assert.match(summary, /left the existing CLAUDE.md alone/);
  assert.doesNotMatch(summary, /wrote CLAUDE.md/);
});

test("prepare says so when it did not manage to fix something", () => {
  const before = { cli_path: "x", mcp_wired: false, claude_md: false, project_registered: false };
  const summary = prepareSummary(before, before);
  assert.match(summary, /could not wire the MCP server/);
  assert.match(summary, /CLAUDE.md is still missing/);
  assert.match(summary, /registry/, "an unregistered folder is the reason writes will be refused");
});

test("a summary is always a sentence, never an empty string", () => {
  assert.ok(prepareSummary(null, null).length > 0);
  assert.ok(prepareSummary(READY, READY).length > 0);
});
