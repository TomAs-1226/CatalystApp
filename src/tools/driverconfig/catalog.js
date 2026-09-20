// What Driver Config knows without looking at a project: the controllers, the library's API, the
// rumble patterns. Every entry here was read out of the code the robot runs - FrcCatalyst at
// 5adc688b (built as 2.0.0-alpha.3) and WPILib 2027.0.0-alpha-6 - or measured on the Catalyst X1,
// rather than remembered. Where a value was neither, it says so: `measured` lists what has been
// confirmed on a real Driver Station, and everything else is a stated assumption the UI draws as one.

/** The Catalyst API this tool generates code for. */
export const LIBRARY = {
  version: "2.0.0-alpha.3",
  commit: "5adc688b",
  wpilib: "2027.0.0-alpha-6",
};

/**
 * How WPILib 2027 numbers buttons. getRawButton(n) and button(n) test bit `1L << n` of the Driver
 * Station's button word (DriverStationBackend.getStickButton, alpha-6 bytecode), so the first button
 * is 0. Through 2026 it was 1, and the 2027 javadoc for getRawButton still says so; the code does not.
 */
export const BUTTON_BASE = 0;

// ------------------------------------------------------------------ physical controls
//
// One name per physical control, and where the browser's "standard" Gamepad mapping puts it. The
// robot does not use these indices: the Driver Station numbers the same controls its own way, and
// that per-controller numbering is CONTROLLER_TYPES[...].axes / .buttons below. Keeping the two
// numberings apart is the whole point - it is exactly where a stick ends up driving the wrong axis.

export const CONTROLS = {
  leftX:    { label: "Left stick X",  kind: "axis",   std: { axis: 0 } },
  leftY:    { label: "Left stick Y",  kind: "axis",   std: { axis: 1 } },
  rightX:   { label: "Right stick X", kind: "axis",   std: { axis: 2 } },
  rightY:   { label: "Right stick Y", kind: "axis",   std: { axis: 3 } },
  lt:       { label: "Left trigger",  kind: "axis",   std: { button: 6 } },
  rt:       { label: "Right trigger", kind: "axis",   std: { button: 7 } },
  south:    { label: "Bottom face button", kind: "button", std: { button: 0 } },
  east:     { label: "Right face button",  kind: "button", std: { button: 1 } },
  west:     { label: "Left face button",   kind: "button", std: { button: 2 } },
  north:    { label: "Top face button",    kind: "button", std: { button: 3 } },
  l1:       { label: "Left bumper",   kind: "button", std: { button: 4 } },
  r1:       { label: "Right bumper",  kind: "button", std: { button: 5 } },
  l2:       { label: "Left trigger",  kind: "button", std: { button: 6 } },
  r2:       { label: "Right trigger", kind: "button", std: { button: 7 } },
  back:     { label: "Back",          kind: "button", std: { button: 8 } },
  start:    { label: "Start",         kind: "button", std: { button: 9 } },
  l3:       { label: "Left stick press",  kind: "button", std: { button: 10 } },
  r3:       { label: "Right stick press", kind: "button", std: { button: 11 } },
  dup:      { label: "D-pad up",      kind: "button", std: { button: 12 } },
  ddown:    { label: "D-pad down",    kind: "button", std: { button: 13 } },
  dleft:    { label: "D-pad left",    kind: "button", std: { button: 14 } },
  dright:   { label: "D-pad right",   kind: "button", std: { button: 15 } },
  guide:    { label: "Home",          kind: "button", std: { button: 16 } },
  touchpad: { label: "Touchpad press", kind: "button", std: { button: 17 } },
  misc1:    { label: "Misc 1", kind: "button", std: null },
  rpaddle1: { label: "Right paddle 1", kind: "button", std: null },
  lpaddle1: { label: "Left paddle 1",  kind: "button", std: null },
  rpaddle2: { label: "Right paddle 2", kind: "button", std: null },
  lpaddle2: { label: "Left paddle 2",  kind: "button", std: null },
  // A flight stick has no standard browser mapping, so these carry none: the preview reads its raw
  // indices and says that it is doing so.
  stickX:   { label: "Stick X",  kind: "axis", std: null },
  stickY:   { label: "Stick Y",  kind: "axis", std: null },
  twist:    { label: "Twist",    kind: "axis", std: null },
  throttle: { label: "Throttle", kind: "axis", std: null },
  trigger:  { label: "Trigger",  kind: "button", std: null },
  thumb:    { label: "Thumb button", kind: "button", std: null },
};

