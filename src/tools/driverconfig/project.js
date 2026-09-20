// Reading a robot project's Java for what a driver can bind: the robot class, the commands on it and
// on its subsystems, the events it exposes, and the buttons its own code already binds.
//
// This is a scanner, not a compiler. It strips comments and strings, walks braces, and reads member
// declarations - enough to list what is there, never enough to be the last word. That is why every
// action it offers is shown with the exact Java it becomes, and why a name it cannot find is a
// warning rather than a refusal: javac is the last word, and the build will say so.

import { LIBRARY_BOOLEANS, LIBRARY_COMMANDS, LIBRARY_PARENTS, LIBRARY_TRIGGERS, STICK_COMMANDS, humanize } from "./catalog.js";
import { inputKey } from "./model.js";

/** Comments, strings, text blocks and char literals blanked to spaces, line breaks kept. */
export function stripJava(src) {
  const s = String(src);
  let out = "";
  let i = 0;
  const n = s.length;
  const blank = (ch) => (ch === "\n" || ch === "\r" ? ch : " ");
  while (i < n) {
    const c = s[i];
    const d = s[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && s[i] !== "\n") { out += blank(s[i]); i++; }
    } else if (c === "/" && d === "*") {
      out += "  ";
      i += 2;
      while (i < n && !(s[i] === "*" && s[i + 1] === "/")) { out += blank(s[i]); i++; }
      if (i < n) { out += "  "; i += 2; }
    } else if (c === "\"" && s.startsWith("\"\"\"", i)) {
      out += "\"\"\"";
      i += 3;
      while (i < n && !s.startsWith("\"\"\"", i)) {
        if (s[i] === "\\" && i + 1 < n) { out += " " + blank(s[i + 1]); i += 2; continue; }
        out += blank(s[i]); i++;
      }
      if (i < n) { out += "\"\"\""; i += 3; }
    } else if (c === "\"" || c === "'") {
      out += c;
      i++;
      while (i < n && s[i] !== c && s[i] !== "\n") {
        if (s[i] === "\\" && i + 1 < n) { out += "  "; i += 2; continue; }
        out += " "; i++;
      }
      if (i < n && s[i] === c) { out += c; i++; }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Index of the brace that closes the one at `open`, in stripped text. */
function closeBrace(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}" && --depth === 0) return i;
  }
  return s.length - 1;
}

const MODS = /\b(public|protected|private|static|final|abstract|synchronized|native|transient|volatile|default|sealed|non-sealed|strictfp)\b/g;
const ANNOTATION = /@[\w.]+(\s*\((?:[^()]|\([^()]*\))*\))?/g;

/** "List<Foo>[]" -> "List"; "frc.lib.Foo" -> "Foo". */
export const baseType = (t) => String(t).replace(/<.*>/, "").replace(/\[\s*\]/g, "").trim().split(".").pop();

