// The editor's logic, without Monaco and without a DOM.
//
// What can be checked here is what a tab is called, when a file counts as unsaved, and the colour
// conversion the theme depends on. Everything else needs a window, so it is checked in the app.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createDirtyTracker,
  cursorLabel,
  detectIndent,
  indentLabel,
  languageLabel,
  mruStep,
  outlineSymbols,
  relativePath,
  splitPath,
  tabLabels,
  tabTitle,
  isBinaryPath,
  binaryNote,
  OUTLINE_LANGUAGES,
} from "./editor.js";
import { toHex } from "../theme.js";

test("a tab is called after its file", () => {
  assert.equal(tabTitle("C:\\dev\\Robot2027\\src\\main\\java\\frc\\robot\\Robot.java"), "Robot.java");
  assert.equal(tabTitle("C:/dev/Robot2027/build.gradle"), "build.gradle");
  assert.equal(tabTitle("Robot.java"), "Robot.java");
});

test("files with different names keep their plain names", () => {
  assert.deepEqual(
    tabLabels(["C:/p/src/Robot.java", "C:/p/build.gradle", "C:/p/vendordeps/FrcCatalyst.json"]),
    ["Robot.java", "build.gradle", "FrcCatalyst.json"],
  );
});

test("files with the same name take the parent that tells them apart", () => {
  // A robot project has several Constants.java, and a row of tabs that all say Constants.java tells
  // you nothing about which one you are about to overwrite.
  assert.deepEqual(
    tabLabels(["C:/p/src/main/java/frc/robot/subsystems/Constants.java", "C:/p/src/main/java/frc/robot/Constants.java"]),
    ["subsystems/Constants.java", "robot/Constants.java"],
  );
});

test("a label grows only as far as it needs to, and stops at three segments", () => {
  // Two build.gradle differing only above the third segment: the label stops being readable long
  // before it becomes unique, and the tab's tooltip carries the full path.
  const labels = tabLabels(["C:/a/one/sub/build.gradle", "C:/b/two/sub/build.gradle"]);
  assert.deepEqual(labels, ["one/sub/build.gradle", "two/sub/build.gradle"]);

  const same = tabLabels(["C:/x/deep/dir/file.java", "D:/y/deep/dir/file.java"]);
  assert.deepEqual(same, ["deep/dir/file.java", "deep/dir/file.java"]);
});

test("mixed separators still compare", () => {
  // Paths come back from the backend as Windows paths and are typed into code as forward slashes.
  assert.deepEqual(
    tabLabels(["C:\\p\\a\\Robot.java", "C:/p/b/Robot.java"]),
    ["a/Robot.java", "b/Robot.java"],
  );
});

test("a file is clean until it differs from what was written", () => {
  const dirt = createDirtyTracker();
  dirt.track("a.java", 1);
  assert.equal(dirt.isDirty("a.java", 1), false);
  assert.equal(dirt.isDirty("a.java", 2), true);
});

test("undoing back to the saved text leaves the file clean", () => {
  // Why the version id is compared instead of a boolean set on the first keystroke: monaco's
  // alternative version id returns to its earlier value when the edits are undone, and a file that
  // matches the disk is not unsaved work.
  const dirt = createDirtyTracker();
  dirt.track("a.java", 7);
  assert.equal(dirt.isDirty("a.java", 8), true);
  assert.equal(dirt.isDirty("a.java", 7), false);
});

test("saving moves the mark, and closing forgets the file", () => {
  const dirt = createDirtyTracker();
  dirt.track("a.java", 1);
  dirt.track("a.java", 5);                       // what a successful ws_write records
  assert.equal(dirt.isDirty("a.java", 5), false);
  assert.equal(dirt.isDirty("a.java", 1), true); // undoing past the save is an unsaved change again

  dirt.forget("a.java");
  assert.equal(dirt.knows("a.java"), false);
  // A file nobody opened is never reported as dirty, whatever version id is passed.
  assert.equal(dirt.isDirty("a.java", 99), false);
  assert.deepEqual(dirt.paths(), []);
});

// ---------- the theme's colour conversion ----------
//
// theme.js exists for the editor's theme: monaco reads hex and nothing else, so a token written as
// rgba() - which is how this identity writes its hairlines - is dropped with no error unless it is
// converted first. That is a silent-failure path, so it is checked here.

