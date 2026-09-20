// Driver Config's data: the profile format, its defaults, the checks that stop a mistake before it
// reaches a robot, and the stick math the live preview shares with the generated Java.
//
// Everything here is a pure function of plain JSON, so the page, the tests and the code generator
// all run the same code. Nothing in this file touches the DOM, the network or a project.

import {
  BUILTIN_ACTIONS, BUILTIN_EVENTS, CHANNELS, CONTROLLER_TYPES, CONTROLS, CURVES, LIBRARY,
  POV_DIRECTIONS, POV_LABEL, REFUSED_CALLS, RUMBLE_PATTERNS, STATIC_EVENTS, WHEN, humanize,
} from "./catalog.js";

export const FORMAT = "catalyst-driver-config";
export const VERSION = 1;

/** The three axes a drive command takes. Any other role is an extra axis the team names itself. */
export const DRIVE_ROLES = ["forward", "strafe", "turn"];
export const ROLE = {
  forward: { label: "Forward / back", about: "+ drives away from the driver" },
  strafe: { label: "Sideways", about: "+ drives to the driver's left" },
  turn: { label: "Turn", about: "+ turns counter-clockwise" },
};
export const roleLabel = (role) => (ROLE[role] ? ROLE[role].label : humanize(role));
export const PORTS = 6;

/**
 * What a generated constants block defines, for robot code that builds its own DriverProfile - the
 * shape of X1Constants.Driving (DEADBAND, MAX_SPEED, DEFAULT_CURVE), and the rest of the profile's
 * feel beside them so nothing a driver set is lost.
 */
export const CONSTANT_NAMES = ["DEADBAND", "MAX_SPEED", "DEFAULT_CURVE", "SLOW_MODE", "TURBO", "TURN_SCALE",
  "SLEW_SECONDS", "DRIVER_PORT", "FORWARD_AXIS", "FORWARD_INVERTED", "STRAFE_AXIS", "STRAFE_INVERTED",
  "TURN_AXIS", "TURN_INVERTED"];

/** Why a library call is refused, or null. */
export function refusal(expr) {
  const m = /\.([A-Za-z_$][\w$]*)\([^()]*\)$/.exec(String(expr));
  return m && REFUSED_CALLS[m[1]] ? REFUSED_CALLS[m[1]] : null;
}

export const JAVA_IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
export const JAVA_PACKAGE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
export const JAVA_KEYWORDS = new Set(("abstract assert boolean break byte case catch char class const continue default do " +
  "double else enum extends final finally float for goto if implements import instanceof int interface long native " +
  "new package private protected public return short static strictfp super switch synchronized this throw throws " +
  "transient try void volatile while true false null var record yield sealed permits").split(" "));

// The only Java expressions a stored binding or rumble rule may carry. The generator refuses
// anything else, so a hand-edited profile cannot put arbitrary code into a robot project.
const IDENT = "[A-Za-z_$][A-Za-z0-9_$]*";
const CHAIN = `robot(?:\\.${IDENT})*`;
export const SAFE_ACTION = new RegExp(`^${CHAIN}\\.${IDENT}\\((?:forward\\(\\), strafe\\(\\), turn\\(\\)(?:, 0\\.0)?)?\\)$`);
export const SAFE_EVENT = new RegExp(`^(?:${CHAIN}\\.${IDENT}\\(\\)|new Trigger\\(${CHAIN}::${IDENT}\\))$`);

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v, d) => (typeof v === "string" ? v : d);
const numOr = (v, d) => (v === undefined || v === null || v === "" ? d : Number(v));
const intOr = (v, d) => { const n = numOr(v, d); return Number.isFinite(n) ? n : d; };
export const round6 = (x) => Math.round(x * 1e6) / 1e6;
export const clone = (x) => JSON.parse(JSON.stringify(x));
export const pct = (x) => `${Math.round(x * 1000) / 10}%`;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

// ------------------------------------------------------------------ controller layouts

/**
 * A controller type as this config sees it: the built-in layout, with whatever the team has
 * measured or corrected on its own Driver Station laid over it.
 */
export function layoutOf(config, typeId) {
  const base = CONTROLLER_TYPES[typeId];
  if (!base) return null;
  const o = (config && isObj(config.maps) && isObj(config.maps[typeId])) ? config.maps[typeId] : {};
  const fits = (arr, len) => Array.isArray(arr) && arr.length === len;
  return {
    id: typeId,
    ...base,
    axes: fits(o.axes, base.axes.length) ? o.axes : base.axes,
    buttons: fits(o.buttons, base.buttons.length) ? o.buttons : base.buttons,
    measuredAxes: new Set([...base.measured.axes, ...(o.measuredAxes || [])]),
    measuredButtons: new Set([...base.measured.buttons, ...(o.measuredButtons || [])]),
  };
}

export function controlName(layout, id) {
  if (!id) return null;
  return (layout.names && layout.names[id]) || (CONTROLS[id] ? CONTROLS[id].label : id);
}
export const axisName = (layout, i) => controlName(layout, layout.axes[i]);
export const buttonName = (layout, i) => controlName(layout, layout.buttons[i]);

export function inputKey(input) {
  if (!isObj(input)) return "?";
  if (input.kind === "button") return `b${input.index}`;
  if (input.kind === "pov") return `pov:${input.dir}`;
  if (input.kind === "axis") return `a${input.index}>${input.threshold}`;
  return "?";
}

export function inputLabel(layout, input) {
  if (!isObj(input)) return "nothing";
  if (input.kind === "button") {
    const n = layout ? buttonName(layout, input.index) : null;
    return `Button ${input.index}` + (n ? ` · ${n}` : "");
  }
  if (input.kind === "pov") return POV_LABEL[input.dir] || `POV ${input.dir}`;
  if (input.kind === "axis") {
    const n = layout ? axisName(layout, input.index) : null;
    return `Axis ${input.index} past ${Math.round(input.threshold * 100)}%` + (n ? ` · ${n}` : "");
  }
  return "unknown input";
}

