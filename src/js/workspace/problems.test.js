// The Problems pane's reading of build output, without a DOM.
//
// The fixtures were captured, not written from memory: Gradle 9.7.1 and 8.11 building a project with
// three mistakes in it - a method that does not exist, a String assigned to an int on a tab-indented
// line, and a constructor marked for removal - through a pipe, through the rich console, and through
// ConPTY the way the app's terminal runs it. They are trimmed and the paths are replaced; every other
// byte is one that Gradle or ConPTY sent. Real output is stranger than anyone remembers it: javac ends
// lines with `\n` inside an error and `\r\n` after it, Gradle prints every error twice, the rich console
// glues the first one onto its progress bar, and ConPTY cuts long lines at the terminal's edge.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildFailed,
  copyText,
  createCollector,
  displayOrder,
  parseProblems,
  relativize,
  severityRank,
  stripAnsi,
  summarize,
} from "./problems.js";

const ROOT = "C:\\Users\\student\\dev\\Robot 2027";
const ROBOT = `${ROOT}\\src\\main\\java\\frc\\robot\\Robot.java`;

// Gradle 9.7.1, --console=plain, from the failing task to the end.
const GRADLE_9_PLAIN = [
  "> Task :compileJava FAILED\r\n",
  `${ROBOT}:9: error: cannot find symbol\n`,
  "    m_drive.foo();\n",
  "           ^\n",
  "  symbol:   method foo()\n",
  "  location: variable m_drive of type Drive\r\n",
  `${ROBOT}:10: error: incompatible types: String cannot be converted to int\n`,
  "\tint x = \"tabbed\";\n",
  "\t        ^\r\n",
  `${ROBOT}:11: warning: [removal] Integer(int) in Integer has been deprecated and marked for removal\n`,
  "    Integer boxed = new Integer(5);\n",
  "                    ^\r\n",
  "2 errors\r\n",
  "1 warning\r\n",
  "\r\n",
  "[Incubating] Problems report is available at: file:///C:/Users/student/dev/Robot%202027/build/reports/problems/problems-report.html\r\n",
  "\r\n",
  "FAILURE: Build failed with an exception.\r\n",
  "\r\n",
  "* What went wrong:\r\n",
  "Execution failed for task ':compileJava' (registered by plugin class 'org.gradle.api.plugins.JavaBasePlugin').\r\n",
  "> Compilation failed; see the compiler output below.\r\n",
  `  ${ROBOT}:10: error: incompatible types: String cannot be converted to int\n`,
  "  \tint x = \"tabbed\";\n",
  "  \t        ^\r\n",
  `  ${ROBOT}:11: warning: [removal] Integer(int) in Integer has been deprecated and marked for removal\n`,
  "      Integer boxed = new Integer(5);\n",
  "                      ^\r\n",
  `  ${ROBOT}:9: error: cannot find symbol\n`,
  "      m_drive.foo();\n",
  "             ^\n",
  "    symbol:   method foo()\n",
  "    location: variable m_drive of type Drive\r\n",
  "  2 errors\r\n",
  "  1 warning\r\n",
  "\r\n",
  "* Try:\r\n",
  "> Check your code and dependencies to fix the compilation error(s)\r\n",
  "> Run with --scan to get full insights from a Build Scan (powered by Develocity).\r\n",
  "\r\n",
  "BUILD FAILED in 10s\r\n",
  "1 actionable task: 1 executed\r\n",
].join("");