const range = (n, f) => Array.from({ length: n }, (_, i) => f(i));

/** WPILib's Gamepad layout, Gamepad.Button values 0-20 in alpha-6: the numbering the 2027 DS uses. */
const GAMEPAD_BUTTONS = ["south", "east", "west", "north", "back", "guide", "start", "l3", "r3", "l1", "r1",
  "dup", "ddown", "dleft", "dright", "misc1", "rpaddle1", "lpaddle1", "rpaddle2", "lpaddle2", "touchpad"];

// ------------------------------------------------------------------ controller types
//
// `axes[i]` / `buttons[i]` name the control the robot reads at raw index i - the number
// getRawAxis(i) and button(i) take, from 0.
//
// `rumble`: "yes" the pad rumbles through the Driver Station; "no" it has no motors; "unmeasured"
// nobody here has seen it rumble through the 2027 Driver Station. The generated code also asks the
// Driver Station at runtime (GenericHID.getSupportedOutputs) and warns once if the answer is no.

export const CONTROLLER_TYPES = {
  dualsense: {
    label: "DualSense (PS5)",
    about: "As the 2027 FIRST Driver Station reports a DualSense: in WPILib's gamepad layout, with four " +
      "axes and the D-pad as buttons 11 to 14 - there is no POV hat. Measured on the Catalyst X1: " +
      "Create 4, Options 6, L1 9, D-pad up 11, touchpad 20; axis 0 is left X and axis 2 right X, right " +
      "positive; axis 1 is left Y and reads -1 with the stick pushed up. The rest follow the same layout " +
      "and are drawn as assumptions until checked. L2 and R2 are the layout's axes 4 and 5, which this " +
      "Driver Station does not report, so where they land is not measured.",
    source: "measured on the Catalyst X1, 2026-09-10; the rest from Gamepad.Button, WPILib 2027.0.0-alpha-6",
    rumble: "unmeasured",
    pov: false,
    axes: ["leftX", "leftY", "rightX", "rightY"],
    buttons: GAMEPAD_BUTTONS.map((b) => (["rpaddle1", "lpaddle1", "rpaddle2", "lpaddle2"].includes(b) ? null : b)),
    names: { south: "Cross", east: "Circle", west: "Square", north: "Triangle", back: "Create", guide: "PS",
      start: "Options", l3: "L3", r3: "R3", l1: "L1", r1: "R1", misc1: "Mic", touchpad: "Touchpad" },
    known: false,
    measured: { axes: [0, 1, 2], buttons: [4, 6, 9, 11, 20] },
    defaults: { forward: { axis: 1, invert: true }, strafe: { axis: 0, invert: true }, turn: { axis: 2, invert: true } },
  },
  gamepad: {
    label: "Gamepad (2027 Driver Station layout)",
    about: "WPILib's Gamepad layout, which is how the 2027 FIRST Driver Station reports a pad - a DualSense " +
      "measured that way. South face is button 0, the bumpers 9 and 10, the D-pad buttons 11 to 14, the " +
      "triggers axes 4 and 5. The right choice for an Xbox pad on a Systemcore robot unless you measure " +
      "otherwise.",
    source: "Gamepad.Axis and .Button, WPILib 2027.0.0-alpha-6",
    rumble: "unmeasured",
    pov: false,
    axes: ["leftX", "leftY", "rightX", "rightY", "lt", "rt"],
    buttons: GAMEPAD_BUTTONS,
    names: { south: "South face (A)", east: "East face (B)", west: "West face (X)", north: "North face (Y)",
      back: "Back / View", guide: "Guide", start: "Start / Menu", l1: "Left bumper", r1: "Right bumper" },
    known: true,
    measured: { axes: [], buttons: [] },
    defaults: { forward: { axis: 1, invert: true }, strafe: { axis: 0, invert: true }, turn: { axis: 2, invert: true } },
  },
  xbox: {
    label: "Xbox (NI Driver Station layout)",
    about: "WPILib's NiDsXboxController layout, the way the NI Driver Station reported an XInput pad: A is " +
      "button 0, the triggers are axes 2 and 3, the right stick axes 4 and 5, the D-pad a POV hat. The " +
      "2027 FIRST Driver Station reports pads in the gamepad layout instead, so this is for code and pads " +
      "that were measured this way.",
    source: "NiDsXboxController.Axis and .Button, WPILib 2027.0.0-alpha-6",
    rumble: "yes",
    pov: true,
    axes: ["leftX", "leftY", "lt", "rt", "rightX", "rightY"],
    buttons: ["south", "east", "west", "north", "l1", "r1", "back", "start", "l3", "r3"],
    names: { south: "A", east: "B", west: "X", north: "Y", l1: "LB", r1: "RB", back: "Back",
      start: "Start", l3: "Left stick press", r3: "Right stick press", lt: "LT", rt: "RT" },
    known: true,
    measured: { axes: [], buttons: [] },
    defaults: { forward: { axis: 1, invert: true }, strafe: { axis: 0, invert: true }, turn: { axis: 4, invert: true } },
  },
  joystick: {
    label: "Flight stick",
    about: "A joystick such as a Logitech Extreme 3D Pro: X, Y, twist and throttle, a trigger and a " +
      "hat. It has no rumble motors.",
    source: "WPILib Joystick default channels; buttons assumed",
    rumble: "no",
    pov: true,
    browserRaw: true,
    axes: ["stickX", "stickY", "twist", "throttle"],
    buttons: ["trigger", "thumb", ...range(10, () => null)],
    names: {},
    known: false,
    measured: { axes: [], buttons: [] },
    defaults: { forward: { axis: 1, invert: true }, strafe: { axis: 0, invert: true }, turn: { axis: 2, invert: true } },
  },
  buttonbox: {
    label: "Button box",
    about: "A custom panel of buttons and switches. It has no rumble motors.",
    source: "raw indices",
    rumble: "no",
    pov: false,
    browserRaw: true,
    axes: range(4, () => null),
    buttons: range(16, () => null),
    names: {},
    known: false,
    measured: { axes: [], buttons: [] },
    defaults: {},
  },
  generic: {
    label: "Other controller",
    about: "Anything else, read by raw index. Check each index on the Driver Station before trusting it.",
    source: "raw indices",
    rumble: "unmeasured",
    pov: true,
    browserRaw: true,
    axes: range(8, () => null),
    buttons: range(16, () => null),
    names: {},
    known: false,
    measured: { axes: [], buttons: [] },
    defaults: { forward: { axis: 1, invert: true }, strafe: { axis: 0, invert: true }, turn: { axis: 2, invert: true } },
  },
};