/** True when the team measured what this raw index is, false when it is the layout's assumption. */
export function isMeasured(layout, kind, index) {
  if (!layout) return false;
  return kind === "axis" ? layout.measuredAxes.has(index) : layout.measuredButtons.has(index);
}

/** Every input a binding can use on this layout. */
export function inputsFor(layout) {
  const out = layout.buttons.map((_, index) => ({ kind: "button", index }));
  if (layout.pov) for (const dir of POV_DIRECTIONS) out.push({ kind: "pov", dir });
  layout.axes.forEach((c, index) => { if (c === "lt" || c === "rt") out.push({ kind: "axis", index, threshold: 0.5 }); });
  return out;
}

export function actionLabel(action) {
  if (!isObj(action)) return "nothing";
  if (action.kind === "builtin") return BUILTIN_ACTIONS[action.id] ? BUILTIN_ACTIONS[action.id].label : action.id;
  return action.label || action.expr || "command";
}

export function eventLabel(event, layout) {
  if (!isObj(event)) return "nothing";
  if (event.kind === "builtin") return BUILTIN_EVENTS[event.id] ? BUILTIN_EVENTS[event.id].label : event.id;
  if (event.kind === "static") {
    const s = STATIC_EVENTS[event.id];
    if (!s) return event.id;
    return s.param ? `${s.label} ${event.param} ${s.param.unit}` : s.label;
  }
  if (event.kind === "input") return `${inputLabel(layout, event.input)} pressed`;
  return event.label || event.expr || "trigger";
}

// ------------------------------------------------------------------ the stick math
//
// The same arithmetic, in the same order, as the generated Java: WPILib's MathUtil.applyDeadband
// (alpha-6 bytecode: (1 + d / (1 - d)) * (v -/+ d)), then DriverProfile's curve, then the cap -
// `maxSpeed`, times `slowMode` while slow is held. Turbo is a second DriverProfile whose cap is the
// turbo cap. The preview is only worth trusting if these match exactly.

export function applyDeadband(v, d) {
  if (Math.abs(v) < d) return 0;
  const k = 1 + d / (1 - d);
  return v > 0 ? k * (v - d) : k * (v + d);
}

export function applyCurve(x, curve) {
  switch (curve) {
    case "squared": return x * Math.abs(x);
    case "cubic": return x * x * x;
    case "expo": return Math.sign(x) * (Math.exp(3 * Math.abs(x)) - 1) * (1 / (Math.exp(3) - 1));
    default: return x;
  }
}

/** The caps an axis gets in each speed mode. Extra axes ignore the speed modes. */
export function capsFor(axis, speed, isDrive = DRIVE_ROLES.includes(axis.role)) {
  if (!isDrive) { const c = round6(axis.scale); return { normal: c, slowMultiplier: 1, slow: c, turbo: c }; }
  const normal = round6(axis.scale * speed.max);
  return {
    normal,
    slowMultiplier: speed.slow,
    slow: normal * speed.slow,
    turbo: round6(Math.min(1, axis.scale * speed.max * speed.turbo)),
  };
}

/** "slow" wins over "turbo" when both are held: the safer of the two. */
export const modeOf = (slowHeld, turboHeld) => (slowHeld ? "slow" : turboHeld ? "turbo" : "normal");

/** Shape one raw axis value the way the robot will, stage by stage (slew excluded: it needs time). */
export function shape(raw, axis, speed, mode = "normal") {
  const isDrive = DRIVE_ROLES.includes(axis.role);
  const caps = capsFor(axis, speed, isDrive);
  const inverted = axis.invert ? -raw : raw;
  const deadbanded = applyDeadband(inverted, axis.deadband);
  const curved = applyCurve(deadbanded, axis.curve);
  let cap = caps.normal;
  if (isDrive && mode === "turbo") cap = caps.turbo;
  else if (isDrive && mode === "slow") cap = caps.normal * caps.slowMultiplier;
  return { raw, inverted, deadbanded, curved, cap, value: curved * cap };
}

/** Catalyst's SlewRateLimiter, stepped by hand for the preview: symmetric, full scale in `slew` s. */
export function slewStep(previous, target, slewSeconds, dt) {
  if (!(slewSeconds > 0)) return target;
  const max = dt / slewSeconds;
  const delta = target - previous;
  return delta > 0 ? previous + Math.min(delta, max) : previous + Math.max(delta, -max);
}

// ------------------------------------------------------------------ making configs

export function defaultAxis(role, typeId = "gamepad") {
  const t = CONTROLLER_TYPES[typeId];
  const d = (t && t.defaults[role]) || { axis: 0, invert: false };
  return { role, axis: d.axis, invert: d.invert, deadband: 0.08, curve: "squared", scale: role === "turn" ? 0.8 : 1, slew: 0 };
}

export function newProfile(name, typeId = "gamepad", port = 0) {
  const t = CONTROLLER_TYPES[typeId] || CONTROLLER_TYPES.gamepad;
  return {
    name,
    controller: { type: typeId, port },
    axes: DRIVE_ROLES.filter((r) => t.defaults[r]).map((r) => defaultAxis(r, typeId)),
    speed: { max: 0.8, slow: 0.35, turbo: 1.25 },
    bindings: [],
    rumble: [],
  };
}

export function blankConfig(target = {}) {
  return normalize({
    format: FORMAT, version: VERSION, library: LIBRARY.version,
    target, operator: null, maps: {}, defaultProfile: "Driver 1",
    profiles: [newProfile("Driver 1")],
  });
}