// Gradle 8.11, --console=rich, from the moment the compiler starts to the end. The first error is on
// the same line as the progress bar here; only escape sequences separate them.
const GRADLE_8_RICH = [
  `\u001b[2A\u001b[1m<\u001b[0;1m-------------> 0% EXECUTING [4s]\u001b[m\u001b[0K\u001b[33D\u001b[1B\u001b[1m> :compileJava\u001b[m\u001b[14D\u001b[1B${ROBOT}:9: error: cannot find symbol\r\n`,
  "    m_drive.foo();\r\n",
  "           ^\r\n",
  "  symbol:   method foo()\r\n",
  "  location: variable m_drive of type Drive\r\n",
  `${ROBOT}:10: error: incompatible types: String cannot be converted to int\r\n`,
  "        int x = \"tabbed\";\r\n",
  "                ^\r\n",
  "\u001b[2A\u001b[0K\r\n",
  "\u001b[31;1m> Task :compileJava\u001b[0;39m\u001b[31m FAILED\u001b[39m\u001b[0K\r\n",
  `${ROBOT}:11: warning: [removal] Integer(int) in Integer has been deprecated and marked for removal\r\n`,
  "    Integer boxed = new Integer(5);\r\n",
  "                    ^\r\n",
  "2 errors\r\n",
  "1 warning\r\n",
  "\r\n",
  "\u001b[31mFAILURE: \u001b[39m\u001b[31mBuild failed with an exception.\u001b[39m\r\n",
  "\r\n",
  "* What went wrong:\r\n",
  "Execution failed for task ':compileJava'.\r\n",
  "\u001b[33m> \u001b[39mCompilation failed; see the compiler output below.\r\n",
  `  ${ROBOT}:10: error: incompatible types: String cannot be converted to int\r\n`,
  "        int x = \"tabbed\";\r\n",
  "                ^\r\n",
  `  ${ROBOT}:11: warning: [removal] Integer(int) in Integer has been deprecated and marked for removal\r\n`,
  "      Integer boxed = new Integer(5);\r\n",
  "                      ^\r\n",
  `  ${ROBOT}:9: error: cannot find symbol\r\n`,
  "      m_drive.foo();\r\n",
  "             ^\r\n",
  "    symbol:   method foo()\r\n",
  "    location: variable m_drive of type Drive\r\n",
  "  2 errors\r\n",
  "  1 warning\r\n",
  "\r\n",
  "* Try:\r\n",
  "\u001b[33m> \u001b[39mCheck your code and dependencies to fix the compilation error(s)\r\n",
  "\u001b[33m> \u001b[39mRun with [Incubating] Problems report is available at: file:///C:/Users/student/dev/Robot%202027/build/reports/problems/problems-report.html\r\n",
  "1 actionable task: 1 executed\r\n",
  "\u001b[0K\r\n",
  "\u001b[0K\r\n",
  "\u001b[2A\u001b[1m<\u001b[0;31;1m=============\u001b[0;39;1m> 100% EXECUTING [5s]\u001b[m\u001b[35D\u001b[1B> IDLE\u001b[6D\u001b[1B\u001b[2A\u001b[1m<\u001b[0;1m-------------> 0% WAITING\u001b[m\u001b[0K\u001b[26D\u001b[2B\u001b[1m--scan\u001b[m to get full insights.\r\n",
  "\r\n",
  "\u001b[31;1mBUILD FAILED\u001b[0;39m in 8s\r\n",
  "\u001b[2A\u001b[2K\u001b[1B\u001b[2K\u001b[1A",
].join("");

// Gradle 9.7.1 over a build.gradle.kts whose third line calls a function that does not exist.
const KOTLIN_DSL = [
  "\r\n",
  "> Configure project :\r\n",
  "e: file:///C:/Users/student/dev/Robot%202027/build.gradle.kts:3:1: Unresolved reference 'foo'.\r\n",
  "\r\n",
  "FAILURE: Build failed with an exception.\r\n",
  "\r\n",
  "* Where:\r\n",
  `Build file '${ROOT}\\build.gradle.kts' line: 3\r\n`,
  "\r\n",
  "* What went wrong:\r\n",
  "Script compilation error:\n",
  "\n",
  "  Line 3: foo()\n",
  "          ^ Unresolved reference 'foo'.\n",
  "\n",
  "1 error\r\n",
  "\r\n",
  "* Try:\r\n",
  "> Run with --stacktrace option to get the stack trace.\r\n",
  "\r\n",
  "BUILD FAILED in 14s\r\n",
].join("");

// Gradle 9.7.1 over a build.gradle that does the same.
const GROOVY_DSL = [
  "\r\n",
  "FAILURE: Build failed with an exception.\r\n",
  "\r\n",
  "* Where:\r\n",
  `Build file '${ROOT}\\build.gradle' line: 3\r\n`,
  "\r\n",
  "* What went wrong:\r\n",
  "A problem occurred evaluating root project 'Robot2027'.\r\n",
  "> Could not find method foo() for arguments [] on root project 'Robot2027' of type org.gradle.api.Project.\r\n",
  "\r\n",
  "* Try:\r\n",
  "> Run with --stacktrace option to get the stack trace.\r\n",
  "\r\n",
  "BUILD FAILED in 1s\r\n",
].join("");