test("hex passes through, short forms expand", () => {
  assert.equal(toHex("#E9583D"), "#e9583d");
  assert.equal(toHex("  #fff  "), "#ffffff");
  assert.equal(toHex("#0D100E"), "#0d100e");
  assert.equal(toHex("#1a2b3c4d"), "#1a2b3c4d");
  assert.equal(toHex("#f80a"), "#ff8800aa");
});

test("rgb() and rgba() become the hex monaco reads", () => {
  assert.equal(toHex("rgb(233, 88, 61)"), "#e9583d");
  // The hairline token as the existing stylesheet writes it.
  assert.equal(toHex("rgba(228, 231, 225, 0.10)"), "#e4e7e11a");
  // A fully opaque colour keeps six digits: an eight-digit value is rejected by monaco's rules.
  assert.equal(toHex("rgba(228, 231, 225, 1)"), "#e4e7e1");
  assert.equal(toHex("rgb(255 0 0 / 50%)"), "#ff000080");
  assert.equal(toHex("rgb(100% 0% 0%)"), "#ff0000");
});

test("a colour the browser resolved comes back in color(srgb) form", () => {
  // What Chromium hands back for color-mix(in srgb, ...) once the probe in theme.js has asked it to
  // resolve a token this cannot parse. Measured, not assumed.
  assert.equal(toHex("color(srgb 0.350784 0.373333 0.356863)"), "#595f5b");
  assert.equal(toHex("color(srgb 1 0 0 / 0.5)"), "#ff000080");
  assert.equal(toHex("color(srgb 100% 0% 0%)"), "#ff0000");
  // Any other space is left to monaco's base rather than converted badly here.
  assert.equal(toHex("color(display-p3 1 0 0)"), null);
  assert.equal(toHex("oklch(0.7 0.1 250)"), null);
});

test("anything that is not a colour this can pin down returns null", () => {
  // The caller leaves the entry out of the theme, so monaco falls back to its base rather than to a
  // colour invented in JavaScript.
  for (const bad of [null, undefined, "", "   ", "var(--cat-ink)", "#12345", "rgb(1, 2)", "rgb(a, b, c)"]) {
    assert.equal(toHex(bad), null, `input: ${JSON.stringify(bad)}`);
  }
  // Named colours and color-mix() are real CSS but not parseable here; hexToken hands them to the
  // browser instead, which is the one thing that can resolve them.
  assert.equal(toHex("rebeccapurple"), null);
  assert.equal(toHex("color-mix(in srgb, #fff 20%, #000)"), null);
});

// --- files the editor declines ------------------------------------------------

test("a wrapper jar is recognised as binary before anything is read", () => {
  assert.equal(isBinaryPath("C:/robot/gradle/wrapper/gradle-wrapper.jar"), true);
  assert.equal(isBinaryPath("C:/robot/src/main/java/frc/robot/Robot.java"), false);
});

test("the extension is matched whatever its case, and a dotfile is not an extension", () => {
  assert.equal(isBinaryPath("art/Logo.PNG"), true);
  assert.equal(isBinaryPath("project/.gitignore"), false);
  assert.equal(isBinaryPath("project/Makefile"), false);
});

test("the note names the file and blames nobody", () => {
  assert.equal(binaryNote("C:/robot/gradle/wrapper/gradle-wrapper.jar"),
    "gradle-wrapper.jar is a binary file. The editor opens text.");
});

/* Every path the backend hands the editor on this machine is a Windows one, and the first version of
 * these two functions split on `/` alone — so the note read out the whole path. Both separators. */
test("a windows path is split on its own separator", () => {
  assert.equal(binaryNote("C:\\robot\\gradle\\wrapper\\gradle-wrapper.jar"),
    "gradle-wrapper.jar is a binary file. The editor opens text.");
  assert.equal(isBinaryPath("C:\\robot\\gradle\\wrapper\\gradle-wrapper.jar"), true);
  assert.equal(isBinaryPath("C:\\robot\\src\\main\\java\\frc\\robot\\Robot.java"), false);
});

// --- where the file is, which is the first thing the status bar says ----------