/**
 * The Catalyst X1, as measured on 2026-09-10 and as its code means to be driven.
 *
 * The pad is a DualSense, which the 2027 FIRST Driver Station reports in the gamepad layout. Forward
 * is axis 1, where stick-up reads -1, so it is inverted; sideways is axis 0 and turn axis 2, both
 * right-positive, so both are inverted to make + the driver's left. The feel is X1Constants.Driving:
 * deadband 0.08, LINEAR, no cap, and slow mode 0.35 (SLOW_MODE_FACTOR).
 *
 * The buttons are X1.bindDriver()'s intent - A co-pilot, B x-brake, Start reseed, LB slow, RB
 * heading lock, D-pad up align - placed on the DualSense buttons those names mean. X1's own code
 * reads them through CommandNiDsXboxController, whose numbers land elsewhere on this pad (its
 * leftBumper() is Create, and its povUp() can never fire), which is the mistake this tool exists to
 * stop. "Reseed" is the alliance-aware one X1 now uses, not resetHeading(). The rumble rules are
 * X1's own: slow mode, tip risk, the safety watchdog, ghost recording and brownout risk.
 *
 * "Rookie" is the same robot for a first-time driver: cubic sticks, 60% top speed, a softer start.
 */
export function sampleConfig() {
  const axes = (curve, turnScale, slew) => [
    { role: "forward", axis: 1, invert: true, deadband: 0.08, curve, scale: 1, slew },
    { role: "strafe", axis: 0, invert: true, deadband: 0.08, curve, scale: 1, slew },
    { role: "turn", axis: 2, invert: true, deadband: 0.08, curve, scale: turnScale, slew },
  ];
  const btn = (index) => ({ kind: "button", index });
  const cmd = (expr, label) => ({ kind: "command", expr, label });
  const x1Bindings = [
    { input: btn(0), when: "toggleOnTrue", action: cmd("robot.coPilot()", "Co pilot") },
    { input: btn(1), when: "whileTrue", action: cmd("robot.drive.xBrake()", "X-brake (lock the wheels)") },
    { input: btn(6), when: "onTrue", action: { kind: "builtin", id: "reseed" } },
    { input: btn(9), when: "whileTrue", action: { kind: "builtin", id: "slow" } },
    { input: btn(10), when: "whileTrue",
      action: cmd("robot.drive.headingLockDrive(forward(), strafe(), turn(), 0.0)", "Heading lock drive (these sticks)") },
    { input: btn(11), when: "toggleOnTrue", action: cmd("robot.alignToTag()", "Align to tag") },
  ];
  const rumble = [
    { event: { kind: "builtin", id: "slow" }, pattern: "SHORT", channel: "DRIVER" },
    { event: { kind: "trigger", expr: "robot.constraints.tipRiskHigh()", label: "Tip risk high" }, pattern: "LONG", channel: "DRIVER" },
    { event: { kind: "static", id: "RobotSafety.trippedTrigger" }, pattern: "LONG", channel: "DRIVER" },
    { event: { kind: "trigger", expr: "new Trigger(robot.ghost::isRecording)", label: "Recording a ghost" }, pattern: "DOUBLE_TAP", channel: "DRIVER" },
    { event: { kind: "trigger", expr: "new Trigger(robot.brownout::atRisk)", label: "Brownout risk" }, pattern: "LONG", channel: "DRIVER" },
  ];
  return normalize({
    format: FORMAT, version: VERSION, library: LIBRARY.version,
    target: { package: "frc.robot", className: "DriverConfig", robotClass: "X1", swerveField: "drive", classFile: true,
      constants: { path: "src/main/java/frc/robot/X1Constants.java", className: "Driving" } },
    operator: null,
    maps: {},
    defaultProfile: "X1",
    profiles: [
      { name: "X1", controller: { type: "dualsense", port: 0 }, axes: axes("linear", 1, 0),
        speed: { max: 1, slow: 0.35, turbo: 1 }, bindings: x1Bindings, rumble },
      { name: "Rookie", controller: { type: "dualsense", port: 0 }, axes: axes("cubic", 0.7, 0.3),
        speed: { max: 0.6, slow: 0.5, turbo: 1.5 },
        bindings: [...x1Bindings, { input: btn(3), when: "whileTrue", action: { kind: "builtin", id: "turbo" } }],
        rumble: [...rumble, { event: { kind: "builtin", id: "turbo" }, pattern: "SHORT", channel: "DRIVER" }] },
    ],
  });
}

// ------------------------------------------------------------------ reading a config

function normalizeInput(i) {
  if (!isObj(i)) return { kind: "button", index: 0 };
  if (i.kind === "pov") return { kind: "pov", dir: str(i.dir, "UP") };
  if (i.kind === "axis") return { kind: "axis", index: intOr(i.index, 0), threshold: numOr(i.threshold, 0.5) };
  return { kind: "button", index: intOr(i.index, 0) };
}

function normalizeAction(a) {
  if (!isObj(a)) return { kind: "builtin", id: "slow" };
  if (a.kind === "builtin") return { kind: "builtin", id: str(a.id, "") };
  return { kind: "command", expr: str(a.expr, ""), label: str(a.label, "") };
}

function normalizeEvent(e) {
  if (!isObj(e)) return { kind: "builtin", id: "slow" };
  if (e.kind === "builtin") return { kind: "builtin", id: str(e.id, "") };
  if (e.kind === "static") {
    const s = STATIC_EVENTS[e.id];
    return s && s.param ? { kind: "static", id: e.id, param: numOr(e.param, s.param.default) } : { kind: "static", id: str(e.id, "") };
  }
  if (e.kind === "input") return { kind: "input", input: normalizeInput(e.input) };
  return { kind: "trigger", expr: str(e.expr, ""), label: str(e.label, "") };
}

