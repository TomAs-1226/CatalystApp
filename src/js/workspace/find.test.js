// The parts of Find that decide what a result says, tested without a DOM or a backend.

import { test } from "node:test";
import assert from "node:assert/strict";

import { countNote, groupByFile, markedLine, relativeTo } from "./find.js";

test("hits are grouped by the file they are in, in the order they arrived", () => {
  const groups = groupByFile([
    { path: "C:/robot/A.java", line: 3, text: "kElevatorId" },
    { path: "C:/robot/B.java", line: 9, text: "kElevatorId" },
    { path: "C:/robot/A.java", line: 40, text: "kElevatorId again" },
  ]);

  assert.deepEqual(groups.map((g) => g.path), ["C:/robot/A.java", "C:/robot/B.java"]);
  assert.deepEqual(groups[0].rows.map((r) => r.line), [3, 40]);
});

test("nothing found is an empty list, not a group with no rows", () => {
  assert.deepEqual(groupByFile([]), []);
  assert.deepEqual(groupByFile(undefined), []);
});

test("a path reads as it does inside the project", () => {
  assert.equal(relativeTo("C:/robot", "C:/robot/src/main/java/Robot.java"), "src/main/java/Robot.java");
  assert.equal(relativeTo("C:/robot/", "C:/robot/build.gradle"), "build.gradle");
  // Windows hands back whichever case the user typed; the file is the same file.
  assert.equal(relativeTo("c:/robot", "C:/Robot/build.gradle"), "build.gradle");
  // A path from somewhere else is left alone rather than mangled into a wrong relative one.
  assert.equal(relativeTo("C:/robot", "D:/other/build.gradle"), "D:/other/build.gradle");
});

test("the match is marked, and the line is escaped before it is", () => {
  assert.equal(markedLine("  int kId = 5;  ", "kid"), "int <mark>kId</mark> = 5;");
  // Source code is not markup: a generic in Java must not open a tag.
  assert.equal(markedLine("List<String> names;", "String"), "List&lt;<mark>String</mark>&gt; names;");
  assert.equal(markedLine("nothing to mark", ""), "nothing to mark");
});

test("a very long line is cut rather than allowed to stretch the pane", () => {
  const long = "x".repeat(400);
  assert.equal(markedLine(long, "").length, 240);
});

test("the count says what it is, and says when it stopped counting", () => {
  assert.equal(countNote(0), "nothing");
  assert.equal(countNote(1), "1 hit");
  assert.equal(countNote(12), "12 hits");
  assert.equal(countNote(200, true), "first 200");
});