test("a file inside the project is named by its tail", () => {
  assert.equal(
    relativePath("C:/dev/Robot2027", "C:/dev/Robot2027/src/main/java/frc/robot/Robot.java"),
    "src/main/java/frc/robot/Robot.java",
  );
  // The backend hands back Windows paths and the project root is typed with forward slashes, or
  // the other way round, and on Windows the two spellings are one folder whatever the case.
  assert.equal(relativePath("c:\\dev\\robot2027", "C:/dev/Robot2027/build.gradle"), "build.gradle");
});

test("a file outside the project keeps its whole path, because that is the interesting fact", () => {
  assert.equal(relativePath("C:/dev/Robot2027", "C:/dev/Other/Robot.java"), "C:/dev/Other/Robot.java");
  // A prefix that only matches as text is a different folder: Robot2 is not inside Robot.
  assert.equal(relativePath("C:/dev/Robot", "C:/dev/Robot2/x.java"), "C:/dev/Robot2/x.java");
  // No root at all — the pane mounted before a project was picked.
  assert.equal(relativePath("", "C:/dev/Robot/x.java"), "C:/dev/Robot/x.java");
  // The root itself is not a file inside the root.
  assert.equal(relativePath("C:/dev/Robot", "C:/dev/Robot"), "C:/dev/Robot");
});

test("the folders give way and the file name does not", () => {
  assert.deepEqual(splitPath("src/main/java/frc/robot/Robot.java"),
    { dir: "src/main/java/frc/robot/", name: "Robot.java" });
  assert.deepEqual(splitPath("build.gradle"), { dir: "", name: "build.gradle" });
  assert.deepEqual(splitPath(""), { dir: "", name: "" });
});

// --- what the file is indented with ------------------------------------------

test("four-space Java is read as four spaces", () => {
  const java = [
    "package frc.robot;",
    "",
    "public class Robot extends TimedRobot {",
    "    private final Swerve drive = new Swerve();",
    "",
    "    @Override",
    "    public void teleopPeriodic() {",
    "        drive.drive(0.0, 0.0);",
    "    }",
    "}",
  ].join("\n");
  assert.deepEqual(detectIndent(java), { insertSpaces: true, size: 4 });
});

test("two-space JSON is read as two spaces", () => {
  const json = '{\n  "name": "FrcCatalyst",\n  "javaDependencies": [\n    {\n      "version": "2.0.0"\n    }\n  ]\n}';
  assert.deepEqual(detectIndent(json), { insertSpaces: true, size: 2 });
});

test("a tab-indented file is read as tabs", () => {
  const make = "all:\n\tgradlew build\n\tgradlew deploy\n\ntest:\n\tgradlew test\n";
  assert.deepEqual(detectIndent(make), { insertSpaces: false, size: 4 });
});

test("nothing to go on falls back to four, which is what every WPILib template writes", () => {
  assert.deepEqual(detectIndent(""), { insertSpaces: true, size: 4 });
  assert.deepEqual(detectIndent("one\ntwo\nthree\n"), { insertSpaces: true, size: 4 });
  assert.deepEqual(detectIndent(null), { insertSpaces: true, size: 4 });
});

test("a wrapped argument list does not turn a four-space file into a two-space one", () => {
  // The step of 2 is real — it is the continuation line — and it is outnumbered. A tie would also
  // go to 4, because re-indenting a whole file is the expensive mistake here.
  const java = [
    "class A {",
    "    void a() {",
    "        call(one,",
    "          two);",
    "    }",
    "    void b() {",
    "        call(three);",
    "    }",
    "}",
  ].join("\n");
  assert.equal(detectIndent(java).size, 4);
});

test("the status bar spells the indentation out", () => {
  assert.equal(indentLabel({ insertSpaces: true, size: 2 }), "Spaces: 2");
  assert.equal(indentLabel({ insertSpaces: false, size: 4 }), "Tabs");
  assert.equal(indentLabel(null), "");
});

// --- the rest of the status bar ----------------------------------------------

test("a language id becomes the name a person uses for it", () => {
  assert.equal(languageLabel("java"), "Java");
  assert.equal(languageLabel("json"), "JSON");
  assert.equal(languageLabel("groovy"), "Groovy");
  assert.equal(languageLabel("plaintext"), "Plain text");
  // `language_for` in the backend can grow an entry before this map does; a capitalised id is a
  // better answer than a blank in the status bar.
  assert.equal(languageLabel("zig"), "Zig");
  assert.equal(languageLabel(""), "Plain text");
});