function normalizeProfile(p, i) {
  const q = isObj(p) ? p : {};
  const c = isObj(q.controller) ? q.controller : {};
  const s = isObj(q.speed) ? q.speed : {};
  return {
    name: str(q.name, `Driver ${i + 1}`),
    controller: { type: str(c.type, "gamepad"), port: intOr(c.port, 0) },
    axes: (Array.isArray(q.axes) ? q.axes : []).map((a) => {
      const x = isObj(a) ? a : {};
      return {
        role: str(x.role, "forward"), axis: intOr(x.axis, 0), invert: x.invert === true,
        deadband: numOr(x.deadband, 0.08), curve: str(x.curve, "linear"),
        scale: numOr(x.scale, 1), slew: numOr(x.slew, 0),
      };
    }),
    speed: { max: numOr(s.max, 1), slow: numOr(s.slow, 0.3), turbo: numOr(s.turbo, 1) },
    bindings: (Array.isArray(q.bindings) ? q.bindings : []).map((b) => ({
      input: normalizeInput(b && b.input), when: str(b && b.when, "onTrue"), action: normalizeAction(b && b.action),
    })),
    rumble: (Array.isArray(q.rumble) ? q.rumble : []).map((r) => ({
      event: normalizeEvent(r && r.event), pattern: str(r && r.pattern, "SHORT"), channel: str(r && r.channel, "DRIVER"),
    })),
  };
}

function normalizeMaps(m) {
  const out = {};
  if (!isObj(m)) return out;
  for (const [type, o] of Object.entries(m)) {
    if (!CONTROLLER_TYPES[type] || !isObj(o)) continue;
    const e = {};
    if (Array.isArray(o.axes)) e.axes = o.axes.map((x) => (typeof x === "string" && CONTROLS[x] ? x : null));
    if (Array.isArray(o.buttons)) e.buttons = o.buttons.map((x) => (typeof x === "string" && CONTROLS[x] ? x : null));
    if (Array.isArray(o.measuredAxes)) e.measuredAxes = o.measuredAxes.filter(Number.isInteger).sort((a, b) => a - b);
    if (Array.isArray(o.measuredButtons)) e.measuredButtons = o.measuredButtons.filter(Number.isInteger).sort((a, b) => a - b);
    if (Object.keys(e).length) out[type] = e;
  }
  return out;
}

/**
 * A complete config in canonical key order, from anything shaped roughly like one. Missing fields
 * get defaults; wrong values are kept, not repaired, so validate() can say what is wrong with them
 * instead of the tool quietly changing a number a driver chose.
 */
export function normalize(raw) {
  const c = isObj(raw) ? raw : {};
  const t = isObj(c.target) ? c.target : {};
  const profiles = (Array.isArray(c.profiles) ? c.profiles : []).map(normalizeProfile);
  const def = str(c.defaultProfile, "");
  return {
    format: FORMAT,
    version: VERSION,
    library: str(c.library, LIBRARY.version),
    target: {
      package: str(t.package, "frc.robot"),
      className: str(t.className, "DriverConfig"),
      robotClass: t.robotClass == null || t.robotClass === "" ? null : String(t.robotClass),
      swerveField: t.swerveField == null || t.swerveField === "" ? null : String(t.swerveField),
      classFile: t.classFile !== false,
      constants: isObj(t.constants) ? { path: str(t.constants.path, ""), className: str(t.constants.className, "Driving") } : null,
    },
    operator: isObj(c.operator) ? { type: str(c.operator.type, "gamepad"), port: intOr(c.operator.port, 1) } : null,
    maps: normalizeMaps(c.maps),
    defaultProfile: def || (profiles[0] ? profiles[0].name : ""),
    profiles,
  };
}

/** Parse the profile JSON the generated file carries. Throws with a sentence a person can act on. */
export function parseConfig(text) {
  let raw;
  try { raw = JSON.parse(text); } catch (e) { throw new Error(`the profile is not valid JSON (${e.message})`); }
  if (!isObj(raw) || raw.format !== FORMAT) throw new Error("this is not a Driver Config profile");
  if (typeof raw.version !== "number" || raw.version > VERSION) {
    throw new Error(`it was written by a newer Driver Config (format ${raw.version}); update the Catalyst app to open it`);
  }
  return normalize(raw);
}

export const serializeConfig = (config) => JSON.stringify(normalize(config), null, 2);
export const sameConfig = (a, b) => serializeConfig(a) === serializeConfig(b);

/** Where the generated file goes, relative to the project root. */
export const javaPath = (config) =>
  `src/main/java/${config.target.package.replace(/\./g, "/")}/${config.target.className}.java`;

// ------------------------------------------------------------------ profile operations
// Each returns a new config; the page keeps the old one on its undo stack.

export function uniqueName(base, taken) {
  if (!taken.includes(base)) return base;
  for (let i = 2; ; i++) if (!taken.includes(`${base} ${i}`)) return `${base} ${i}`;
}

export function addProfile(config, profile) {
  const c = clone(config);
  const name = uniqueName(profile.name, c.profiles.map((p) => p.name));
  c.profiles.push({ ...clone(profile), name });
  if (!c.defaultProfile) c.defaultProfile = name;
  return { config: c, name };
}

export function duplicateProfile(config, name) {
  const p = config.profiles.find((x) => x.name === name);
  if (!p) throw new Error(`no profile named ${name}`);
  return addProfile(config, { ...clone(p), name: `${name} copy` });
}

export function renameProfile(config, from, to) {
  const name = String(to).trim();
  if (!name) throw new Error("a profile needs a name");
  if (name !== from && config.profiles.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
    throw new Error(`there is already a profile called ${name}`);
  }
  const c = clone(config);
  const p = c.profiles.find((x) => x.name === from);
  if (!p) throw new Error(`no profile named ${from}`);
  p.name = name;
  if (c.defaultProfile === from) c.defaultProfile = name;
  return c;
}

export function deleteProfile(config, name) {
  if (config.profiles.length <= 1) throw new Error("the last profile cannot be deleted; the robot needs one to drive with");
  const c = clone(config);
  c.profiles = c.profiles.filter((p) => p.name !== name);
  if (c.defaultProfile === name) c.defaultProfile = c.profiles[0].name;
  return c;
}

