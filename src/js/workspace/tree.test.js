// The file tree's logic, without a DOM.
//
// Only the pure parts are here: what the rows are and in what order, which is the same thing as
// what the arrow keys do. Everything that needs a window is left to the app.

import { test } from "node:test";
import assert from "node:assert/strict";

import { baseName, fileGlyph, flattenTree, mergeChildren, sortNodes } from "./tree.js";

test("the root label is the folder's own name, whichever separator the path uses", () => {
  assert.equal(baseName("C:\\Users\\yu_th\\dev\\Robot2027"), "Robot2027");
  assert.equal(baseName("C:/Users/yu_th/dev/Robot2027"), "Robot2027");
  // A trailing separator is how a path arrives from a folder picker.
  assert.equal(baseName("C:/dev/Robot2027/"), "Robot2027");
  assert.equal(baseName("C:\\"), "C:");
  assert.equal(baseName(""), "");
});

test("a file's glyph names its type", () => {
  assert.deepEqual(fileGlyph("Robot.java"), { glyph: "J", type: "java" });
  assert.deepEqual(fileGlyph("build.gradle"), { glyph: "G", type: "gradle" });
  assert.deepEqual(fileGlyph("FrcCatalyst.json"), { glyph: "{", type: "json" });
});

test("a dotfile is a name, not an extension", () => {
  // .gitignore read as an extension would put a G in the box next to build.gradle's G, which is
  // exactly the confusion the letter exists to prevent.
  assert.deepEqual(fileGlyph(".gitignore"), { glyph: "\u00b7", type: "plain" });
  assert.deepEqual(fileGlyph("gradlew"), { glyph: "\u00b7", type: "plain" });
  assert.deepEqual(fileGlyph("notes."), { glyph: "\u00b7", type: "plain" });
});

test("an unknown extension still gets a letter rather than nothing", () => {
  assert.deepEqual(fileGlyph("robot.chor"), { glyph: "C", type: "choreo" });
  assert.deepEqual(fileGlyph("field.wpilog"), { glyph: "W", type: "wpilog" });
});

test("directories sort first, then by name, ignoring case", () => {
  const nodes = [
    { name: "build.gradle", path: "p/build.gradle", dir: false },
    { name: "src", path: "p/src", dir: true },
    { name: "README.md", path: "p/README.md", dir: false },
    { name: ".wpilib", path: "p/.wpilib", dir: true },
  ];
  // README.md sorts as "readme", after build.gradle - a capitalised file does not jump the queue the
  // way a plain string sort would put every upper-case name first.
  assert.deepEqual(sortNodes(nodes).map((n) => n.name), [".wpilib", "src", "build.gradle", "README.md"]);
  // The input is left alone: the caller may still be drawing from it.
  assert.equal(nodes[0].name, "build.gradle");
});

test("a re-read level keeps what was already read underneath it", () => {
  const previous = [
    { name: "main", path: "p/src/main", dir: true, children: [{ name: "java", path: "p/src/main/java", dir: true, children: null }] },
    { name: "test", path: "p/src/test", dir: true, children: [] },
  ];
  const incoming = [
    { name: "test", path: "p/src/test", dir: true },
    { name: "main", path: "p/src/main", dir: true },
    { name: "notes.md", path: "p/src/notes.md", dir: false },
  ];
  const merged = mergeChildren(previous, incoming);

  assert.deepEqual(merged.map((n) => n.name), ["main", "test", "notes.md"]);
  // Refreshing src/ must not collapse everything the user had opened below it.
  assert.equal(merged[0].children.length, 1);
  assert.deepEqual(merged[1].children, []);
  assert.equal(merged[2].children, null);
  // Nothing in the caller's arrays is touched.
  assert.equal(previous[0].children.length, 1);
  assert.equal(incoming[0].children, undefined);
});

test("a directory that is gone takes its subtree with it", () => {
  const previous = [{ name: "old", path: "p/old", dir: true, children: [{ name: "x", path: "p/old/x", dir: false }] }];
  const merged = mergeChildren(previous, [{ name: "new", path: "p/new", dir: true }]);
  assert.deepEqual(merged.map((n) => n.path), ["p/new"]);
  assert.equal(merged[0].children, null);
});

test("a file that became a directory is read again rather than reusing the old children", () => {
  const previous = [{ name: "tools", path: "p/tools", dir: false, children: [{ name: "stale", path: "p/tools/stale", dir: false }] }];
  const merged = mergeChildren(previous, [{ name: "tools", path: "p/tools", dir: true }]);
  assert.equal(merged[0].children, null);
});

const project = {
  name: "Robot2027",
  path: "p",
  dir: true,
  children: [
    { name: "src", path: "p/src", dir: true, children: [{ name: "Robot.java", path: "p/src/Robot.java", dir: false }] },
    { name: "vendordeps", path: "p/vendordeps", dir: true, children: [] },
    { name: "build.gradle", path: "p/build.gradle", dir: false },
  ],
};

test("rows come out in the order the arrow keys move through", () => {
  const rows = flattenTree({ root: project, open: new Set(["p", "p/src"]) });
  assert.deepEqual(rows.map((r) => r.path), ["p", "p/src", "p/src/Robot.java", "p/vendordeps", "p/build.gradle"]);
  assert.deepEqual(rows.map((r) => r.depth), [0, 1, 2, 1, 1]);
  assert.ok(rows.every((r) => r.kind === "node"));
});

test("a closed folder contributes one row and nothing else", () => {
  const rows = flattenTree({ root: project, open: new Set(["p"]) });
  assert.deepEqual(rows.map((r) => r.path), ["p", "p/src", "p/vendordeps", "p/build.gradle"]);
});

test("an empty folder says so, and an unread one says nothing yet", () => {
  // "empty" is a claim about the filesystem and is only made when ws_tree returned no children.
  const rows = flattenTree({ root: project, open: new Set(["p", "p/vendordeps"]) });
  const note = rows.find((r) => r.kind === "empty");
  assert.equal(note.path, "p/vendordeps");
  assert.equal(note.depth, 2);

  const unread = { name: "r", path: "r", dir: true, children: null };
  assert.deepEqual(flattenTree({ root: unread, open: new Set(["r"]) }).map((r) => r.kind), ["node"]);
  assert.deepEqual(
    flattenTree({ root: unread, open: new Set(["r"]), pending: new Set(["r"]) }).map((r) => r.kind),
    ["node", "pending"],
  );
});

test("a directory that could not be read shows the reason, not an empty folder", () => {
  // The rule this module exists for. An unreadable folder and an empty one look identical once the
  // error is dropped, and the difference is the whole question.
  const errors = new Map([["p/src", "Access is denied. (os error 5)"]]);
  const rows = flattenTree({ root: project, open: new Set(["p", "p/src"]), errors });
  const bad = rows.find((r) => r.kind === "error");
  assert.equal(bad.message, "Access is denied. (os error 5)");
  assert.equal(bad.depth, 2);
  // And the children it did have from an earlier read are not drawn as if the folder were fine.
  assert.equal(rows.some((r) => r.path === "p/src/Robot.java"), false);
});