test("the caret reads out, and says how much is selected", () => {
  assert.equal(cursorLabel(12, 5, null), "Ln 12, Col 5");
  assert.equal(cursorLabel(12, 5, { chars: 0, lines: 1 }), "Ln 12, Col 5");
  assert.equal(cursorLabel(12, 5, { chars: 18, lines: 1 }), "Ln 12, Col 5 · 18 selected");
  assert.equal(cursorLabel(12, 5, { chars: 90, lines: 3 }), "Ln 12, Col 5 · 3 lines selected");
});

// --- Ctrl+Tab ----------------------------------------------------------------

test("one press of Ctrl+Tab is the file you were in before this one", () => {
  const order = ["Robot.java", "Swerve.java", "build.gradle"];
  assert.equal(mruStep(order, 0), "Robot.java");
  assert.equal(mruStep(order, 1), "Swerve.java");
  assert.equal(mruStep(order, 2), "build.gradle");
});

test("holding Ctrl and pressing past either end wraps rather than stopping", () => {
  const order = ["a", "b", "c"];
  assert.equal(mruStep(order, 3), "a");
  assert.equal(mruStep(order, 4), "b");
  assert.equal(mruStep(order, -1), "c");        // Ctrl+Shift+Tab from the top of the list
  assert.equal(mruStep(order, -4), "c");
  assert.equal(mruStep([], 1), null);
  assert.equal(mruStep(null, 1), null);
  assert.equal(mruStep(["only"], 7), "only");
});

// --- the outline, which is the whole of Go to Symbol without a language service ---

test("a Java file gives up its types, methods, constructor and fields", () => {
  const java = [
    "package frc.robot;",
    "",
    "import frc.catalyst.Swerve;",
    "",
    "public class Robot extends TimedRobot {",
    "    public static final double MAX_SPEED = 4.5;",
    "    private final Swerve drive = new Swerve();",
    "",
    "    public Robot() {",
    "        super(0.02);",
    "    }",
    "",
    "    @Override",
    "    public void teleopPeriodic() {",
    "        if (driver.a()) {",
    "            drive.stop();",
    "        }",
    "    }",
    "}",
  ].join("\n");
  const found = outlineSymbols("java", java);
  assert.deepEqual(found.map((s) => [s.name, s.kind]), [
    ["Robot", "class"],
    ["MAX_SPEED", "constant"],
    ["drive", "field"],
    ["Robot", "constructor"],
    ["teleopPeriodic", "method"],
  ]);
  assert.equal(found[0].line, 5);
  assert.equal(found[4].line, 14);
});

test("a call is not a declaration, and neither is a control keyword", () => {
  // Every one of these is a line a regex outline gets wrong if it only looks for `name(`.
  const java = [
    "class A {",
    "    void go() {",
    "        drive.andThen(shoot);",
    "        if (ready) { start(); }",
    "        for (int i = 0; i < 4; i++) {}",
    "        while (busy()) {}",
    "        return new Command(this);",
    "    }",
    "}",
  ].join("\n");
  assert.deepEqual(outlineSymbols("java", java).map((s) => s.name), ["A", "go"]);
});

test("an interface, an enum and a record are types too", () => {
  const src = "public interface Io {}\npublic enum Mode { A, B }\npublic record Point(double x) {}";
  assert.deepEqual(outlineSymbols("java", src).map((s) => [s.name, s.kind]),
    [["Io", "interface"], ["Mode", "enum"], ["Point", "class"]]);
});

test("build.gradle gives up its blocks, which is the whole of navigating one", () => {
  const gradle = [
    "plugins {",
    "    id 'java'",
    "}",
    "",
    "dependencies {",
    "    implementation wpi.java.deps.wpilib()",
    "}",
    "",
    "def deployArtifact = 'frcJava'",
  ].join("\n");
  assert.deepEqual(outlineSymbols("groovy", gradle).map((s) => [s.name, s.kind]),
    [["plugins", "namespace"], ["dependencies", "namespace"], ["deployArtifact", "function"]]);
});

test("a vendordep gives up its top-level keys and none of the numbers under them", () => {
  const json = [
    "{",
    '  "name": "FrcCatalyst",',
    '  "version": "2.0.0-beta.2",',
    '  "javaDependencies": [',
    "    {",
    '      "artifactId": "catalyst",',
    '      "version": "2.0.0-beta.2"',
    "    }",
    "  ],",
    '  "frcYear": "2027"',
    "}",
  ].join("\n");
  assert.deepEqual(outlineSymbols("json", json).map((s) => s.name),
    ["name", "version", "javaDependencies", "frcYear"]);
});