export function setDefaultProfile(config, name) {
  if (!config.profiles.some((p) => p.name === name)) throw new Error(`no profile named ${name}`);
  return { ...clone(config), defaultProfile: name };
}

// ------------------------------------------------------------------ validation
//
// An error stops Apply: the robot would do something nobody asked for. A warning is something to
// read before driving. Every message names the profile and the control, because "invalid deadband"
// on a page with three profiles and six axes is a message nobody can act on.

/**
 * @param project optional scan of the robot project (project.js): which actions and events exist,
 *   what its own code already binds, and whether its drivetrain already slews.
 */
export function validate(config, project = null) {
  const out = [];
  const err = (message, where = {}) => out.push({ level: "error", message, where });
  const warn = (message, where = {}) => out.push({ level: "warn", message, where });
  if (!config || !Array.isArray(config.profiles) || config.profiles.length === 0) {
    err("There are no profiles. Add one before applying.", { tab: "profiles" });
    return out;
  }

  const t = config.target || {};
  if (!JAVA_PACKAGE.test(t.package || "")) err(`"${t.package}" is not a Java package name.`, { tab: "project" });
  if (!JAVA_IDENT.test(t.className || "") || JAVA_KEYWORDS.has(t.className)) err(`"${t.className}" is not a usable Java class name.`, { tab: "project" });
  if (t.robotClass != null && (!JAVA_IDENT.test(t.robotClass) || JAVA_KEYWORDS.has(t.robotClass))) err(`"${t.robotClass}" is not a Java class name.`, { tab: "project" });
  if (!t.classFile && !t.constants) err("Nothing is set to be written. Switch on DriverConfig.java, a constants block, or both.", { tab: "project" });
  if (t.constants) {
    const k = t.constants;
    if (!/^src\/main\/java\/[A-Za-z0-9_$/]+\.java$/.test(k.path) || k.path.includes("..")) {
      err(`The constants block's file "${k.path}" must be a .java file under src/main/java.`, { tab: "project" });
    }
    if (!JAVA_IDENT.test(k.className) || JAVA_KEYWORDS.has(k.className)) err(`"${k.className}" is not a usable name for the constants class.`, { tab: "project" });
    const block = project && project.constantsBlocks && project.constantsBlocks.find((b) => b.path === k.path && b.className === k.className);
    const missing = block ? block.refs.filter((n) => !CONSTANT_NAMES.includes(n)) : [];
    if (missing.length) {
      err(`The project reads ${missing.map((n) => `${k.className}.${n}`).join(", ")}, which the generated block does not define, so the build would fail. Driver Config writes ${CONSTANT_NAMES.join(", ")}.`, { tab: "project" });
    }
    const def = config.profiles.find((p) => p.name === config.defaultProfile);
    const drive = def ? def.axes.filter((a) => DRIVE_ROLES.includes(a.role)) : [];
    if (drive.length && (new Set(drive.map((a) => a.deadband)).size > 1 || new Set(drive.map((a) => a.curve)).size > 1)) {
      warn(`The constants block has one DEADBAND and one DEFAULT_CURVE, and ${def.name}'s sticks differ, so the block takes ${roleLabel(drive[0].role)}'s.`, { profile: def.name, tab: "sticks" });
    }
  }

  const names = new Map();
  for (const p of config.profiles) {
    const where = { profile: p.name, tab: "profiles" };
    if (!p.name.trim()) err("A profile has no name.", where);
    else if (p.name.length > 40) err(`The profile name "${p.name.slice(0, 20)}..." is longer than 40 characters.`, where);
    if (CONTROL_CHARS.test(p.name)) err(`The profile name "${p.name.replace(CONTROL_CHARS, "?")}" contains a control character.`, where);
    const k = p.name.trim().toLowerCase();
    if (names.has(k)) err(`Two profiles are called "${p.name}". The dashboard picks a driver by name, so names must differ.`, where);
    names.set(k, p);
  }
  if (!config.profiles.some((p) => p.name === config.defaultProfile)) {
    err("No profile is the default. Mark one: the robot drives with it until someone picks another.", { tab: "profiles" });
  }

  if (config.operator) {
    const o = config.operator;
    if (!CONTROLLER_TYPES[o.type]) err(`The operator controller type "${o.type}" is not one Driver Config knows.`, { tab: "rumble" });
    if (!Number.isInteger(o.port) || o.port < 0 || o.port >= PORTS) err(`The operator controller is on port ${o.port}; Driver Station ports are 0 to 5.`, { tab: "rumble" });
    for (const p of config.profiles) {
      if (p.controller.port === o.port) warn(`${p.name} drives with port ${o.port}, which is also the operator's port. Both are then the same controller.`, { profile: p.name, tab: "rumble" });
    }
  }

  for (const p of config.profiles) validateProfile(config, p, project, err, warn);
  return out;
}