function parseMember(header, className) {
  const h = header.replace(ANNOTATION, " ").replace(/\s+/g, " ").trim();
  if (!h) return null;
  if (/\b(class|interface|enum|record)\s+[A-Za-z_$]/.test(h)) return { kind: "type" };
  const mods = new Set(h.match(MODS) || []);
  const rest = h.replace(MODS, " ").replace(/\s+/g, " ").trim();
  const visibility = mods.has("public") ? "public" : mods.has("protected") ? "protected" : mods.has("private") ? "private" : "package";
  const isStatic = mods.has("static");
  const eq = rest.indexOf("=");
  const paren = rest.indexOf("(");
  if (paren >= 0 && (eq < 0 || paren < eq)) {
    const m = /^(?:<[^>]*>\s*)?([\w.$]+(?:\s*<.*>)?(?:\s*\[\s*\])*)\s+([A-Za-z_$][\w$]*)\s*\((.*)\)\s*(?:throws\s+[\w.,\s]+)?$/.exec(rest);
    if (m) return { kind: "method", returns: baseType(m[1]), name: m[2], params: m[3].trim(), visibility, static: isStatic };
    const k = /^([A-Za-z_$][\w$]*)\s*\(/.exec(rest);
    return k && k[1] === className ? { kind: "constructor" } : null;
  }
  const decl = (eq >= 0 ? rest.slice(0, eq) : rest).trim();
  const m = /^([\w.$]+(?:\s*<.*>)?(?:\s*\[\s*\])*)\s+([A-Za-z_$][\w$]*)$/.exec(decl);
  if (!m) return null;
  return { kind: "field", type: m[1].replace(/\s+/g, ""), base: baseType(m[1]), name: m[2], visibility, static: isStatic,
    init: eq >= 0 ? rest.slice(eq + 1).trim() : "" };
}

function parseBody(s, from, to, className) {
  const members = [];
  let start = from;
  let paren = 0;
  let i = from;
  while (i < to) {
    const ch = s[i];
    if (ch === "(") paren++;
    else if (ch === ")") paren = Math.max(0, paren - 1);
    else if (ch === ";" && paren === 0) {
      const m = parseMember(s.slice(start, i), className);
      if (m) members.push(m);
      start = i + 1;
    } else if (ch === "{") {
      const header = s.slice(start, i);
      const end = closeBrace(s, i);
      if (paren > 0 || header.includes("=")) {
        i = end + 1; // part of an initializer: a lambda, an anonymous class, an array
        continue;
      }
      const m = parseMember(header, className);
      if (m) members.push(m);
      i = end + 1;
      start = i;
      continue;
    }
    i++;
  }
  return members;
}

/** The top-level types in one file, with their fields and methods. */
export function parseJavaFile(path, src) {
  const s = stripJava(src);
  const pkg = (s.match(/\bpackage\s+([\w.]+)\s*;/) || [])[1] || "";
  const types = [];
  const re = /\b(class|interface|enum|record)\s+([A-Za-z_$][\w$]*)/g;
  let m;
  let depthAt = 0;
  let scanned = 0;
  while ((m = re.exec(s))) {
    for (; scanned < m.index; scanned++) {
      if (s[scanned] === "{") depthAt++;
      else if (s[scanned] === "}") depthAt--;
    }
    if (depthAt !== 0) continue;
    const open = s.indexOf("{", m.index);
    if (open < 0) break;
    const header = s.slice(m.index, open);
    const ext = /\bextends\s+([\w.$]+)/.exec(header);
    const close = closeBrace(s, open);
    const members = parseBody(s, open + 1, close, m[2]);
    types.push({
      name: m[2], kind: m[1], pkg, path, extends: ext ? baseType(ext[1]) : null,
      fields: members.filter((x) => x.kind === "field"),
      methods: members.filter((x) => x.kind === "method"),
    });
    re.lastIndex = close;
    for (; scanned < close; scanned++) {
      if (s[scanned] === "{") depthAt++;
      else if (s[scanned] === "}") depthAt--;
    }
  }
  return { path, pkg, types, stripped: s };
}

// ------------------------------------------------------------------ controllers and their buttons

/** The command-based controller classes in WPILib 2027, and the layout their named buttons use. */
const CONTROLLER_CLASSES = {
  CommandNiDsXboxController: "xbox", CommandGamepad: "gamepad", CommandJoystick: "joystick",
  CommandGenericHID: "generic", CommandNiDsStadiaController: "generic",
  // Not in alpha-6 or alpha-7, but in WPILib's development builds; recognised so a newer project scans.
  CommandXboxController: "xbox", CommandPS5Controller: "dualsense", CommandPS4Controller: "dualsense",
};

// Named triggers -> raw inputs, from the enum values in WPILib 2027.0.0-alpha-6.
const NAMED = {
  xbox: {
    a: 0, b: 1, x: 2, y: 3, leftBumper: 4, rightBumper: 5, back: 6, start: 7, leftStick: 8, rightStick: 9,
    leftTrigger: { axis: 2 }, rightTrigger: { axis: 3 },
  },
  gamepad: {
    southFace: 0, eastFace: 1, westFace: 2, northFace: 3, back: 4, guide: 5, start: 6, leftStick: 7,
    rightStick: 8, leftBumper: 9, rightBumper: 10, dpadUp: 11, dpadDown: 12, dpadLeft: 13, dpadRight: 14,
    misc1: 15, rightPaddle1: 16, leftPaddle1: 17, rightPaddle2: 18, leftPaddle2: 19,
    leftTrigger: { axis: 4 }, rightTrigger: { axis: 5 },
  },
};
const POV_NAMED = { povUp: "UP", povUpRight: "UP_RIGHT", povRight: "RIGHT", povDownRight: "DOWN_RIGHT",
  povDown: "DOWN", povDownLeft: "DOWN_LEFT", povLeft: "LEFT", povUpLeft: "UP_LEFT" };

/**
 * An int the code spells as a literal or a constant. For a constant, its initializer's last integer
 * is taken - which reads both `= 7` and X1's `storedInt("BTN_L2", 7)` - and the answer says when it
 * was a fallback a robot may have overridden at runtime.
 */
function resolveInt(expr, files) {
  const e = String(expr).trim();
  if (/^\d+$/.test(e)) return { value: Number(e), how: "literal" };
  const name = (e.match(/([A-Za-z_$][\w$]*)\s*$/) || [])[1];
  if (!name) return null;
  for (const f of files) {
    const m = new RegExp(`\\b${name}\\s*=\\s*([^;]*);`).exec(f.stripped);
    if (!m) continue;
    const ints = m[1].match(/\b\d+\b/g);
    if (!ints) continue;
    const plain = /^\s*\d+\s*$/.test(m[1]);
    return { value: Number(ints[ints.length - 1]), how: plain ? "constant" : "fallback", from: f.path.split("/").pop() };
  }
  return null;
}

function findControllers(files) {
  const out = [];
  const re = /\b(Command\w+)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+(Command\w+)\s*\(([^;]*?)\)\s*;/g;
  for (const f of files) {
    let m;
    while ((m = re.exec(f.stripped))) {
      const layout = CONTROLLER_CLASSES[m[3]];
      if (!layout) continue;
      const port = resolveInt(m[4].split(",").pop(), files);
      out.push({ file: f.path.split("/").pop(), name: m[2], cls: m[3], layout, port: port ? port.value : null });
    }
  }
  return out;
}

function closeParen(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")" && --depth === 0) return i;
  }
  return s.length - 1;
}