/**
 * `line` cut the way ConPTY cuts a line wider than the terminal once the screen has scrolled. Captured
 * at 80 columns, it reads `…plugin class 'org.gradle` CR LF `ESC[11;80H` `e.api.plugins…`: the full
 * row, a line break, a jump back to that row's last column, and that column's character a second time.
 */
function conptyWrap(line, width) {
  let out = line.slice(0, width);
  for (let at = width; at < line.length; at += width) {
    out += `\r\n\u001b[11;${width}H${line[at - 1]}${line.slice(at, at + width)}`;
  }
  return out;
}

const fields = ({ raw, ...rest }) => rest;

// --- javac, as Gradle prints it --------------------------------------------------

test("a javac error is found at its line, with the column its caret points at", () => {
  const [first] = parseProblems(GRADLE_9_PLAIN);
  assert.equal(first.file, ROBOT);
  assert.equal(first.line, 9);
  assert.equal(first.col, 12, "the caret sits under the dot in m_drive.foo()");
  assert.equal(first.severity, "error");
});

test("the source excerpt and the caret belong to their error and are never problems themselves", () => {
  const problems = parseProblems(GRADLE_9_PLAIN);
  assert.equal(problems.length, 3);
  // They travel in raw, because that is the context whoever is asked to explain the error needs.
  assert.match(problems[0].raw, /m_drive\.foo\(\);\n {11}\^/);
});

test("symbol and location stay with the error they explain", () => {
  // "cannot find symbol" on its own does not say which symbol, and which symbol is the whole question.
  const [first] = parseProblems(GRADLE_9_PLAIN);
  assert.equal(first.message, "cannot find symbol\nsymbol:   method foo()\nlocation: variable m_drive of type Drive");
});

test("a javac warning is a warning", () => {
  assert.deepEqual(fields(parseProblems(GRADLE_9_PLAIN)[2]), {
    file: ROBOT,
    line: 11,
    col: 21,
    severity: "warning",
    message: "[removal] Integer(int) in Integer has been deprecated and marked for removal",
  });
});

test("a caret under a tab-indented line counts the tab as one character", () => {
  // javac copies the tab into the caret line so the caret lines up. Counted as eight columns, it would
  // put the cursor seven characters to the right of the mistake.
  assert.equal(parseProblems(GRADLE_9_PLAIN)[1].col, 10);
});

test("Gradle's second copy of every error, under What went wrong, adds nothing", () => {
  // Gradle 8.11 and later print the compiler's output again, indented and in another order. The list
  // keeps the order javac printed them in the first time.
  assert.deepEqual(parseProblems(GRADLE_9_PLAIN).map((p) => p.line), [9, 10, 11]);
  // Nor for a project on a school's network share, whose path has no drive letter to trip over.
  const shared = GRADLE_9_PLAIN.split(ROOT).join("\\\\team-nas\\robots\\Robot 2027");
  assert.deepEqual(parseProblems(shared).map((p) => [p.file.slice(0, 11), p.line]), [
    ["\\\\team-nas\\", 9],
    ["\\\\team-nas\\", 10],
    ["\\\\team-nas\\", 11],
  ]);
});

// --- Gradle's rich console --------------------------------------------------------

test("an error printed straight after the progress bar is still found", () => {
  // Gradle moves back and down with escape sequences instead of printing a newline, so in the raw text
  // the first error begins on the same line as `> :compileJava`.
  const problems = parseProblems(GRADLE_8_RICH);
  assert.deepEqual(problems.map((p) => [p.line, p.col, p.severity]), [
    [9, 12, "error"],
    // The rich console expanded the tab before the caret was drawn under it, so this column is the
    // one on screen. The line is still the right line.
    [10, 17, "error"],
    [11, 21, "warning"],
  ]);
});

