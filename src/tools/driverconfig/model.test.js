import { test } from "node:test";
import assert from "node:assert/strict";

import { BUTTON_BASE } from "./catalog.js";
import {
  addProfile, applyCurve, applyDeadband, blankConfig, buttonName, capsFor, changes, deleteProfile,
  duplicateProfile, isMeasured, layoutOf, normalize, parseConfig, renameProfile, sampleConfig,
  serializeConfig, setDefaultProfile, shape, slewStep, validate,
} from "./model.js";

const errors = (c, project) => validate(c, project).filter((f) => f.level === "error").map((f) => f.message);
const warnings = (c, project) => validate(c, project).filter((f) => f.level === "warn").map((f) => f.message);
const edit = (fn) => { const c = sampleConfig(); fn(c, c.profiles[0]); return c; };
const binding = (p, id) => p.bindings.find((b) => b.action.id === id || b.action.expr === id);

// --- the format ------------------------------------------------------------------------------

test("the X1 sample is a valid profile: nothing blocks Apply", () => {
  assert.deepEqual(errors(sampleConfig()), []);
});

test("the sample says out loud that DualSense rumble has not been measured", () => {
  const w = warnings(sampleConfig());
  assert.ok(w.some((m) => /^X1: rumble .* not been measured on a DualSense/.test(m)), w.join("\n"));
});

test("the sample drives the way the X1 measured: forward is axis 1, sideways 0, turn 2, all inverted", () => {
  const [fwd, side, turn] = sampleConfig().profiles[0].axes;
  assert.deepEqual([fwd.role, fwd.axis, fwd.invert], ["forward", 1, true], "stick up reads -1, so forward is -raw");
  assert.deepEqual([side.role, side.axis, side.invert], ["strafe", 0, true], "right is +, and + sideways is left");
  assert.deepEqual([turn.role, turn.axis, turn.invert], ["turn", 2, true]);
});

test("the sample binds by raw button index on the measured DualSense map, and never by POV", () => {
  const p = sampleConfig().profiles[0];
  assert.equal(binding(p, "slow").input.index, 9, "L1");
  assert.equal(binding(p, "reseed").input.index, 6, "Options");
  assert.equal(binding(p, "robot.alignToTag()").input.index, 11, "D-pad up is a button on this pad");
  assert.ok(!p.bindings.some((b) => b.input.kind === "pov"));
  assert.ok(!p.bindings.some((b) => /resetHeading/.test(b.action.expr || "")), "reset is the alliance-aware reseed");
});

test("a profile survives serialise -> parse unchanged", () => {
  const c = sampleConfig();
  const back = parseConfig(serializeConfig(c));
  assert.deepEqual(back, c);
  assert.equal(serializeConfig(back), serializeConfig(c));
});

test("serialising is stable: key order does not depend on how the object was built", () => {
  const c = sampleConfig();
  const shuffled = JSON.parse(JSON.stringify(c), (k, v) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v);
  assert.equal(serializeConfig(shuffled), serializeConfig(c));
});

test("parse refuses what is not a Driver Config profile, and says why", () => {
  assert.throws(() => parseConfig("{ nope"), /not valid JSON/);
  assert.throws(() => parseConfig(JSON.stringify({ format: "something-else", version: 1 })), /not a Driver Config profile/);
  assert.throws(() => parseConfig(JSON.stringify({ format: "catalyst-driver-config", version: 99, profiles: [] })), /newer Driver Config/);
});

test("normalise fills gaps with defaults but keeps a wrong value for validation to name", () => {
  const c = normalize({ profiles: [{ name: "Sam", axes: [{ role: "forward", deadband: "lots" }] }] });
  assert.equal(c.defaultProfile, "Sam");
  assert.equal(c.profiles[0].controller.type, "gamepad", "the 2027 Driver Station's layout is the default");
  assert.equal(c.target.classFile, true);
  assert.equal(c.target.constants, null);
  assert.ok(Number.isNaN(c.profiles[0].axes[0].deadband), "an unreadable deadband is not silently replaced");
  assert.ok(errors(c).some((m) => /Sam: Forward \/ back has a deadband of 0/.test(m)));
});

test("a blank config names its generated class and has one usable profile", () => {
  const c = blankConfig({ package: "frc.robot", robotClass: "RobotContainer" });
  assert.equal(c.target.className, "DriverConfig");
  assert.equal(c.profiles.length, 1);
  assert.deepEqual(errors(c), []);
});

// --- the checks the brief asked for ----------------------------------------------------------

test("two actions on one button is an error that names both", () => {
  const c = edit((_, p) => p.bindings.push({ input: { kind: "button", index: 1 }, when: "onTrue",
    action: { kind: "command", expr: "robot.coPilot()", label: "Co pilot" } }));
  const e = errors(c);
  assert.ok(e.some((m) => /Button 1 · Circle has two actions, "X-brake \(lock the wheels\)" and "Co pilot"/.test(m)), e.join("\n"));
});