export const POV_DIRECTIONS = ["UP", "UP_RIGHT", "RIGHT", "DOWN_RIGHT", "DOWN", "DOWN_LEFT", "LEFT", "UP_LEFT"];
export const POV_LABEL = { UP: "POV hat up", UP_RIGHT: "POV hat up-right", RIGHT: "POV hat right", DOWN_RIGHT: "POV hat down-right",
  DOWN: "POV hat down", DOWN_LEFT: "POV hat down-left", LEFT: "POV hat left", UP_LEFT: "POV hat up-left" };
/** CommandGenericHID's zero-argument POV triggers, which exist in alpha-6 and alpha-7 alike. */
export const POV_METHOD = { UP: "povUp", UP_RIGHT: "povUpRight", RIGHT: "povRight", DOWN_RIGHT: "povDownRight",
  DOWN: "povDown", DOWN_LEFT: "povDownLeft", LEFT: "povLeft", UP_LEFT: "povUpLeft" };

// ------------------------------------------------------------------ response curves
//
// DriverProfile.Curve at 5adc688b. EXPO's exponent is fixed at 3 in the library; there is no way to
// set it, so this tool does not pretend there is.
export const CURVES = {
  linear:  { label: "Linear",  java: "LINEAR",    about: "Output follows the stick." },
  squared: { label: "Squared", java: "QUADRATIC", about: "Softer near centre: half stick is a quarter speed." },
  cubic:   { label: "Cubic",   java: "CUBIC",     about: "Softer still: half stick is an eighth of the speed." },
  expo:    { label: "Expo",    java: "EXPO",      about: "Exponential, a = 3 (fixed in the library): very gentle until the last third." },
};