test("a progress bar repainted in the middle of an error costs it neither its column nor its details", () => {
  // Both bars exactly as captured: Gradle 9 draws `[###]`, Gradle 8 draws `<===>`.
  const bar9 = "\u001b[2A\u001b[1m[\u001b[0;1m###############\u001b[0;1m] 100% EXECUTING [217ms]\u001b[m\u001b[40D\u001b[1B> IDLE\u001b[6D\u001b[1B\u001b[2A\u001b[0K\r\n";
  const bar8 = "\u001b[2A\u001b[1m<\u001b[0;31;1m=============\u001b[0;39;1m> 100% EXECUTING [5s]\u001b[m\u001b[35D\u001b[1B> IDLE\u001b[6D\u001b[1B\r\n";
  const text =
    `${ROBOT}:9: error: cannot find symbol\n` + bar9 +
    "    m_drive.foo();\n" + bar8 +
    "           ^\n" + bar9 +
    "  symbol:   method foo()\n" + bar8 +
    "  location: variable m_drive of type Drive\r\n" +
    "1 error\r\n";
  const [problem] = parseProblems(text);
  assert.equal(problem.col, 12);
  assert.equal(problem.message, "cannot find symbol\nsymbol:   method foo()\nlocation: variable m_drive of type Drive");
});

// --- ConPTY -----------------------------------------------------------------------

test("a line ConPTY continued at the terminal's edge reads as one line again", () => {
  // Byte for byte from an 80-column capture.
  assert.equal(
    stripAnsi("Execution failed for task ':compileJava' (registered by plugin class 'org.gradle\r\n\u001b[11;80He.api.plugins.JavaBasePlugin').\r\n"),
    "Execution failed for task ':compileJava' (registered by plugin class 'org.gradle.api.plugins.JavaBasePlugin').\r\n",
  );
  assert.equal(stripAnsi(" and marked \r\n\u001b[11;80H for removal"), " and marked for removal");
});

test("a javac error wider than the terminal is still found once the screen has scrolled", () => {
  // Every path in a robot project is wider than a dock terminal, and every build is long enough to
  // scroll. Read as three lines, this error is not an error at all.
  const header = `${ROBOT}:10: error: incompatible types: String cannot be converted to int`;
  const text = `${conptyWrap(header, 40)}\r\n        int x = "tabbed";\r\n                ^\r\n1 error\r\n`;
  assert.deepEqual(parseProblems(text).map(fields), [
    { file: ROBOT, line: 10, col: 17, severity: "error", message: "incompatible types: String cannot be converted to int" },
  ]);
});

test("a jump to column 1 after a line break is a repaint, not a continuation", () => {
  assert.equal(stripAnsi("abc\r\n\u001b[5;1Hcdef"), "abc\r\n\ncdef");
});

test("a caret drawn by stepping the cursor right lands in the same column", () => {
  // A console skips blank cells with ESC[nC rather than printing spaces into them.
  const text = `${ROBOT}:9: error: cannot find symbol\r\n    m_drive.foo();\r\n\u001b[11C^\r\n1 error\r\n`;
  assert.equal(parseProblems(text)[0].col, 12);
});

test("ConPTY's opening sequence is not output", () => {
  // Captured as the first 86 bytes a pseudoconsole sends.
  const opening = "\u001b[?9001h\u001b[?1004h\u001b[?25l\u001b[?9001l\u001b[?1004l\u001b[2J\u001b[m\u001b[H\u001b]0;C:\\WINDOWS\\SYSTEM32\\cmd.exe\u0007\u001b[?25h";
  assert.equal(stripAnsi(opening).trim(), "");
  assert.deepEqual(parseProblems(opening), []);
});

// --- other compilers, and Gradle's own reports ----------------------------------------

test("Kotlin's e: line is a problem, with its file URL turned back into a path", () => {
  // The URL-encoded space and the slash in front of the drive are both undone; `/C:/Users` opens nothing.
  assert.deepEqual(parseProblems(KOTLIN_DSL).map(fields), [
    { file: "C:/Users/student/dev/Robot 2027/build.gradle.kts", line: 3, col: 1, severity: "error", message: "Unresolved reference 'foo'." },
  ], "Gradle's Where for the same line must not add a second, vaguer row");
});

test("w: is a Kotlin warning, and a column with no colon after it reads the same", () => {
  const [problem] = parseProblems("w: file:///C:/Users/student/dev/Robot%202027/src/main/kotlin/Drive.kt:12:5 'arcade' is deprecated.\r\n");
  assert.deepEqual(fields(problem), {
    file: "C:/Users/student/dev/Robot 2027/src/main/kotlin/Drive.kt",
    line: 12,
    col: 5,
    severity: "warning",
    message: "'arcade' is deprecated.",
  });
});