test("an axis mapped twice is an error, and the message says when the inverts disagree", () => {
  const c = edit((_, p) => { p.axes[1].axis = 1; p.axes[1].invert = false; });
  const e = errors(c);
  assert.ok(e.some((m) => /axis 1 is mapped twice, to Forward \/ back and to Sideways, inverted for one and not the other/.test(m)), e.join("\n"));
});

test("a deadband of 0 is an error", () => {
  assert.ok(errors(edit((_, p) => { p.axes[2].deadband = 0; })).some((m) => /Turn has a deadband of 0/.test(m)));
});

test("a deadband above 0.5 is an error, and 0.5 itself is not", () => {
  assert.ok(errors(edit((_, p) => { p.axes[0].deadband = 0.51; })).some((m) => /deadband of 0.51/.test(m)));
  assert.equal(errors(edit((_, p) => { p.axes[0].deadband = 0.5; })).filter((m) => /deadband/.test(m)).length, 0);
});

test("rumble on a controller that cannot rumble is an error", () => {
  for (const type of ["joystick", "buttonbox"]) {
    const c = edit((_, p) => { p.controller.type = type; p.bindings = []; });
    assert.ok(errors(c).some((m) => /has no rumble motors/.test(m)), `${type}: ${errors(c).join("\n")}`);
  }
});

test("rumble on an Xbox pad is fine; on a DualSense it is a warning, not an error", () => {
  const xbox = edit((_, p) => { p.controller.type = "xbox"; p.bindings = []; });
  assert.ok(!validate(xbox).some((f) => /rumble/.test(f.message) && f.where.profile === "X1"));
  assert.ok(!errors(sampleConfig()).some((m) => /rumble/.test(m)));
});

test("rumbling an operator who is not set up is an error", () => {
  const c = edit((_, p) => { p.rumble[0].channel = "BOTH"; });
  assert.ok(errors(c).some((m) => /rumbles the operator, and no operator controller is set up/.test(m)));
  c.operator = { type: "xbox", port: 1 };
  assert.ok(!errors(c).some((m) => /operator/.test(m)));
});

test("an axis the controller does not report is an error - the DualSense has four", () => {
  const e = errors(edit((_, p) => { p.axes[2].axis = 4; }));
  assert.ok(e.some((m) => /Turn reads axis 4, but a DualSense \(PS5\) reports 4 axes \(0 to 3\)/.test(m)), e.join("\n"));
});

test("a button past the end of the layout is an error", () => {
  const e = errors(edit((_, p) => { p.bindings[0].input.index = 21; }));
  assert.ok(e.some((m) => /buttons 0 to 20; there is no button 21/.test(m)), e.join("\n"));
});

test("a POV binding on a pad whose D-pad is buttons can never fire, so it is an error that says which buttons", () => {
  const e = errors(edit((_, p) => p.bindings.push({ input: { kind: "pov", dir: "UP" }, when: "onTrue",
    action: { kind: "command", expr: "robot.coPilot()", label: "Co pilot" } })));
  assert.ok(e.some((m) => /reports no POV hat; its D-pad is buttons 11 to 14/.test(m)), e.join("\n"));
});

test("slow mode on 'when pressed' would stick on, so it is refused", () => {
  const e = errors(edit((_, p) => { binding(p, "slow").when = "onTrue"; }));
  assert.ok(e.some((m) => /Slow mode on .* must be "while held" or "toggle on press"/.test(m)), e.join("\n"));
});

