import { test } from "node:test";
import assert from "node:assert/strict";

import { bindingsFromCode, codeCollisions, parseJavaFile, scanProject, stripJava } from "./project.js";

// A small robot shaped like the Catalyst X1: a robot class a static field news up, a swerve
// subsystem, an NI-DS Xbox controller on a constant port, a button index stored as a fallback, its
// own RumbleEvents, and a Driving constants block the robot reads.
const BOT = `package frc.robot;

import frc.lib.catalyst.command.CatalystCommand;
import frc.lib.catalyst.subsystems.swerve.SwerveSubsystem;
import frc.lib.catalyst.util.GhostReplay;
import frc.lib.catalyst.util.RumbleEvents;
import org.wpilib.command3.Trigger;
import org.wpilib.command3.button.CommandNiDsXboxController;

/** The robot. A brace in a comment: { */
public final class Bot {
    public final SwerveSubsystem drive = Drivetrain.create();
    public final CommandNiDsXboxController driver = new CommandNiDsXboxController(Constants.DRIVER_PORT);
    public final GhostReplay ghost = new GhostReplay(null);
    final Intake intake = new Intake();
    private final RumbleEvents rumble = new RumbleEvents(driver.getHID(), null);
    private final String banner = "not a brace { or a ; here";
    private final double feel = Constants.Driving.DEADBAND;
    private boolean slow;

    static final class Buttons {
        static int l2 = Constants.storedInt("BTN_L2", 7);
    }

    CatalystCommand scoreHigh() {
        return null;
    }

    private CatalystCommand secret() {
        return null;
    }

    CatalystCommand aimAt(double x) {
        return null;
    }

    boolean isAligned() {
        return true;
    }

    Trigger ready() {
        return new Trigger(() -> { return slow; });
    }

    void bindDriver() {
        driver.start().onTrue(drive.resetHeading());
        driver.button(Buttons.l2).whileTrue(scoreHigh());
        driver.leftBumper().whileTrue(Commands.startEnd(() -> slow = true, () -> slow = false));
        driver.b().onTrue(Commands.runOnce(() -> rumble.fire(RumbleEvents.Pattern.SHORT, RumbleEvents.Channel.DRIVER)));
        driver.b().whileTrue(drive.xBrake());
        // driver.a().onTrue(commentedOut());
    }
}
`;

const INTAKE = `package frc.robot;
public class Intake extends RollerMechanism {
    public CatalystCommand spit() { return null; }
}
`;

const CONSTANTS = `package frc.robot;
public final class Constants {
    public static final int DRIVER_PORT = 0;
    public static final double STICK_DEADBAND = 0.08;
    static int storedInt(String name, int fallback) { return fallback; }

    /** Driver feel. */
    public static final class Driving {
        private Driving() {}
        public static final double DEADBAND = STICK_DEADBAND;
        public static final double MAX_SPEED = 1.0;
        public static final DriverProfile.Curve DEFAULT_CURVE = DriverProfile.Curve.LINEAR;
    }
}
`;

const ROBOT = `package frc.robot;
public class Robot extends OpModeRobot {
    static final Bot ROBOT = new Bot();
}
`;

const sources = [
  { path: "src/main/java/frc/robot/Bot.java", text: BOT },
  { path: "src/main/java/frc/robot/Intake.java", text: INTAKE },
  { path: "src/main/java/frc/robot/Constants.java", text: CONSTANTS },
  { path: "src/main/java/frc/robot/Robot.java", text: ROBOT },
];
const lineOf = (text, needle) => text.split("\n").findIndex((l) => l.includes(needle)) + 1;

test("stripping keeps every offset and line, and blanks strings and comments", () => {
  const s = stripJava(BOT);
  assert.equal(s.length, BOT.length);
  assert.equal(s.split("\n").length, BOT.split("\n").length);
  assert.ok(!s.includes("not a brace"));
  assert.ok(!s.includes("commentedOut"));
});

test("a brace inside a string or a comment does not derail the class", () => {
  const f = parseJavaFile("Bot.java", BOT);
  const bot = f.types.find((t) => t.name === "Bot");
  assert.ok(bot.methods.some((m) => m.name === "bindDriver"));
  assert.ok(bot.fields.some((x) => x.name === "banner"));
});

test("the robot class is found, and its drivetrain", () => {
  const scan = scanProject(sources);
  assert.equal(scan.robot.name, "Bot");
  assert.equal(scan.swerveField, "drive");
});