/** How a binding fires, in the words a driver uses and the Trigger method it becomes. */
export const WHEN = {
  onTrue:       { label: "when pressed",   java: "onTrue" },
  whileTrue:    { label: "while held",     java: "whileTrue" },
  toggleOnTrue: { label: "toggle on press", java: "toggleOnTrue" },
  onFalse:      { label: "when released",  java: "onFalse" },
};

// ------------------------------------------------------------------ rumble
//
// RumbleEvents.Pattern at 5adc688b, with the exact strength-over-time table from
// RumbleEvents.Active.strengthAt. The library drives the left and right motors together at this
// strength; it has no per-side or per-strength setting, so neither does this tool.
export const RUMBLE_PATTERNS = {
  SHORT:      { label: "Short",      ms: 120, segments: [[0, 0.12, 1]], about: "One buzz. \"Got it.\"" },
  LONG:       { label: "Long",       ms: 400, segments: [[0, 0.40, 1]], about: "A long buzz. Warnings." },
  DOUBLE_TAP: { label: "Double tap", ms: 220, segments: [[0, 0.08, 1], [0.14, 0.22, 1]], about: "Two taps. \"Ready.\"" },
  TRIPLE_TAP: { label: "Triple tap", ms: 310, segments: [[0, 0.07, 1], [0.12, 0.19, 1], [0.24, 0.31, 1]], about: "Three taps. Something important." },
  RAMP:       { label: "Ramp",       ms: 300, ramp: true, segments: [[0, 0.30, 1]], about: "Climbs to full over 0.3 s, then cuts. \"Charging.\"" },
};

/** Strength 0..1 at `t` seconds into a pattern, exactly as RumbleEvents computes it; -1 once over. */
export function rumbleStrengthAt(pattern, t) {
  const p = RUMBLE_PATTERNS[pattern];
  if (!p) return -1;
  if (p.ramp) return t < 0.30 ? t / 0.30 : -1;
  if (t >= p.ms / 1000) return -1;
  return p.segments.some(([a, b]) => t >= a && t < b) ? 1 : 0;
}

export const CHANNELS = {
  DRIVER:   { label: "Driver" },
  OPERATOR: { label: "Operator" },
  BOTH:     { label: "Both" },
};