function validateProfile(config, p, project, err, warn) {
  const at = (tab, extra = {}) => ({ profile: p.name, tab, ...extra });
  const layout = layoutOf(config, p.controller.type);
  if (!layout) { err(`${p.name}: "${p.controller.type}" is not a controller type Driver Config knows.`, at("controller")); return; }
  if (!Number.isInteger(p.controller.port) || p.controller.port < 0 || p.controller.port >= PORTS) {
    err(`${p.name}: the controller is on port ${p.controller.port}; Driver Station ports are 0 to 5.`, at("controller"));
  }

  // --- sticks
  const byAxis = new Map();
  const roles = new Set();
  p.axes.forEach((a, i) => {
    const R = roleLabel(a.role);
    const w = (field) => at("sticks", { axis: i, field });
    if (!ROLE[a.role] && (!JAVA_IDENT.test(a.role) || JAVA_KEYWORDS.has(a.role))) err(`${p.name}: "${a.role}" cannot name an axis in Java. Use letters and digits, starting with a letter.`, w("role"));
    if (roles.has(a.role)) err(`${p.name}: ${R} is set up twice. Delete one of the two rows.`, w("role"));
    roles.add(a.role);
    const n = layout.axes.length;
    if (!Number.isInteger(a.axis) || a.axis < 0 || a.axis >= n) {
      err(`${p.name}: ${R} reads axis ${a.axis}, but a ${layout.label} reports ${n} axes (0 to ${n - 1}). Axis ${a.axis} never leaves zero, so ${R} would never move.`, w("axis"));
    } else if (byAxis.has(a.axis)) {
      const other = byAxis.get(a.axis);
      const fight = other.invert !== a.invert ? ", inverted for one and not the other, so the two pull opposite ways" : "";
      err(`${p.name}: axis ${a.axis} is mapped twice, to ${roleLabel(other.role)} and to ${R}${fight}. One stick would move the robot two ways at once.`, w("axis"));
    } else {
      byAxis.set(a.axis, a);
    }
    if (!Number.isFinite(a.deadband) || a.deadband <= 0) {
      err(`${p.name}: ${R} has a deadband of 0. A stick that does not rest at exactly zero, and a worn one never does, creeps the robot.`, w("deadband"));
    } else if (a.deadband > 0.5) {
      err(`${p.name}: ${R} has a deadband of ${a.deadband}. More than half the stick's travel would do nothing.`, w("deadband"));
    } else if (a.deadband < 0.02) {
      warn(`${p.name}: ${R}'s deadband of ${a.deadband} is smaller than most sticks drift. Expect the robot to creep.`, w("deadband"));
    } else if (a.deadband > 0.25) {
      warn(`${p.name}: ${R}'s deadband of ${a.deadband} means the first quarter of the stick does nothing.`, w("deadband"));
    }
    if (!CURVES[a.curve]) err(`${p.name}: ${R} has the curve "${a.curve}". The library has linear, squared, cubic and expo.`, w("curve"));
    if (!Number.isFinite(a.scale) || a.scale <= 0 || a.scale > 1) err(`${p.name}: ${R}'s scale is ${a.scale}. It is a share of top speed: above 0 and at most 100%.`, w("scale"));
    if (!Number.isFinite(a.slew) || a.slew < 0 || a.slew > 2) {
      err(`${p.name}: ${R}'s slew is ${a.slew} s. Use 0 (off) up to 2 seconds.`, w("slew"));
    } else if (a.slew > 0.5) {
      warn(`${p.name}: with a ${a.slew} s slew, ${R} keeps going for up to ${a.slew} s after the stick is let go.`, w("slew"));
    }
    if (a.slew > 0 && project && project.drivetrainSlew && DRIVE_ROLES.includes(a.role)) {
      warn(`${p.name}: ${project.drivetrainSlew} already limits the drivetrain's acceleration; ${R}'s ${a.slew} s slew stacks on top of it.`, w("slew"));
    }
  });
  for (const r of DRIVE_ROLES) {
    if (!roles.has(r)) warn(`${p.name}: no axis is set for ${ROLE[r].label.toLowerCase()}, so ${r}() always reads 0.`, at("sticks"));
  }

  // --- speed
  const s = p.speed;
  if (!Number.isFinite(s.max) || s.max <= 0 || s.max > 1) err(`${p.name}: top speed is ${pct(s.max)}. It must be above 0% and at most 100% of what the drivetrain can do.`, at("speed", { field: "max" }));
  if (!Number.isFinite(s.slow) || s.slow <= 0 || s.slow >= 1) err(`${p.name}: the slow multiplier is ${s.slow}. It multiplies top speed, so it must be between 0 and 1.`, at("speed", { field: "slow" }));
  const turboBound = p.bindings.some((b) => b.action.kind === "builtin" && b.action.id === "turbo");
  if (!Number.isFinite(s.turbo) || s.turbo < 1) {
    err(`${p.name}: the turbo multiplier is ${s.turbo}. Below 1, turbo would be slower than normal.`, at("speed", { field: "turbo" }));
  } else if (s.max * s.turbo > 1 + 1e-9) {
    warn(`${p.name}: turbo asks for ${pct(s.max * s.turbo)} of top speed. The drivetrain stops at 100%, so turbo does too.`, at("speed", { field: "turbo" }));
  } else if (turboBound && s.turbo === 1) {
    warn(`${p.name}: turbo is on a button but its multiplier is 1, so it does nothing.`, at("speed", { field: "turbo" }));
  }
  if (turboBound && s.max >= 1) warn(`${p.name}: turbo is on a button, but top speed is already 100%, so turbo cannot add anything.`, at("speed", { field: "max" }));

  // --- buttons
  const byInput = new Map();
  p.bindings.forEach((b, i) => {
    const w = at("buttons", { binding: i });
    const label = inputLabel(layout, b.input);
    const what = actionLabel(b.action);
    if (b.input.kind === "button") {
      const n = layout.buttons.length;
      if (!Number.isInteger(b.input.index) || b.input.index < 0 || b.input.index >= n) err(`${p.name}: a ${layout.label} has buttons 0 to ${n - 1}; there is no button ${b.input.index} for "${what}".`, w);
    } else if (b.input.kind === "pov") {
      if (!layout.pov) {
        const up = layout.buttons.indexOf("dup");
        const pad = up >= 0 ? `; its D-pad is buttons ${up} to ${layout.buttons.indexOf("dright")}, so bind those` : "";
        err(`${p.name}: a ${layout.label} reports no POV hat${pad}. "${what}" on ${label} would never fire.`, w);
      }
      else if (!POV_DIRECTIONS.includes(b.input.dir)) err(`${p.name}: "${b.input.dir}" is not a D-pad direction.`, w);
    } else if (b.input.kind === "axis") {
      if (!Number.isInteger(b.input.index) || b.input.index < 0 || b.input.index >= layout.axes.length) err(`${p.name}: ${label} does not exist on a ${layout.label}.`, w);
      if (!(b.input.threshold > 0 && b.input.threshold < 1)) err(`${p.name}: ${label} needs a threshold between 0 and 1.`, w);
      if (p.axes.some((a) => a.axis === b.input.index)) warn(`${p.name}: axis ${b.input.index} is a stick axis in this profile and also fires "${what}".`, w);
    }
    if (!WHEN[b.when]) err(`${p.name}: "${b.when}" is not a way a button can fire.`, w);
    if (b.action.kind === "builtin") {
      const bi = BUILTIN_ACTIONS[b.action.id];
      if (!bi) err(`${p.name}: "${b.action.id}" is not a Driver Config action.`, w);
      else if (!bi.when.includes(b.when)) {
        err(bi.needsDrive
          ? `${p.name}: ${bi.label} on ${label} must be "when pressed": it is a one-off reseed, not something to hold.`
          : `${p.name}: ${bi.label} on ${label} must be "while held" or "toggle on press". ${WHEN[b.when] ? `"${WHEN[b.when].label}"` : "That"} would leave it stuck on.`, w);
      } else if (bi.needsDrive && !(config.target.robotClass && config.target.swerveField)) {
        err(`${p.name}: ${bi.label} on ${label} needs the robot's SwerveSubsystem, and none is chosen. Pick the robot class at the top of the page.`, w);
      }
    } else if (refusal(b.action.expr)) {
      err(`${p.name}: ${label} runs ${b.action.expr}. ${refusal(b.action.expr)}`, w);
    } else if (!SAFE_ACTION.test(b.action.expr)) {
      err(`${p.name}: "${b.action.expr}" on ${label} is not an action Driver Config can generate.`, w);
    } else if (!config.target.robotClass) {
      err(`${p.name}: ${label} runs ${b.action.expr}, but no robot class is chosen, so "robot" means nothing. Pick the robot class at the top of the page.`, w);
    } else if (project && project.actionExprs && !project.actionExprs.has(b.action.expr)) {
      warn(`${p.name}: ${label} runs ${b.action.expr}, which was not found in ${config.target.robotClass || "the robot class"}. If it was renamed or removed, the build will fail.`, w);
    }
    const key = inputKey(b.input);
    if (byInput.has(key)) {
      err(`${p.name}: ${label} has two actions, "${actionLabel(byInput.get(key).action)}" and "${what}". A button should do one thing.`, w);
    } else {
      byInput.set(key, b);
    }
    for (const e of (project && project.existingBindings) || []) {
      if (e.port === p.controller.port && e.key === key) {
        warn(`${p.name}: ${e.file} binds ${label} too (line ${e.line}: ${e.text}). Take it out of ${e.file} when Driver Config takes over, or both will run.`, w);
      }
    }
  });

  // A controller in the project's own code whose named buttons assume a different layout: the
  // mistake that put X1's slow mode on the Create button.
  const family = (id) => (id === "dualsense" ? "gamepad" : id);
  for (const ctl of (project && project.controllers) || []) {
    if (ctl.port !== p.controller.port || family(ctl.layout) === family(layout.id) || !["xbox", "gamepad"].includes(ctl.layout)) continue;
    const named = [...new Map(((project && project.existingBindings) || [])
      .filter((e) => e.controller === ctl.name && e.method !== "button" && e.method !== "axisGreaterThan")
      .map((e) => [e.method, e])).values()];
    if (!named.length) continue;
    const say = named.slice(0, 6).map((e) => (e.input.kind === "pov" && !layout.pov
      ? `${e.method}() never fires, because this pad has no POV hat`
      : `${e.method}() is ${inputLabel(layout, e.input)}`));
    warn(`${p.name}: ${ctl.file} reads port ${ctl.port} through ${ctl.cls}, whose button names assume the ${ctl.layout === "xbox" ? "NI-DS Xbox" : "gamepad"} layout. On a ${layout.label} they land elsewhere: ${say.join("; ")}.`, at("buttons"));
  }

  // --- rumble
  let warnedUnmeasured = false;
  const check = (lay, who, w, what) => {
    if (lay.rumble === "no") err(`${p.name}: a ${lay.label} has no rumble motors, so "${what}" on the ${who}'s controller would do nothing.`, w);
    else if (lay.rumble === "unmeasured" && !warnedUnmeasured) {
      warnedUnmeasured = true;
      warn(`${p.name}: rumble through the 2027 Driver Station has not been measured on a ${lay.label}. The generated code asks the Driver Station when the controller connects and warns once if it cannot rumble.`, w);
    }
  };
  p.rumble.forEach((r, i) => {
    const w = at("rumble", { rule: i });
    const what = eventLabel(r.event, layout);
    if (!RUMBLE_PATTERNS[r.pattern]) err(`${p.name}: "${r.pattern}" is not a RumbleEvents pattern.`, w);
    if (!CHANNELS[r.channel]) err(`${p.name}: "${r.channel}" is not a rumble channel.`, w);
    if (r.channel === "DRIVER" || r.channel === "BOTH") check(layout, "driver", w, what);
    if (r.channel === "OPERATOR" || r.channel === "BOTH") {
      if (!config.operator) err(`${p.name}: "${what}" rumbles the operator, and no operator controller is set up. Add one above the rules, or rumble the driver.`, w);
      else { const ol = layoutOf(config, config.operator.type); if (ol) check(ol, "operator", w, what); }
    }
    const e = r.event;
    if (e.kind === "builtin") {
      if (!BUILTIN_EVENTS[e.id]) err(`${p.name}: "${e.id}" is not a Driver Config event.`, w);
    } else if (e.kind === "static") {
      const s = STATIC_EVENTS[e.id];
      if (!s) err(`${p.name}: "${e.id}" is not an event in Catalyst ${LIBRARY.version}.`, w);
      else if (s.param && !(Number.isFinite(e.param) && e.param >= s.param.min && e.param <= s.param.max)) {
        err(`${p.name}: "${s.label}" needs ${s.param.name} between ${s.param.min} and ${s.param.max}, not ${e.param}.`, w);
      }
    } else if (e.kind === "input") {
      const k = e.input.kind;
      const bad = (k === "button" && !(e.input.index >= 0 && e.input.index < layout.buttons.length))
        || (k === "pov" && !layout.pov)
        || (k === "axis" && !(e.input.index >= 0 && e.input.index < layout.axes.length));
      if (bad) err(`${p.name}: the rumble rule on ${inputLabel(layout, e.input)} names an input a ${layout.label} does not have.`, w);
    } else if (!SAFE_EVENT.test(e.expr)) {
      err(`${p.name}: "${e.expr}" is not an event Driver Config can generate.`, w);
    } else if (!config.target.robotClass) {
      err(`${p.name}: the rumble rule watches ${e.expr}, but no robot class is chosen, so "robot" means nothing.`, w);
    } else if (project && project.eventExprs && !project.eventExprs.has(e.expr)) {
      warn(`${p.name}: the rumble rule watches ${e.expr}, which was not found in the project. If it was renamed or removed, the build will fail.`, w);
    }
  });
  const theirs = project && project.rumbleEvents && project.rumbleEvents[0];
  if (theirs && p.rumble.length) {
    warn(`${p.name}: ${theirs.file} already makes its own RumbleEvents (line ${theirs.line}). Two of them driving one controller overwrite each other every loop, so one cuts the other's rumble short. Keep the rules in one place: move them here, or leave this profile's rumble empty.`, at("rumble"));
  }
}