test("a brace inside a JSON string does not move the depth", () => {
  const json = '{\n  "note": "a { brace } in text",\n  "after": 1\n}';
  assert.deepEqual(outlineSymbols("json", json).map((s) => s.name), ["note", "after"]);
});

test("markdown gives up its headings and python its defs", () => {
  assert.deepEqual(
    outlineSymbols("markdown", "# Title\ntext\n## Part one\n### Deeper\n").map((s) => [s.name, s.detail]),
    [["Title", "#"], ["Part one", "##"], ["Deeper", "###"]]);
  assert.deepEqual(
    outlineSymbols("python", "class Arm:\n    def raise_it(self):\n        pass\n").map((s) => [s.name, s.kind]),
    [["Arm", "class"], ["raise_it", "function"]]);
});

test("a language this cannot parse gets an empty outline rather than a wrong one", () => {
  assert.deepEqual(outlineSymbols("plaintext", "public class Robot {}"), []);
  assert.deepEqual(outlineSymbols("xml", "<project><name>x</name></project>"), []);
  assert.deepEqual(outlineSymbols("java", ""), []);
  assert.deepEqual(outlineSymbols("java", null), []);
});

test("every language the outline claims is one it can actually answer for", () => {
  // Registering the provider is what makes monaco's Ctrl+Shift+O available at all — its
  // precondition is `hasDocumentSymbolProvider` — so a language in this list that returns nothing
  // would offer a box that can never have anything in it.
  const samples = {
    java: "class A { void b() {} }",
    csharp: "public class A { public void B() {} }",
    kotlin: "class A {\n    fun b() {}\n}",
    groovy: "dependencies {\n}",
    python: "def a():\n    pass",
    markdown: "# A",
    json: '{\n  "a": 1\n}',
    javascript: "export function a() {}",
    typescript: "export class A {}",
  };
  for (const language of OUTLINE_LANGUAGES) {
    assert.ok(samples[language], `no sample for ${language}`);
    assert.ok(outlineSymbols(language, samples[language]).length > 0, `no symbols for ${language}`);
  }
});

// --- the @-mention handed to Claude --------------------------------------------

import { mentionFor } from "./editor.js";

const ROOT = "C:\\Users\\x\\dev\\Robot";
const FILE = "C:\\Users\\x\\dev\\Robot\\src\\main\\java\\frc\\robot\\Robot.java";
const sel = (startLineNumber, startColumn, endLineNumber, endColumn) =>
  ({ startLineNumber, startColumn, endLineNumber, endColumn });

test("a mention names the file relative to the project, forward-slashed", () => {
  assert.equal(mentionFor(ROOT, FILE, null), "@src/main/java/frc/robot/Robot.java ");
});

test("an empty selection is the whole file, not the line the caret is on", () => {
  assert.equal(mentionFor(ROOT, FILE, sel(12, 5, 12, 5)), "@src/main/java/frc/robot/Robot.java ");
});

test("a selection inside one line names that line", () => {
  assert.equal(mentionFor(ROOT, FILE, sel(42, 3, 42, 19)), "@src/main/java/frc/robot/Robot.java#L42 ");
});

test("a selection across lines names the range", () => {
  assert.equal(mentionFor(ROOT, FILE, sel(10, 1, 20, 8)), "@src/main/java/frc/robot/Robot.java#L10-20 ");
});

test("a selection dragged to the start of the next line does not count that line", () => {
  // Selecting lines 10 to 20 by dragging down the gutter ends at column 1 of line 21.
  assert.equal(mentionFor(ROOT, FILE, sel(10, 1, 21, 1)), "@src/main/java/frc/robot/Robot.java#L10-20 ");
  assert.equal(mentionFor(ROOT, FILE, sel(7, 1, 8, 1)), "@src/main/java/frc/robot/Robot.java#L7 ");
});

test("a root that differs only in drive-letter case still yields a relative mention", () => {
  assert.equal(mentionFor("c:\\users\\x\\dev\\robot", FILE, null), "@src/main/java/frc/robot/Robot.java ");
});