test("a compiler that prints its own column keeps the column it printed", () => {
  // GCC, for a C++ robot project. Its excerpt and caret look nothing like javac's and must not move it.
  const text = [
    `${ROOT}\\src\\main\\cpp\\Robot.cpp:12:5: error: 'foo' was not declared in this scope`,
    "   12 |     foo();",
    "      |     ^~~",
    `${ROOT}\\src\\main\\include\\Robot.h:3:10: fatal error: frc/TimedRobot.hh: No such file or directory`,
    `${ROOT}\\src\\main\\cpp\\Robot.cpp:20:9: warning: unused variable 'x' [-Wunused-variable]`,
    "",
  ].join("\r\n");
  assert.deepEqual(parseProblems(text).map((p) => [p.line, p.col, p.severity, p.message]), [
    [12, 5, "error", "'foo' was not declared in this scope"],
    [3, 10, "error", "frc/TimedRobot.hh: No such file or directory"],
    [20, 9, "warning", "unused variable 'x' [-Wunused-variable]"],
  ]);
});

test("a build.gradle that will not evaluate is a problem at the line Gradle names", () => {
  assert.deepEqual(parseProblems(GROOVY_DSL).map(fields), [
    {
      file: `${ROOT}\\build.gradle`,
      line: 3,
      col: null,
      severity: "error",
      message:
        "A problem occurred evaluating root project 'Robot2027'.\n" +
        "Could not find method foo() for arguments [] on root project 'Robot2027' of type org.gradle.api.Project.",
    },
  ]);
});

// --- what is not a problem ---------------------------------------------------------

test("Gradle's own verdicts are not problems, though they do say the build failed", () => {
  const text = "> Task :compileJava FAILED\r\n\r\nFAILURE: Build failed with an exception.\r\n\r\nBUILD FAILED in 3s\r\n";
  assert.deepEqual(parseProblems(text), []);
  assert.equal(buildFailed(text), true);
});

test("a colon and some digits do not make a problem", () => {
  const lines = [
    "BUILD SUCCESSFUL in 12s",
    "Deploying to 10.58.5.2:22",
    "12:34:56",
    "https://frcmaven.wpi.edu:443/x",
    // The harder ones, which have the words, the digits and the colons in the right order.
    "12:34:56: error: brownout detected",
    "Deploying to 10.58.5.2:22: error: connection refused",
    "roborio-5805-frc.local:22: error: connection refused",
    "Could not GET 'https://frcmaven.wpi.edu:443/artifactory/release/x.pom': error: 404",
    "error: warnings found and -Werror specified",
    "e: warnings found and -Werror specified",
    "warning: [options] source value 8 is obsolete and will be removed in a future release",
    "Note: Some input files use or override a deprecated API.",
    "2 errors",
    "1 actionable task: 1 executed",
    "    at frc.robot.Robot.robotInit(Robot.java:42)",
    "[Incubating] Problems report is available at: file:///C:/Users/student/dev/Robot%202027/build/reports/problems/problems-report.html",
  ];
  assert.deepEqual(parseProblems(lines.join("\r\n")), []);
});

// --- reading lines -----------------------------------------------------------------

test("each problem is listed once, in the order the build first printed it", () => {
  // A resized console repaints the screen, and the repaint arrives as output like anything else.
  const once = `${ROBOT}:9: error: cannot find symbol\n    m_drive.foo();\n           ^\r\n`;
  const elsewhere = `${ROBOT}:9: error: cannot find symbol\n    m_drive.foo(); m_drive.bar();\n                          ^\r\n`;
  assert.deepEqual(parseProblems(once + elsewhere + once + "2 errors\r\n").map((p) => p.col), [12, 27]);

  // The same file with the other slashes and another case is, on Windows, the same file.
  const shouted = `${ROBOT.replace(/\\/g, "/").toUpperCase()}:9: error: cannot find symbol\r\n`;
  assert.equal(parseProblems(`${ROBOT}:9: error: cannot find symbol\r\n` + shouted).length, 1);
});

test("all three line endings end a line", () => {
  const error = (line) => `${ROBOT}:${line}: error: expected ';'`;
  const text = `${error(1)}\r\n${error(2)}\r${error(3)}\n${error(4)}`;
  assert.deepEqual(parseProblems(text).map((p) => p.line), [1, 2, 3, 4]);
});