export const errorsOf = (findings) => findings.filter((f) => f.level === "error");

// ------------------------------------------------------------------ what changed
//
// The config flattened to labelled facts, so two versions can be compared line by line and shown as
// Rev 1 beside Rev 2. Keys are stable across edits that do not change identity (a profile's name, an
// axis's role, a binding's input), so an edit reads as a change rather than a removal and an add.

export function describe(config) {
  const m = new Map();
  const put = (key, label, value) => m.set(key, { label, value: String(value) });
  const c = normalize(config);
  put("default", "Default profile", c.defaultProfile);
  put("operator", "Operator controller", c.operator ? `${(CONTROLLER_TYPES[c.operator.type] || {}).label || c.operator.type}, port ${c.operator.port}` : "none");
  put("target", "Generated class", `${c.target.package}.${c.target.className}` + (c.target.robotClass ? ` for ${c.target.robotClass}` : ""));
  put("classFile", "Writes the generated class", c.target.classFile ? "yes" : "no");
  put("constants", "Constants block", c.target.constants ? `${c.target.constants.className} in ${c.target.constants.path}` : "none");
  for (const [type] of Object.entries(c.maps)) {
    const lay = layoutOf(c, type);
    lay.axes.forEach((id, i) => put(`map:${type}:a${i}`, `${lay.label} · axis ${i}`, `${controlName(lay, id) || "not identified"}${lay.measuredAxes.has(i) ? " (measured)" : ""}`));
    lay.buttons.forEach((id, i) => put(`map:${type}:b${i}`, `${lay.label} · button ${i}`, `${controlName(lay, id) || "not identified"}${lay.measuredButtons.has(i) ? " (measured)" : ""}`));
  }
  for (const p of c.profiles) {
    const P = (k) => `p:${p.name}:${k}`;
    const lay = layoutOf(c, p.controller.type);
    put(P("controller"), `${p.name} · controller`, `${lay ? lay.label : p.controller.type}, port ${p.controller.port}`);
    for (const a of p.axes) {
      const R = `${p.name} · ${roleLabel(a.role)}`;
      put(P(`${a.role}:axis`), `${R} · axis`, lay && lay.axes[a.axis] ? `${a.axis} (${axisName(lay, a.axis)})` : a.axis);
      put(P(`${a.role}:invert`), `${R} · invert`, a.invert ? "inverted" : "not inverted");
      put(P(`${a.role}:deadband`), `${R} · deadband`, a.deadband);
      put(P(`${a.role}:curve`), `${R} · curve`, CURVES[a.curve] ? CURVES[a.curve].label : a.curve);
      put(P(`${a.role}:scale`), `${R} · scale`, pct(a.scale));
      put(P(`${a.role}:slew`), `${R} · slew`, a.slew > 0 ? `${a.slew} s` : "off");
    }
    put(P("max"), `${p.name} · top speed`, pct(p.speed.max));
    put(P("slow"), `${p.name} · slow multiplier`, `×${p.speed.slow}`);
    put(P("turbo"), `${p.name} · turbo multiplier`, `×${p.speed.turbo}`);
    for (const b of p.bindings) {
      put(P(`in:${inputKey(b.input)}`), `${p.name} · ${inputLabel(lay, b.input)}`, `${WHEN[b.when] ? WHEN[b.when].label : b.when}: ${actionLabel(b.action)}`);
    }
    p.rumble.forEach((r) => {
      const label = eventLabel(r.event, lay);
      put(P(`rumble:${label}:${r.channel}`), `${p.name} · rumble when ${label}`, `${RUMBLE_PATTERNS[r.pattern] ? RUMBLE_PATTERNS[r.pattern].label : r.pattern} → ${(CHANNELS[r.channel] || {}).label || r.channel}`);
    });
  }
  return m;
}

/** Facts that differ: `from` is null for something added, `to` is null for something removed. */
export function changes(before, after) {
  const a = describe(before);
  const b = describe(after);
  const out = [];
  for (const [key, v] of b) {
    const old = a.get(key);
    if (!old) out.push({ key, label: v.label, from: null, to: v.value });
    else if (old.value !== v.value) out.push({ key, label: v.label, from: old.value, to: v.value });
  }
  for (const [key, v] of a) if (!b.has(key)) out.push({ key, label: v.label, from: v.value, to: null });
  return out;
}