// ------------------------------------------------------------------ the library's own actions
//
// Zero-argument public methods returning a command, per class, at 5adc688b (inheritance inside the
// library resolved). Only what a driver would put on a button is listed: idle(), build() and the
// like return commands too, and nobody binds them.
//
// SwerveSubsystem.resetHeading() is deliberately absent. It seeds 0 degrees on both alliances, while
// field-centric forward on Red is 180, so after it the robot's "forward" is its back. Driver Config
// offers the alliance-aware "Reseed heading" (BUILTIN_ACTIONS.reseed) in its place.
const MECH_STOP = { stopCommand: "Stop" };
export const LIBRARY_COMMANDS = {
  SwerveSubsystem: { xBrake: { label: "X-brake (lock the wheels)", when: "whileTrue" } },
  GhostReplay: { stopRecording: { label: "Stop recording", when: "onTrue" }, stopReplay: { label: "Stop replay", when: "onTrue" } },
  RollerMechanism: { intake: "Intake", eject: "Eject", intakeContinuous: "Intake (continuous)", resetPieceDetection: "Reset piece detection", ...MECH_STOP },
  ClawMechanism: { open: "Open", close: "Close", closeUntilGripped: "Close until gripped", hold: "Hold", resetPieceDetection: "Reset piece detection", ...MECH_STOP },
  FlywheelMechanism: { ...MECH_STOP },
  LinearMechanism: { holdPosition: "Hold position", holdPositionProfiled: "Hold position (profiled)", zero: "Zero", ...MECH_STOP },
  RotationalMechanism: { holdPosition: "Hold position", holdPositionProfiled: "Hold position (profiled)", zero: "Zero", ...MECH_STOP },
  DifferentialWristMechanism: { holdPosition: "Hold position", zero: "Zero", ...MECH_STOP },
  TurretMechanism: { holdAngle: "Hold angle", lockForward: "Lock forward", zero: "Zero", ...MECH_STOP },
  WinchMechanism: { extend: "Extend", retract: "Retract", zero: "Zero", ...MECH_STOP },
  PneumaticMechanism: { extend: "Extend", retract: "Retract", toggle: "Toggle", off: "Off", ...MECH_STOP },
  ServoMechanism: { hold: "Hold", ...MECH_STOP },
  LEDSubsystem: { allianceColor: "Alliance colour", fire: "Fire", off: "Off", rainbow: "Rainbow" },
  Superstructure: { clearFault: "Clear fault" },
  SystemCheck: { run: { label: "Run the system check", when: "onTrue" } },
};

/** Library calls Driver Config refuses to generate, and what to use instead. */
export const REFUSED_CALLS = {
  resetHeading: "resetHeading() seeds 0 degrees on both alliances. On Red, field-centric forward is 180, so " +
    "after it the robot drives toward its own back. Use \"Reseed heading\" (0 on Blue, 180 on Red) instead.",
};

/**
 * SwerveSubsystem drive commands that take the driver's sticks. Driver Config hands them its own
 * shaped suppliers, so holding the button keeps this profile's deadband, curve and speed limits.
 * The deadband argument is 0.0 because the profile has already applied one.
 */
export const STICK_COMMANDS = {
  headingLockDrive: { label: "Heading lock drive (these sticks)", args: "forward(), strafe(), turn(), 0.0" },
  robotCentricDrive: { label: "Robot-centric drive (these sticks)", args: "forward(), strafe(), turn()" },
  fieldCentricDrive: { label: "Plain field-centric drive (these sticks)", args: "forward(), strafe(), turn()" },
};

/** Zero-argument public methods returning a Trigger, per library class, at 5adc688b. */
export const LIBRARY_TRIGGERS = {
  PhysicsConstraints: { cautionAdvised: "Physics Core advises caution", localizationLost: "Localisation lost", tipRiskHigh: "Tip risk high" },
  RollerMechanism: { hasPieceTrigger: "Has a game piece" },
  ClawMechanism: { hasPieceTrigger: "Has a game piece" },
  FlywheelMechanism: { atSpeedTrigger: "Flywheel at speed" },
  LinearMechanism: { forwardLimitTrigger: "Forward limit", reverseLimitTrigger: "Reverse limit" },
  RotationalMechanism: { hardStopTrigger: "Hit a hard stop" },
  DifferentialWristMechanism: { atSetpointTrigger: "At setpoint" },
  TurretMechanism: { atSetpointTrigger: "At setpoint" },
  WinchMechanism: { fullyExtendedTrigger: "Fully extended", fullyRetractedTrigger: "Fully retracted" },
  PneumaticMechanism: { forwardTrigger: "Extended", reverseTrigger: "Retracted" },
  GamePieceTracker: { hasPieceTrigger: "Has a game piece", noPieceTrigger: "No game piece", readyToScoreTrigger: "Ready to score" },
  LimelightTriggers: { hasTarget: "Camera has a target" },
  GoalDirector: { readyTrigger: "Goal director ready" },
  Superstructure: { faulted: "Superstructure faulted", transitioning: "Superstructure moving", rejected: "Request rejected", overridden: "Overridden" },
  SuperstructureCoordinator: { transitionComplete: "Transition complete" },
};