test("the reseed is a press, and it needs the drivetrain", () => {
  assert.ok(errors(edit((_, p) => { binding(p, "reseed").when = "whileTrue"; })).some((m) => /must be "when pressed"/.test(m)));
  assert.ok(errors(edit((c) => { c.target.swerveField = null; })).some((m) => /needs the robot's SwerveSubsystem/.test(m)));
});

test("resetHeading() is refused, because on Red it makes the robot's back its forward", () => {
  const e = errors(edit((_, p) => { binding(p, "robot.drive.xBrake()").action.expr = "robot.drive.resetHeading()"; }));
  assert.ok(e.some((m) => /resetHeading\(\) seeds 0 degrees on both alliances/.test(m)), e.join("\n"));
});

test("an expression the generator would not write is refused", () => {
  const e = errors(edit((_, p) => { p.bindings[0].action.expr = "robot.coPilot(); System.exit(0)"; }));
  assert.ok(e.some((m) => /is not an action Driver Config can generate/.test(m)));
});

test("robot actions need a robot class to run on", () => {
  const e = errors(edit((c) => { c.target.robotClass = null; }));
  assert.ok(e.some((m) => /no robot class is chosen/.test(m)));
});

test("profile names must differ and one must be the default", () => {
  assert.ok(errors(edit((c) => { c.profiles[1].name = "x1"; })).some((m) => /Two profiles are called/.test(m)));
  assert.ok(errors(edit((c) => { c.defaultProfile = "Nobody"; })).some((m) => /No profile is the default/.test(m)));
});

test("names with spaces are fine; control characters are not", () => {
  assert.ok(!errors(edit((c) => { c.profiles[1].name = "First timer"; })).some((m) => /control character/.test(m)));
  const bell = String.fromCharCode(7);
  assert.ok(errors(edit((c) => { c.profiles[1].name = `Ro${bell}okie`; })).some((m) => /control character/.test(m)));
});

test("turbo that asks for more than 100% is a warning, turbo below 1 an error", () => {
  assert.ok(warnings(edit((c) => { c.profiles[1].speed.turbo = 2; })).some((m) => /turbo asks for 120%/.test(m)));
  assert.ok(errors(edit((c) => { c.profiles[1].speed.turbo = 0.9; })).some((m) => /turbo would be slower than normal/.test(m)));
});

test("nothing to write is an error", () => {
  assert.ok(errors(edit((c) => { c.target.classFile = false; c.target.constants = null; })).some((m) => /Nothing is set to be written/.test(m)));
});

// --- checks against a scanned project ----------------------------------------------------------

test("a button the project's own code binds is a warning", () => {
  const project = { existingBindings: [{ port: 0, key: "b9", file: "X1.java", line: 433, text: "driver.button(9)" }] };
  const w = warnings(sampleConfig(), project);
  assert.ok(w.some((m) => /X1: X1.java binds Button 9 · L1 too \(line 433: driver.button\(9\)\)/.test(m)), w.join("\n"));
});

test("an action the project no longer has is a warning, not a silent pass", () => {
  const w = warnings(sampleConfig(), { actionExprs: new Set(["robot.drive.xBrake()"]) });
  assert.ok(w.some((m) => /robot.coPilot\(\), which was not found in X1/.test(m)), w.join("\n"));
});

test("NI-DS Xbox button names on a DualSense are called out: leftBumper() is Create, povUp() never fires", () => {
  const project = {
    controllers: [{ file: "X1.java", name: "driver", cls: "CommandNiDsXboxController", layout: "xbox", port: 0 }],
    existingBindings: [
      { controller: "driver", method: "leftBumper", input: { kind: "button", index: 4 }, port: 0, key: "b4", file: "X1.java", line: 624, text: "driver.leftBumper()" },
      { controller: "driver", method: "povUp", input: { kind: "pov", dir: "UP" }, port: 0, key: "pov:UP", file: "X1.java", line: 649, text: "driver.povUp()" },
    ],
  };
  const w = warnings(sampleConfig(), project);
  const m = w.find((x) => /reads port 0 through CommandNiDsXboxController/.test(x));
  assert.ok(m, w.join("\n"));
  assert.match(m, /leftBumper\(\) is Button 4 · Create/);
  assert.match(m, /povUp\(\) never fires, because this pad has no POV hat/);
});

test("a second RumbleEvents on the same controller is a warning", () => {
  const w = warnings(sampleConfig(), { rumbleEvents: [{ file: "X1.java", line: 159 }] });
  assert.ok(w.some((m) => /X1.java already makes its own RumbleEvents \(line 159\)/.test(m)), w.join("\n"));
});

test("the constants block must define every name the project reads from it", () => {
  const block = { path: "src/main/java/frc/robot/X1Constants.java", className: "Driving", refs: ["DEADBAND", "DEFAULT_CURVE", "MAX_SPEED"] };
  assert.deepEqual(errors(sampleConfig(), { constantsBlocks: [block] }), []);
  const e = errors(sampleConfig(), { constantsBlocks: [{ ...block, refs: [...block.refs, "MAX_ACCEL"] }] });
  assert.ok(e.some((m) => /reads Driving.MAX_ACCEL, which the generated block does not define/.test(m)), e.join("\n"));
});

// --- the stick math: must equal the generated Java -------------------------------------------

test("deadband is WPILib's MathUtil.applyDeadband: rescaled so full stick is still full", () => {
  assert.equal(applyDeadband(0.05, 0.1), 0);
  assert.equal(applyDeadband(0.1, 0.1), 0);
  assert.equal(applyDeadband(1, 0.1), 1);
  assert.equal(applyDeadband(-1, 0.1), -1);
  assert.ok(Math.abs(applyDeadband(0.55, 0.1) - 0.5) < 1e-12);
});

test("curves are DriverProfile's: squared, cubic, and expo with a = 3", () => {
  assert.equal(applyCurve(0.5, "linear"), 0.5);
  assert.equal(applyCurve(-0.5, "squared"), -0.25);
  assert.equal(applyCurve(0.5, "cubic"), 0.125);
  assert.equal(applyCurve(0, "expo"), 0);
  assert.ok(Math.abs(applyCurve(1, "expo") - 1) < 1e-12);
  assert.ok(Math.abs(applyCurve(0.5, "expo") - (Math.exp(1.5) - 1) / (Math.exp(3) - 1)) < 1e-12);
});

test("slow multiplies the cap, turbo raises it, and turbo never passes 100%", () => {
  const axis = { role: "forward", invert: true, deadband: 0.1, curve: "linear", scale: 1, slew: 0 };
  const speed = { max: 0.8, slow: 0.25, turbo: 2 };
  assert.ok(Math.abs(shape(-1, axis, speed, "normal").value - 0.8) < 1e-12, "inverted: stick up is forward");
  assert.ok(Math.abs(shape(-1, axis, speed, "slow").value - 0.2) < 1e-12);
  assert.equal(shape(-1, axis, speed, "turbo").value, 1);
  assert.equal(capsFor(axis, speed).turbo, 1);
});

test("an extra axis ignores the speed modes", () => {
  const axis = { role: "elevator", invert: false, deadband: 0.1, curve: "linear", scale: 0.5, slew: 0 };
  const speed = { max: 0.8, slow: 0.25, turbo: 2 };
  assert.equal(shape(1, axis, speed, "slow").value, 0.5);
  assert.equal(shape(1, axis, speed, "turbo").value, 0.5);
});

test("slew moves at most dt / slewSeconds per step, and 0 turns it off", () => {
  assert.equal(slewStep(0, 1, 0.5, 0.02), 0.04);
  assert.equal(slewStep(0.5, 0, 0.5, 0.02), 0.46);
  assert.equal(slewStep(0, 1, 0, 0.02), 1);
});

// --- layouts --------------------------------------------------------------------------------

test("buttons are numbered from 0, as getRawButton counts them in WPILib 2027", () => {
  assert.equal(BUTTON_BASE, 0);
});

test("the DualSense layout is the measured one: Create 4, Options 6, L1 9, D-pad up 11, touchpad 20", () => {
  const lay = layoutOf(sampleConfig(), "dualsense");
  const at = (i) => buttonName(lay, i);
  assert.deepEqual([at(4), at(6), at(9), at(11), at(20)], ["Create", "Options", "L1", "D-pad up", "Touchpad"]);
  for (const i of [4, 6, 9, 11, 20]) assert.ok(isMeasured(lay, "button", i), `button ${i} was measured`);
  assert.ok(!isMeasured(lay, "button", 1), "Circle follows the layout; nobody pressed it yet");
  assert.deepEqual(lay.axes, ["leftX", "leftY", "rightX", "rightY"]);
  assert.ok(isMeasured(lay, "axis", 0) && isMeasured(lay, "axis", 1) && isMeasured(lay, "axis", 2));
  assert.ok(!isMeasured(lay, "axis", 3));
  assert.equal(lay.pov, false, "the D-pad is buttons, not a hat");
});

// --- profile operations ---------------------------------------------------------------------

test("duplicate, rename, default and delete keep the default pointing at a real profile", () => {
  let c = sampleConfig();
  const dup = duplicateProfile(c, "X1");
  assert.equal(dup.name, "X1 copy");
  c = renameProfile(dup.config, "X1", "Thomas");
  assert.equal(c.defaultProfile, "Thomas");
  assert.throws(() => renameProfile(c, "Rookie", "thomas"), /already a profile called/);
  c = setDefaultProfile(c, "Rookie");
  c = deleteProfile(c, "Rookie");
  assert.equal(c.defaultProfile, "Thomas");
  c = deleteProfile(c, "X1 copy");
  assert.equal(c.profiles.length, 1);
  assert.throws(() => deleteProfile(c, "Thomas"), /last profile cannot be deleted/);
  assert.equal(addProfile(c, { ...c.profiles[0] }).name, "Thomas 2");
});

// --- what changed ----------------------------------------------------------------------------

test("changes() reads an edit as Rev 1 -> Rev 2, and an addition as an addition", () => {
  const before = sampleConfig();
  const after = edit((_, p) => {
    p.axes[2].deadband = 0.06;
    p.bindings.push({ input: { kind: "button", index: 12 }, when: "onTrue", action: { kind: "command", expr: "robot.coPilot()", label: "Co pilot" } });
  });
  const ch = changes(before, after);
  const dead = ch.find((x) => x.label === "X1 · Turn · deadband");
  assert.deepEqual([dead.from, dead.to], ["0.08", "0.06"]);
  const added = ch.find((x) => x.label === "X1 · Button 12 · D-pad down");
  assert.equal(added.from, null);
  assert.equal(added.to, "when pressed: Co pilot");
  assert.equal(changes(before, sampleConfig()).length, 0);
});
