import { test } from "node:test";
import assert from "node:assert/strict";

import { diffLines, hunks, stats, unified } from "./diff.js";

test("identical texts have no hunks", () => {
  assert.equal(unified("a\nb\n", "a\nb\n"), "");
  assert.deepEqual(hunks(diffLines("a\nb\n", "a\nb\n")), []);
});

test("a changed line reads as one removal and one addition, with context", () => {
  const old = ["one", "two", "three", "four", "five"].join("\n") + "\n";
  const neu = ["one", "two", "THREE", "four", "five"].join("\n") + "\n";
  assert.equal(unified(old, neu, { from: "old", to: "new", context: 1 }),
    "--- old\n+++ new\n@@ -2,3 +2,3 @@\n two\n-three\n+THREE\n four\n");
  assert.deepEqual(stats(diffLines(old, neu)), { added: 1, removed: 1 });
});

test("a brand-new file is all additions, numbered from line 1", () => {
  const h = hunks(diffLines("", "a\nb\n"));
  assert.equal(h.length, 1);
  assert.deepEqual([h[0].oldStart, h[0].oldLines, h[0].newStart, h[0].newLines], [0, 0, 1, 2]);
});

test("far-apart changes make separate hunks", () => {
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
  const changed = lines.slice();
  changed[2] = "early";
  changed[27] = "late";
  const h = hunks(diffLines(lines.join("\n"), changed.join("\n")), 3);
  assert.equal(h.length, 2);
  assert.equal(h[0].oldStart, 1);
  assert.equal(h[1].oldStart, 25);
});

test("CRLF and LF with the same words are the same text", () => {
  assert.equal(unified("a\r\nb\r\n", "a\nb\n"), "");
});
