import { test } from "node:test";
import assert from "node:assert/strict";

import { MARK, commentSafe, constantsBlock, findRegions, javaString, newFile, planConstants, planWrite, readJava } from "./codegen.js";
import { CONSTANT_NAMES, clone, sampleConfig, serializeConfig } from "./model.js";

// Built from char codes so this file never contains a backslash-u sequence of its own.
const BS = String.fromCharCode(92);
const E_ACUTE = String.fromCharCode(0xe9);

const count = (text, needle) => text.split(needle).length - 1;
const withDeadband = (c, v) => { const d = clone(c); d.profiles[0].axes[2].deadband = v; return d; };

test("a new file has the package, both regions exactly once, and the class around the body", () => {
  const text = newFile(sampleConfig());
  assert.ok(text.startsWith("package frc.robot;\n"));
  for (const m of [MARK.importsBegin, MARK.importsEnd, MARK.bodyBegin, MARK.bodyEnd]) assert.equal(count(text, m), 1, m);
  assert.match(text, /public final class DriverConfig \{\n {4}\/\/ >>> CATALYST DRIVER CONFIG: BODY/);
  assert.ok(text.trimEnd().endsWith("}"));
});

test("the generated file is pure ASCII, whatever the profile names contain", () => {
  const c = sampleConfig();
  c.profiles[1].name = `Ren${E_ACUTE}e */ ${BS}u000a`;
  const text = newFile(c);
  assert.ok(![...text].some((ch) => ch.charCodeAt(0) > 0x7e), "no non-ASCII character reaches the file");
  assert.ok(text.includes("e *" + BS + "/ " + BS + BS + "u000a"), "inside the profile block the */ is written *\\/ and the backslash doubled");
  const back = readJava(text);
  assert.equal(back.config.profiles[1].name, c.profiles[1].name, "the name survives the round trip exactly");
  assert.equal(back.handEdited, false);
});

test("it round-trips: the profile read back from the file is the one written", () => {
  const c = sampleConfig();
  const back = readJava(newFile(c));
  assert.equal(back.found, true);
  assert.equal(back.region, "BODY");
  assert.deepEqual(back.problems, []);
  assert.equal(back.generator, 1);
  assert.equal(back.handEdited, false);
  assert.equal(serializeConfig(back.config), serializeConfig(c));
});

test("generation is deterministic", () => {
  assert.equal(newFile(sampleConfig()), newFile(clone(sampleConfig())));
});

test("the Java targets the real API: DriverProfile, RumbleEvents, CommandGenericHID - and no SendableChooser", () => {
  const text = newFile(sampleConfig());
  assert.match(text, /DriverProfile\.builder\(\)\.deadband\(deadband\)\.curve\(curve\)\.maxSpeed\(cap\)\.slowMode\(slowMultiplier\)\.build\(\)/);
  assert.match(text, /p\.rumble\.onTrigger\(robot\.constraints\.tipRiskHigh\(\)\.and\(on\), RumbleEvents\.Pattern\.LONG, RumbleEvents\.Channel\.DRIVER\);/);
  assert.match(text, /p\.rumble\.onTrigger\(new Trigger\(robot\.ghost::isRecording\)\.and\(on\), RumbleEvents\.Pattern\.DOUBLE_TAP/);
  assert.match(text, /p\.controller\.button\(1\)\.and\(on\)\.whileTrue\(robot\.drive\.xBrake\(\)\);/);
  assert.match(text, /p\.controller\.button\(11\)\.and\(on\)\.toggleOnTrue\(robot\.alignToTag\(\)\);/, "D-pad up is raw button 11");
  assert.match(text, /return robot\.drive\.advancedDrive\(forward\(\), strafe\(\), turn\(\), 0\.0\)/);
  assert.match(text, /new Axis\("forward", 1, true, 0\.08, DriverProfile\.Curve\.LINEAR, 1\.0, 0\.35, 1\.0, 0\.0\)/);
  assert.doesNotMatch(text, /SendableChooser|SmartDashboard\.putData/);
  assert.doesNotMatch(text, /povUp\(\)/, "no POV on a pad whose D-pad is buttons");
});

test("reset is the alliance-aware reseed: 0 degrees on Blue, 180 on Red, never resetHeading()", () => {
  const text = newFile(sampleConfig());
  assert.match(text, /p\.controller\.button\(6\)\.and\(on\)\.onTrue\(Commands\.runOnce\(this::reseedHeading\)\.withName\("Driver Config: reseed heading"\)\);/);
  assert.match(text, /robot\.drive\.resetPose\(new Pose2d\(robot\.drive\.getPose\(\)\.getTranslation\(\),\n\s+AllianceFlipUtil\.shouldFlip\(\) \? Rotation2d\.fromDegrees\(180\) : new Rotation2d\(\)\)\);/);
  assert.doesNotMatch(text, /\.resetHeading\(\)/);
  const bad = sampleConfig();
  bad.profiles[0].bindings[1].action.expr = "robot.drive.resetHeading()";
  assert.throws(() => newFile(bad), /seeds 0 degrees on both alliances/);
});

test("re-applying rewrites only the regions: the team's own code outside them is byte-identical", () => {
  const c = sampleConfig();
  const original = newFile(c);
  const head = "// Team 5805 was here.\n";
  const helper = "\n    /** Ours, not generated. */\n    public int answer() {\n        return 42;\n    }\n";
  const endBody = "    " + MARK.bodyEnd + "\n";
  const theirs = head + original.replace(endBody, endBody + helper);
  const plan = planWrite(theirs, withDeadband(c, 0.06));
  assert.equal(plan.ok, true);
  assert.equal(plan.mode, "update");
  assert.ok(plan.text.startsWith(head + "package frc.robot;\n"));
  assert.ok(plan.text.includes(endBody + helper), "the helper after the body region is untouched");
  assert.equal(readJava(plan.text).config.profiles[0].axes[2].deadband, 0.06);
  const r = findRegions(plan.text);
  const t = findRegions(theirs);
  assert.equal(plan.text.slice(0, r.lines[r.imports.start].start), theirs.slice(0, t.lines[t.imports.start].start));
});

test("a CRLF file stays CRLF", () => {
  const c = sampleConfig();
  const crlf = newFile(c).replace(/\n/g, "\r\n");
  const plan = planWrite(crlf, withDeadband(c, 0.07));
  assert.equal(plan.ok, true);
  assert.equal(/[^\r]\n/.test(plan.text), false, "no bare LF was introduced");
  assert.equal(readJava(plan.text).config.profiles[0].axes[2].deadband, 0.07);
});

test("applying an unchanged profile changes nothing at all", () => {
  const text = newFile(sampleConfig());
  assert.equal(planWrite(text, sampleConfig()).text, text);
});

test("a hand edit inside a region is noticed before it is overwritten", () => {
  const text = newFile(sampleConfig()).replace("new Axis(\"turn\", 2, true, 0.08", "new Axis(\"turn\", 2, true, 0.12");
  const back = readJava(text);
  assert.equal(back.handEdited, true);
  assert.equal(back.config.profiles[0].axes[2].deadband, 0.08, "the profile block still says what the app wrote");
});

test("an older generator's code is not mistaken for a hand edit", () => {
  const text = newFile(sampleConfig())
    .replace("Generator: CatalystApp Driver Config 1.", "Generator: CatalystApp Driver Config 0.")
    .replace("private boolean slowHeld;", "private boolean slowHeld; // older shape");
  const back = readJava(text);
  assert.equal(back.generator, 0);
  assert.equal(back.handEdited, false);
});

test("a file with the same name but no regions is somebody else's, and is refused", () => {
  const plan = planWrite("package frc.robot;\n\npublic class DriverConfig {}\n", sampleConfig());
  assert.equal(plan.ok, false);
  assert.match(plan.problems[0], /not one this app wrote/);
});

test("broken markers are refused rather than guessed at", () => {
  const text = newFile(sampleConfig());
  const doubled = text.replace(MARK.bodyEnd, MARK.bodyEnd + "\n    " + MARK.bodyEnd);
  assert.equal(planWrite(doubled, sampleConfig()).ok, false);
  const noImports = text.replace(MARK.importsBegin + "\n", "").replace(MARK.importsEnd + "\n", "");
  const plan = planWrite(noImports, sampleConfig());
  assert.equal(plan.ok, false);
  assert.match(plan.problems[0], /no imports region/);
});

test("no file yet: the plan is to create one", () => {
  const plan = planWrite(null, sampleConfig());
  assert.equal(plan.mode, "create");
  assert.equal(plan.text, newFile(sampleConfig()));
});

test("an expression the tool would not write stops generation instead of reaching the file", () => {
  const c = sampleConfig();
  c.profiles[0].bindings[0].action.expr = "robot.coPilot(); Runtime.getRuntime().exit(0)";
  assert.throws(() => newFile(c), /refusing to generate/);
});

// --- the constants block (X1Constants.Driving) -------------------------------------------------

const CONSTANTS_FILE = [
  "package frc.robot;",
  "",
  "import frc.lib.catalyst.util.DriverProfile;",
  "",
  "public final class X1Constants {",
  "    public static final double STICK_DEADBAND = 0.08;",
  "",
  "    /** Driver feel. */",
  "    public static final class Driving {",
  "        private Driving() {}",
  "        public static final double DEADBAND = STICK_DEADBAND;",
  "        public static final double MAX_SPEED = 1.0;",
  "        public static final DriverProfile.Curve DEFAULT_CURVE = DriverProfile.Curve.LINEAR;",
  "    }",
  "    public static final double SLOW_MODE_FACTOR = 0.35;",
  "}",
  "",
].join("\n");

const marked = () => {
  const lines = CONSTANTS_FILE.split("\n");
  lines.splice(14, 0, "    " + MARK.constantsEnd);
  lines.splice(7, 0, "    " + MARK.constantsBegin);
  return lines.join("\n");
};

test("without its two marker lines the constants block is refused, with the lines to paste", () => {
  const plan = planConstants(CONSTANTS_FILE, sampleConfig());
  assert.equal(plan.ok, false);
  assert.equal(plan.needsMarkers, true);
  assert.deepEqual(plan.markers, [MARK.constantsBegin, MARK.constantsEnd]);
  assert.match(plan.problems[0], /Put the two marker lines around the Driving class once/);
});

test("with the markers, the Driving block is replaced and nothing outside it moves", () => {
  const theirs = marked();
  const plan = planConstants(theirs, sampleConfig());
  assert.equal(plan.ok, true);
  const head = theirs.slice(0, theirs.indexOf(MARK.constantsBegin));
  const tail = theirs.slice(theirs.indexOf(MARK.constantsEnd) + MARK.constantsEnd.length);
  assert.ok(plan.text.startsWith(head) && plan.text.endsWith(tail));
  assert.match(plan.text, /public static final double DEADBAND = 0\.08;/);
  assert.match(plan.text, /public static final double MAX_SPEED = 1\.0;/);
  assert.match(plan.text, /public static final frc\.lib\.catalyst\.util\.DriverProfile\.Curve DEFAULT_CURVE = frc\.lib\.catalyst\.util\.DriverProfile\.Curve\.LINEAR;/);
  assert.match(plan.text, /public static final int FORWARD_AXIS = 1;/);
  for (const name of CONSTANT_NAMES) assert.match(plan.text, new RegExp(`public static final [\\w.]+ ${name} = `), name);
  assert.ok(plan.text.includes("public static final double SLOW_MODE_FACTOR = 0.35;"), "the constant beside the block is the team's, and stays");
});

test("the constants block reads back, notices a hand edit, and re-applies to the same bytes", () => {
  const text = planConstants(marked(), sampleConfig()).text;
  const back = readJava(text);
  assert.equal(back.region, "CONSTANTS");
  assert.equal(back.handEdited, false);
  assert.equal(serializeConfig(back.config), serializeConfig(sampleConfig()));
  assert.equal(planConstants(text, sampleConfig()).text, text);
  const edited = text.replace("public static final double DEADBAND = 0.08;", "public static final double DEADBAND = 0.1;");
  assert.notEqual(edited, text, "the edit lands inside the region");
  assert.equal(readJava(edited).handEdited, true);
  assert.deepEqual(constantsBlock(sampleConfig(), "  ")[0], "  " + MARK.constantsBegin);
});

// --- escaping ---------------------------------------------------------------------------------

test("Java string literals escape quotes, backslashes and non-ASCII safely", () => {
  assert.equal(javaString("a\"b"), "\"a" + BS + "\"b\"");
  assert.equal(javaString(BS), "\"" + BS + BS + "\"");
  assert.equal(javaString(E_ACUTE), "\"" + BS + "u00e9\"");
  assert.equal(javaString("tab\there"), "\"tab" + BS + "there\"");
  assert.equal(javaString(String.fromCharCode(7)), "\"" + BS + "007\"");
});

test("comment text cannot smuggle a line break or close a block comment", () => {
  const hostile = "a" + BS + "u000a" + "b */ c\nd";
  const safe = commentSafe(hostile);
  assert.equal(safe.includes("\n"), false);
  assert.equal(safe.includes("*/"), false);
  assert.ok(safe.includes(BS + BS + "u000a"), "the backslash is doubled, so javac never sees an escape");
});