test("colour, erases and titles go; a jump becomes a line break and a step right becomes spaces", () => {
  assert.equal(stripAnsi("\u001b[31;1merror\u001b[0m: x"), "error: x");
  assert.equal(stripAnsi("\u001b[2Kline\u001b[K"), "line");
  assert.equal(stripAnsi("\u001b]0;cmd.exe\u0007a\u001b]2;title\u001b\\b"), "ab", "a title ends at BEL or at ESC \\");
  assert.equal(stripAnsi("a\u001b[5;1Hb\u001b[2Ac"), "a\nb\nc");
  assert.equal(stripAnsi("a\u001b[3Cb\u001b[Cc"), "a   b c");
  assert.equal(stripAnsi("\u001b[99999999C").length, 1000, "not a hundred million spaces");
  assert.equal(stripAnsi("a\u0007b\u0008c\td"), "abc\td", "a tab is text; a bell and a backspace are not");
  assert.equal(stripAnsi(undefined), "");
});

// --- the helpers the pane is drawn from -----------------------------------------------

test("errors sort before warnings, and anything else after both", () => {
  assert.ok(severityRank("error") < severityRank("warning"));
  assert.ok(severityRank("warning") < severityRank("note"));
  assert.ok(severityRank("warning") < severityRank(undefined));
});

test("the list is errors first, and otherwise in the order the build printed them", () => {
  // The first error is usually the cause of the rest, so no other ordering may bury it.
  const p = (id, severity) => ({ id, severity });
  const order = displayOrder([p(1, "warning"), p(2, "error"), p(3, "warning"), p(4, "error"), p(5, "error")]);
  assert.deepEqual(order.map((x) => x.id), [2, 4, 5, 1, 3]);
  assert.deepEqual(displayOrder(undefined), []);
});

test("the summary counts in words, and says one error rather than one errors", () => {
  const e = { severity: "error" };
  const w = { severity: "warning" };
  assert.equal(summarize([e, e, e, w]), "3 errors, 1 warning");
  assert.equal(summarize([e]), "1 error");
  assert.equal(summarize([w, w]), "2 warnings");
  assert.equal(summarize([]), "No problems");
  assert.equal(summarize(undefined), "No problems");
  assert.equal(summarize(parseProblems(GRADLE_9_PLAIN), { failed: true }), "2 errors, 1 warning");
});

test("a failed build with nothing to point at never reads as No problems", () => {
  assert.equal(summarize([], { failed: true }), "The build failed without naming a file — read the Build tab.");
  // Warnings seldom fail a build, so they do not get to stand in for the reason this one did.
  assert.equal(
    summarize([{ severity: "warning" }], { failed: true }),
    "1 warning, but the build failed without naming a file — read the Build tab.",
  );
});

test("a path reads as it does inside the project, whatever slashes and case it arrived with", () => {
  assert.equal(relativize(ROBOT, ROOT), "src\\main\\java\\frc\\robot\\Robot.java");
  assert.equal(relativize("C:/Users/student/dev/Robot 2027/build.gradle.kts", ROOT), "build.gradle.kts");
  assert.equal(relativize("c:\\users\\STUDENT\\dev\\robot 2027\\build.gradle", `${ROOT}\\`), "build.gradle");
});

test("a sibling folder that starts with the project's name is not inside the project", () => {
  // Robot 2027 beside Robot 2027-offseason is how a team keeps last season's code.
  const sibling = "C:\\Users\\student\\dev\\Robot 2027-offseason\\src\\Robot.java";
  assert.equal(relativize(sibling, ROOT), sibling);
  assert.equal(relativize("D:\\other\\Robot.java", ROOT), "D:\\other\\Robot.java");
  assert.equal(relativize(ROOT, ROOT), ROOT, "the root itself is not a file inside it");
  assert.equal(relativize(ROBOT, ""), ROBOT);
});

test("the build failed only when Gradle says so at the start of a line", () => {
  assert.equal(buildFailed("BUILD FAILED in 3s"), true);
  assert.equal(buildFailed("x\r\nFAILURE: Build failed with an exception.\r\n"), true);
  assert.equal(buildFailed("\u001b[31;1mBUILD FAILED\u001b[0;39m in 8s"), true, "coloured, as the rich console prints it");
  assert.equal(buildFailed(GRADLE_8_RICH), true);
  assert.equal(buildFailed("BUILD SUCCESSFUL in 12s"), false);
  assert.equal(buildFailed("[auto] FAILURE: path timed out"), false, "a robot program's log line is not the build");
});