/** Every `controller.something(...).whileTrue(...)`-shaped binding the project's own code makes. */
function findBindings(files, controllers) {
  const out = [];
  for (const c of controllers) {
    const re = new RegExp(`\\b${c.name}\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\s*\\(`, "g");
    for (const f of files) {
      const s = f.stripped;
      let m;
      while ((m = re.exec(s))) {
        const argOpen = m.index + m[0].length - 1;
        const argClose = closeParen(s, argOpen);
        const args = s.slice(argOpen + 1, argClose).trim();
        // Allow one .and(...)/.or(...) between the trigger and the binding.
        let k = argClose + 1;
        const tail = /^\s*\.\s*(and|or|negate)\s*\(/.exec(s.slice(k, k + 40));
        if (tail) k = closeParen(s, k + tail[0].length - 1) + 1;
        const b = /^\s*\.\s*(onTrue|onFalse|whileTrue|whileFalse|toggleOnTrue|toggleOnFalse)\s*\(/.exec(s.slice(k, k + 40));
        if (!b) continue;
        const cmdOpen = k + b[0].length - 1;
        const cmdClose = closeParen(s, cmdOpen);
        const input = inputFor(c.layout, m[1], args, files);
        if (!input) continue;
        const src = f.src;
        out.push({
          file: f.path.split("/").pop(),
          line: src.slice(0, m.index).split("\n").length,
          controller: c.name,
          port: c.port,
          method: m[1],
          input,
          key: inputKey(input),
          when: b[1],
          command: src.slice(cmdOpen + 1, cmdClose).replace(/\s+/g, " ").trim(),
          text: `${c.name}.${m[1]}(${src.slice(argOpen + 1, argClose).replace(/\s+/g, " ").trim()})`,
          resolved: input.how || "literal",
        });
      }
    }
  }
  return out;
}

function inputFor(layout, method, args, files) {
  if (method === "button") {
    const r = resolveInt(args, files);
    return r ? { kind: "button", index: r.value, how: r.how, from: r.from } : null;
  }
  if (POV_NAMED[method]) return { kind: "pov", dir: POV_NAMED[method] };
  if (method === "axisGreaterThan") {
    const [i, t] = args.split(",").map((x) => x.trim());
    const r = resolveInt(i, files);
    return r && Number.isFinite(Number(t)) ? { kind: "axis", index: r.value, threshold: Number(t) } : null;
  }
  const named = NAMED[layout] && NAMED[layout][method];
  if (named === undefined) return null;
  if (typeof named === "number") return { kind: "button", index: named };
  return { kind: "axis", index: named.axis, threshold: 0.5 };
}

// ------------------------------------------------------------------ what the robot offers

const COMMAND_TYPES = new Set(["CatalystCommand", "Command"]);

function guessWhen(name) {
  if (/^(reset|zero|toggle|stop|clear|run|start|set|calibrate|record|replay|mark|save)/i.test(name)) return "onTrue";
  return "whileTrue";
}

/** The library class a type is or extends, walking project classes first. */
function libraryChain(typeName, classes) {
  const chain = [];
  const seen = new Set();
  let t = typeName;
  while (t && !seen.has(t)) {
    seen.add(t);
    if (t in LIBRARY_PARENTS || LIBRARY_COMMANDS[t] || LIBRARY_TRIGGERS[t] || LIBRARY_BOOLEANS[t]) {
      for (let lib = t; lib; lib = LIBRARY_PARENTS[lib]) chain.push(lib);
      break;
    }
    const cls = classes.get(t);
    t = cls ? cls.extends : null;
  }
  return chain;
}

/** A project class and the project classes it extends, nearest first. */
function projectChain(typeName, classes) {
  const out = [];
  const seen = new Set();
  for (let t = typeName; t && classes.has(t) && !seen.has(t); t = classes.get(t).extends) {
    seen.add(t);
    out.push(classes.get(t));
  }
  return out;
}

/**
 * Scan a project.
 *
 * @param sources [{ path, text }] - the project's Java, paths relative to the root
 * @param options.robotClass the class to treat as the robot, when the user has chosen one
 * @param options.className the generated class's name, to find it and to see whether it is wired in
 */
export function scanProject(sources, options = {}) {
  const className = options.className || "DriverConfig";
  const files = sources
    .filter((s) => /\.java$/.test(s.path))
    .map((s) => ({ ...parseJavaFile(s.path.replace(/\\/g, "/"), s.text), src: s.text }));
  const classes = new Map();
  for (const f of files) for (const t of f.types) if (!classes.has(t.name)) classes.set(t.name, t);

  // The generated file is Driver Config's own; its controllers and bindings are not "the project's".
  const marker = "// >>> CATALYST DRIVER CONFIG: BODY";
  const own = files.filter((f) => !f.src.includes(marker));
  const controllers = findControllers(own);
  const existingBindings = findBindings(own, controllers)
    .map((b) => ({ ...b, feedback: /rumble\s*\.\s*fire\s*\(|RumbleEvents/.test(b.command) }));
  // A RumbleEvents of the project's own: two of them on one controller overwrite each other.
  const rumbleEvents = [];
  for (const f of own) {
    const re = /\bnew\s+RumbleEvents\s*\(/g;
    let m;
    while ((m = re.exec(f.stripped))) rumbleEvents.push({ file: f.path.split("/").pop(), line: f.src.slice(0, m.index).split("\n").length });
  }

  // Which class is the robot: the one a static field news up, that holds the drivetrain and the
  // controller, and offers commands. Ties go to the first found; the page lets a person choose.
  const candidates = [];
  for (const t of classes.values()) {
    if (t.kind !== "class" || t.name === className) continue;
    let score = 0;
    for (const fld of t.fields) {
      if (fld.static) continue;
      if (libraryChain(fld.base, classes).includes("SwerveSubsystem")) score += 3;
      if (CONTROLLER_CLASSES[fld.base]) score += 3;
      if (libraryChain(fld.base, classes).length) score += 1;
    }
    score += t.methods.filter((m) => !m.static && !m.params && COMMAND_TYPES.has(m.returns)).length;
    const newed = new RegExp(`\\bstatic\\s+(?:final\\s+)?${t.name}\\s+[A-Za-z_$][\\w$]*\\s*=\\s*new\\s+${t.name}\\s*\\(`);
    if (files.some((f) => newed.test(f.stripped))) score += 5;
    if (score > 0) candidates.push({ name: t.name, pkg: t.pkg, path: t.path, score });
  }
  candidates.sort((a, b) => b.score - a.score);
  const robot = (options.robotClass && classes.get(options.robotClass)) || (candidates[0] ? classes.get(candidates[0].name) : null);

  const actions = [];
  const events = [];
  let swerveField = null;
  if (robot) {
    const pkg = robot.pkg;
    const reachable = (member, owner) => member.visibility === "public" || (owner.pkg === pkg && member.visibility !== "private");
    const addAction = (expr, label, group, when) => { if (!actions.some((a) => a.expr === expr)) actions.push({ expr, label, group, when }); };
    const addEvent = (expr, label, group) => { if (!events.some((e) => e.expr === expr)) events.push({ expr, label, group }); };
    const fromClass = (owner, prefix, group) => {
      for (const m of owner.methods) {
        if (m.static || m.params || !reachable(m, owner)) continue;
        if (COMMAND_TYPES.has(m.returns)) addAction(`${prefix}.${m.name}()`, humanize(m.name), group, guessWhen(m.name));
        else if (m.returns === "Trigger") addEvent(`${prefix}.${m.name}()`, humanize(m.name), group);
        else if (m.returns === "boolean") addEvent(`new Trigger(${prefix}::${m.name})`, humanize(m.name), group);
      }
    };
    for (const c of projectChain(robot.name, classes)) fromClass(c, "robot", robot.name);
    for (const owner of projectChain(robot.name, classes)) {
      for (const fld of owner.fields) {
        if (fld.static || !reachable(fld, owner)) continue;
        const group = `${robot.name}.${fld.name} · ${fld.base}`;
        const prefix = `robot.${fld.name}`;
        for (const c of projectChain(fld.base, classes)) fromClass(c, prefix, group);
        const lib = libraryChain(fld.base, classes);
        for (const l of lib) {
          for (const [name, v] of Object.entries(LIBRARY_COMMANDS[l] || {})) {
            addAction(`${prefix}.${name}()`, typeof v === "string" ? v : v.label, group, typeof v === "string" ? guessWhen(name) : v.when);
          }
          for (const [name, label] of Object.entries(LIBRARY_TRIGGERS[l] || {})) addEvent(`${prefix}.${name}()`, label, group);
          for (const [name, label] of Object.entries(LIBRARY_BOOLEANS[l] || {})) addEvent(`new Trigger(${prefix}::${name})`, label, group);
        }
        if (lib.includes("SwerveSubsystem")) {
          if (!swerveField) swerveField = fld.name;
          for (const [name, v] of Object.entries(STICK_COMMANDS)) addAction(`${prefix}.${name}(${v.args})`, v.label, group, "whileTrue");
        }
      }
    }
  }

  const slew = files.find((f) => /\.enableSlewRateLimiting\s*\(/.test(f.stripped));
  const generated = files.filter((f) => f.src.includes(marker)).map((f) => f.path);
  const wordRe = new RegExp(`\\b${className}\\b`);
  const wiredIn = files.filter((f) => !f.src.includes(marker) && wordRe.test(f.stripped)).map((f) => f.path);

  return {
    files: files.length,
    classes: classes.size,
    robot: robot ? { name: robot.name, pkg: robot.pkg, path: robot.path } : null,
    candidates,
    actions,
    events,
    actionExprs: new Set(actions.map((a) => a.expr)),
    eventExprs: new Set(events.map((e) => e.expr)),
    controllers,
    existingBindings,
    rumbleEvents,
    constantsBlocks: findConstantsBlocks(files),
    drivetrainSlew: slew ? slew.path.split("/").pop() : null,
    swerveField,
    generated,
    wiredIn,
  };
}

/**
 * The project's own bindings as Driver Config bindings, where they are a single call on something
 * the scan found - the rest are listed as staying in the project's code, not guessed at.
 */
export function bindingsFromCode(scan) {
  const kept = [];
  const imported = [];
  for (const b of scan.existingBindings) {
    const cmd = b.command.replace(/\s+/g, "");
    let action = null;
    if (/^Commands\.startEnd\(.*slow/i.test(cmd)) action = { kind: "builtin", id: "slow" };
    else if (scan.swerveField && cmd === `${scan.swerveField}.resetHeading()`) action = { kind: "builtin", id: "reseed" };
    else if (/^Commands\.startEnd\(.*turbo/i.test(cmd)) action = { kind: "builtin", id: "turbo" };
    else {
      const expr = `robot.${cmd}`;
      const found = scan.actions.find((a) => a.expr === expr);
      if (found) action = { kind: "command", expr, label: found.label };
    }
    const when = { onTrue: "onTrue", whileTrue: "whileTrue", toggleOnTrue: "toggleOnTrue", onFalse: "onFalse" }[b.when];
    if (action && when && !imported.some((x) => inputKey(x.input) === b.key)) {
      imported.push({ input: stripHow(b.input), when, action });
    } else {
      kept.push(b);
    }
  }
  return { imported, kept };
}

function stripHow(input) {
  const { how, from, ...rest } = input;
  return rest;
}

const FEEL = ["DEADBAND", "MAX_SPEED", "DEFAULT_CURVE"];

/**
 * Classes that hold driver-feel constants - X1Constants.Driving is the shape: DEADBAND, MAX_SPEED,
 * DEFAULT_CURVE - with the constant names the rest of the project reads from each, because a
 * generated block that drops one of those breaks the build.
 */
export function findConstantsBlocks(files) {
  const out = [];
  const marker = "// >>> CATALYST DRIVER CONFIG: CONSTANTS";
  for (const f of files) {
    const s = f.stripped;
    const re = /\bclass\s+([A-Za-z_$][\w$]*)[^{;]*\{/g;
    let m;
    while ((m = re.exec(s))) {
      const open = m.index + m[0].length - 1;
      let body = s.slice(open + 1, closeBrace(s, open));
      let prev;
      do { prev = body; body = body.replace(/\{[^{}]*\}/g, " "); } while (body !== prev);
      const names = [...body.matchAll(/\bstatic\s+final\s+[\w.$<>[\], ]+?\s+([A-Z_][A-Z0-9_]*)\s*=/g)].map((x) => x[1]);
      if (!names.some((n) => FEEL.includes(n))) continue;
      const refRe = new RegExp(`\\b${m[1]}\\s*\\.\\s*([A-Z_][A-Z0-9_]*)\\b`, "g");
      const refs = new Set();
      for (const g of files) for (const x of g.stripped.matchAll(refRe)) refs.add(x[1]);
      out.push({ path: f.path, className: m[1], names, refs: [...refs].sort(), marked: f.src.includes(marker),
        line: f.src.slice(0, m.index).split("\n").length });
    }
  }
  return out;
}

/**
 * Buttons the project's own code puts two different things on. Rumble feedback on a button that
 * also runs a command is deliberate, so it is not counted.
 */
export function codeCollisions(scan) {
  const groups = new Map();
  for (const b of scan.existingBindings) {
    if (b.feedback) continue;
    const k = `${b.port}:${b.key}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(b);
  }
  return [...groups.values()].filter((list) => new Set(list.map((b) => b.command)).size > 1);
}