test("actions: the robot's zero-argument commands, its fields' commands, inherited library ones", () => {
  const exprs = scanProject(sources).actions.map((a) => a.expr);
  for (const want of ["robot.scoreHigh()", "robot.drive.xBrake()", "robot.drive.headingLockDrive(forward(), strafe(), turn(), 0.0)",
    "robot.intake.spit()", "robot.intake.intake()", "robot.intake.eject()", "robot.ghost.stopRecording()"]) {
    assert.ok(exprs.includes(want), `missing ${want}`);
  }
  assert.ok(!exprs.includes("robot.secret()"), "private methods are not reachable from the generated class");
  assert.ok(!exprs.some((e) => e.startsWith("robot.aimAt")), "commands that take arguments are not offered");
  assert.ok(!exprs.includes("robot.drive.resetHeading()"), "resetHeading() is not offered: it is wrong on Red");
});

test("events: Trigger methods, boolean methods, library triggers and library booleans", () => {
  const exprs = scanProject(sources).events.map((e) => e.expr);
  assert.ok(exprs.includes("robot.ready()"));
  assert.ok(exprs.includes("new Trigger(robot::isAligned)"));
  assert.ok(exprs.includes("robot.intake.hasPieceTrigger()"));
  assert.ok(exprs.includes("new Trigger(robot.ghost::isRecording)"));
});

test("the project's own bindings are read at the raw indices WPILib 2027 resolves them to", () => {
  const scan = scanProject(sources);
  assert.deepEqual(scan.controllers.map((c) => [c.name, c.layout, c.port]), [["driver", "xbox", 0]]);
  const byText = Object.fromEntries(scan.existingBindings.map((b) => [b.text, b]));
  assert.equal(byText["driver.start()"].key, "b7", "NI-DS Xbox start() is button 7");
  assert.equal(byText["driver.button(Buttons.l2)"].key, "b7", "storedInt's fallback is read");
  assert.equal(byText["driver.button(Buttons.l2)"].input.how, "fallback");
  assert.equal(byText["driver.leftBumper()"].key, "b4");
  assert.ok(!scan.existingBindings.some((b) => b.text.startsWith("driver.a()")), "a commented-out binding is not a binding");
});

test("collisions: two commands on one button count; rumble feedback beside a command does not", () => {
  const groups = codeCollisions(scanProject(sources));
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].map((b) => b.text), ["driver.start()", "driver.button(Buttons.l2)"]);
});

test("the project's own RumbleEvents is found, so the page can warn about two on one controller", () => {
  assert.deepEqual(scanProject(sources).rumbleEvents, [{ file: "Bot.java", line: lineOf(BOT, "new RumbleEvents(") }]);
});

test("a Driving constants block is found, with the names the project reads from it", () => {
  const [block, ...rest] = scanProject(sources).constantsBlocks;
  assert.equal(rest.length, 0, "the outer Constants class is not mistaken for the block");
  assert.equal(block.path, "src/main/java/frc/robot/Constants.java");
  assert.equal(block.className, "Driving");
  assert.deepEqual(block.names, ["DEADBAND", "MAX_SPEED", "DEFAULT_CURVE"]);
  assert.deepEqual(block.refs, ["DEADBAND"]);
  assert.equal(block.marked, false);
});

test("importing from code takes single calls, slow mode and the reseed, and leaves the rest where it is", () => {
  const { imported, kept } = bindingsFromCode(scanProject(sources));
  const byKey = Object.fromEntries(imported.map((b) => [JSON.stringify(b.input), b.action]));
  assert.deepEqual(byKey[JSON.stringify({ kind: "button", index: 7 })], { kind: "builtin", id: "reseed" },
    "drive.resetHeading() comes in as the alliance-aware reseed");
  assert.deepEqual(byKey[JSON.stringify({ kind: "button", index: 4 })], { kind: "builtin", id: "slow" });
  assert.ok(kept.some((b) => b.text === "driver.button(Buttons.l2)"), "the second action on button 7 is not imported over the first");
});

test("the generated file is recognised, and so is code that already uses it", () => {
  const generated = { path: "src/main/java/frc/robot/DriverConfig.java",
    text: "package frc.robot;\npublic final class DriverConfig {\n    // >>> CATALYST DRIVER CONFIG: BODY (x)\n    // <<< CATALYST DRIVER CONFIG: BODY\n}\n" };
  const user = { path: "src/main/java/frc/robot/Wired.java", text: "package frc.robot;\nclass Wired { DriverConfig c = new DriverConfig(null); }\n" };
  const scan = scanProject([...sources, generated, user]);
  assert.deepEqual(scan.generated, ["src/main/java/frc/robot/DriverConfig.java"]);
  assert.deepEqual(scan.wiredIn, ["src/main/java/frc/robot/Wired.java"]);
});