test("copied problems read path:line: message, with details indented under their error", () => {
  assert.equal(
    copyText(displayOrder(parseProblems(GRADLE_9_PLAIN)), ROOT),
    [
      "src\\main\\java\\frc\\robot\\Robot.java:9: cannot find symbol",
      "  symbol:   method foo()",
      "  location: variable m_drive of type Drive",
      "src\\main\\java\\frc\\robot\\Robot.java:10: incompatible types: String cannot be converted to int",
      "src\\main\\java\\frc\\robot\\Robot.java:11: [removal] Integer(int) in Integer has been deprecated and marked for removal",
    ].join("\n"),
  );
  assert.equal(copyText([], ROOT), "");
});

// --- chunks ----------------------------------------------------------------------

// One javac error as the app's terminal can deliver it: coloured, with both of javac's line endings,
// and its first line cut by ConPTY at the edge of a narrow terminal.
const ONE_ERROR = [
  "\u001b[1m> Task :compileJava\u001b[m FAILED\r\n",
  conptyWrap(`${ROBOT}:9: error: cannot find symbol`, 48),
  "\n    m_drive.foo();\n",
  "           ^\n",
  "  symbol:   method foo()\n",
  "  location: variable m_drive of type Drive\r\n",
  "1 error\r\n",
].join("");

test("an error split across two chunks at any point is found exactly once", () => {
  const whole = parseProblems(ONE_ERROR);
  assert.equal(whole.length, 1);
  assert.equal(whole[0].col, 12);
  const collector = createCollector();
  for (let at = 0; at <= ONE_ERROR.length; at++) {
    collector.reset();
    collector.push(ONE_ERROR.slice(0, at));
    collector.push(ONE_ERROR.slice(at));
    assert.deepEqual(collector.problems(), whole, `split at ${at}: ${JSON.stringify(ONE_ERROR.slice(at - 4, at + 4))}`);
  }
});

test("a build fed one character at a time reads the same as the whole of it", () => {
  for (const text of [GRADLE_9_PLAIN, GRADLE_8_RICH, KOTLIN_DSL, GROOVY_DSL]) {
    const collector = createCollector();
    for (const ch of text) collector.push(ch);
    assert.deepEqual(collector.problems(), parseProblems(text));
    assert.equal(collector.failed(), true);
  }
});

test("a trailing \\r waits for the next chunk before it is called a line break", () => {
  // Called early, the \n that follows would be a second break and an empty line nobody printed.
  const collector = createCollector();
  collector.push("first\r");
  collector.push("\nsecond\r\n");
  collector.push("third\n");
  assert.equal(collector.text(), "first\nsecond", "and the newest line is still waiting to see what follows it");
});

test("kept text stays under the cap a whole line at a time, and earlier problems outlive it", () => {
  const collector = createCollector({ cap: 200 });
  collector.push(GRADLE_9_PLAIN);
  for (let i = 0; i < 50; i++) collector.push(`sim ${i}: the robot program is still printing\r\n`);
  const text = collector.text();
  assert.ok(text.length < 200, `kept ${text.length} characters`);
  assert.match(text, /^sim \d+: the robot program is still printing\n/, "it starts at the start of a line");
  assert.equal(collector.problems().length, 3);
  assert.equal(collector.failed(), true);
});

test("reset forgets the problems, the failure and the text", () => {
  const collector = createCollector();
  collector.push(GRADLE_9_PLAIN);
  collector.reset();
  collector.push("BUILD SUCCESSFUL in 2s\r\n\r\n");
  assert.deepEqual(collector.problems(), []);
  assert.equal(collector.failed(), false);
  assert.equal(collector.text(), "BUILD SUCCESSFUL in 2s");
});

test("a chunk that is not text is ignored rather than thrown over", () => {
  // The chunks come out of an event listener, and a throw in there silences the pane for good.
  const collector = createCollector();
  for (const bad of [undefined, null, 42, {}, ""]) collector.push(bad);
  assert.deepEqual(collector.problems(), []);
  assert.equal(collector.text(), "");
});