/** Zero-argument public boolean methods on library classes that make useful events, at 5adc688b. */
export const LIBRARY_BOOLEANS = {
  GhostReplay: { isRecording: "Recording a ghost", isReplaying: "Replaying a ghost" },
  BrownoutMonitor: { atRisk: "Brownout risk", isArmed: "Brownout monitor armed" },
};

/** Library superclasses a project class may extend, so its inherited commands are offered too. */
export const LIBRARY_PARENTS = {
  CatalystMechanism: null, CatalystSubsystem: null,
  RollerMechanism: "CatalystMechanism", ClawMechanism: "CatalystMechanism", FlywheelMechanism: "CatalystMechanism",
  LinearMechanism: "CatalystMechanism", RotationalMechanism: "CatalystMechanism",
  DifferentialWristMechanism: "CatalystMechanism", TurretMechanism: "CatalystMechanism",
  WinchMechanism: "CatalystMechanism", PneumaticMechanism: "CatalystMechanism", ServoMechanism: "CatalystMechanism",
  SwerveSubsystem: "CatalystSubsystem", LEDSubsystem: "CatalystSubsystem", VisionSubsystem: "CatalystSubsystem",
};

/**
 * Events every Catalyst robot has, from static library methods at 5adc688b. `param` names the one
 * number a method takes. The fully qualified name is deliberate: robot code routinely imports
 * org.wpilib.driverstation.RobotState, and Catalyst's RobotState must not be confused with it.
 */
export const STATIC_EVENTS = {
  "RobotState.lateMatch": { label: "Match time at or below", param: { name: "seconds", unit: "s", default: 20, min: 1, max: 150 },
    java: (p) => `frc.lib.catalyst.util.RobotState.lateMatch(${javaNumber(p)})` },
  "RobotState.lowBattery": { label: "Battery below", param: { name: "volts", unit: "V", default: 11.5, min: 6, max: 13 },
    java: (p) => `frc.lib.catalyst.util.RobotState.lowBattery(${javaNumber(p)})` },
  "RobotSafety.trippedTrigger": { label: "Safety watchdog tripped", java: () => "frc.lib.catalyst.util.RobotSafety.trippedTrigger()" },
  "RobotState.enabled": { label: "Robot enabled", java: () => "frc.lib.catalyst.util.RobotState.enabled()" },
  "RobotState.teleop": { label: "Teleop starts", java: () => "frc.lib.catalyst.util.RobotState.teleop()" },
  "RobotState.autonomous": { label: "Autonomous starts", java: () => "frc.lib.catalyst.util.RobotState.autonomous()" },
};

/** Driver Config's own actions: the speed modes the generated class owns, and the reseed. */
export const BUILTIN_ACTIONS = {
  slow: { label: "Slow mode", about: "Hold for the slow multiplier.", when: ["whileTrue", "toggleOnTrue"] },
  turbo: { label: "Turbo", about: "Hold for the turbo multiplier. Slow mode wins if both are held.", when: ["whileTrue", "toggleOnTrue"] },
  reseed: { label: "Reseed heading (0 deg Blue, 180 Red)", needsDrive: true, when: ["onTrue"],
    about: "Makes the robot's current facing field-centric forward for this alliance: 0 degrees on Blue, " +
      "180 on Red, as X1 does (AllianceFlipUtil.shouldFlip). Point the robot away from your wall first." },
};

/** Events the generated class itself can see. */
export const BUILTIN_EVENTS = {
  slow: { label: "Slow mode engaged" },
  turbo: { label: "Turbo engaged" },
};

/** A double as Java source: always with a decimal point, never in exponent form for these ranges. */
export function javaNumber(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) throw new Error(`not a number: ${x}`);
  const s = String(Math.round(n * 1e6) / 1e6);
  return /[.eE]/.test(s) ? s : s + ".0";
}

/** "closeUntilGripped" -> "Close until gripped". */
export function humanize(name) {
  const words = String(name).replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
