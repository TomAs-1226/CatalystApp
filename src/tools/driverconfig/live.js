// The live controller: what a pad plugged into this computer is doing, translated into the numbers
// the robot will see, and then shaped the way the robot will shape them.
//
// The browser and the Driver Station number the same pad differently. The browser's "standard"
// mapping puts the left stick on axes 0 and 1 and the bottom face button on 0; the 2027 Driver
// Station puts a DualSense's L1 on 9. So nothing here shows a browser index as if it were the
// robot's: every value is looked up through the profile's controller map, and the raw browser view
// is labelled as the browser's.

import { CONTROLS, RUMBLE_PATTERNS } from "./catalog.js";
import { DRIVE_ROLES, axisName, buttonName, capsFor, modeOf, roleLabel, shape, slewStep } from "./model.js";

let chosen = null;

/** The first connected pad, as plain data, or null. */
export function snapshot() {
  let pads = [];
  try { pads = (navigator.getGamepads ? [...navigator.getGamepads()] : []).filter(Boolean); } catch { pads = []; }
  if (!pads.length) return null;
  const gp = pads.find((p) => p.index === chosen) || pads[0];
  return {
    gp,
    id: gp.id,
    count: pads.length,
    standard: gp.mapping === "standard",
    axes: [...gp.axes],
    buttons: gp.buttons.map((b) => ({ pressed: b.pressed, value: b.value })),
  };
}

const raw = (layout, snap) => layout.browserRaw || !snap.standard;

/** Robot axis `index` on this layout, read from the browser: { value, via } or null. */
export function robotAxis(snap, layout, index) {
  if (!snap) return null;
  if (raw(layout, snap)) {
    const v = snap.axes[index];
    return v === undefined ? null : { value: v, via: `raw browser axis ${index}` };
  }
  const c = CONTROLS[layout.axes[index]];
  if (!c || !c.std) return null;
  if (c.std.axis !== undefined) return { value: snap.axes[c.std.axis] || 0, via: `browser axis ${c.std.axis}` };
  const b = snap.buttons[c.std.button];
  return b ? { value: b.value, via: `browser button ${c.std.button}` } : null;
}

/** Robot button `index` on this layout: true, false, or null when the browser cannot see it. */
export function robotButton(snap, layout, index) {
  if (!snap) return null;
  if (raw(layout, snap)) {
    const b = snap.buttons[index];
    return b ? b.pressed : null;
  }
  const c = CONTROLS[layout.buttons[index]];
  if (!c || !c.std || c.std.button === undefined) return null;
  const b = snap.buttons[c.std.button];
  return b ? b.pressed : null;
}

export function inputIsDown(snap, layout, input) {
  if (!snap || !input) return false;
  if (input.kind === "button") return robotButton(snap, layout, input.index) === true;
  if (input.kind === "axis") {
    const a = robotAxis(snap, layout, input.index);
    return !!a && a.value > input.threshold;
  }
  if (input.kind === "pov" && snap.standard) {
    const [u, d, l, r] = [12, 13, 14, 15].map((i) => !!(snap.buttons[i] && snap.buttons[i].pressed));
    const dirs = { UP: u && !l && !r, DOWN: d && !l && !r, LEFT: l && !u && !d, RIGHT: r && !u && !d,
      UP_RIGHT: u && r, UP_LEFT: u && l, DOWN_RIGHT: d && r, DOWN_LEFT: d && l };
    return !!dirs[input.dir];
  }
  return false;
}

/** Which robot button a browser button is, on this layout, for "press the button you want". */
export function robotButtonFor(snap, layout, browserButton) {
  if (raw(layout, snap)) return browserButton < layout.buttons.length ? browserButton : null;
  const i = layout.buttons.findIndex((id) => id && CONTROLS[id] && CONTROLS[id].std && CONTROLS[id].std.button === browserButton);
  return i >= 0 ? i : null;
}

/** The standard-mapping name of a browser control, for the raw view. */
function browserName(kind, i, standard) {
  if (!standard) return "";
  const id = Object.keys(CONTROLS).find((k) => {
    const s = CONTROLS[k].std;
    return s && (kind === "axis" ? s.axis === i : s.button === i && CONTROLS[k].kind === "button");
  });
  return id ? CONTROLS[id].label : "";
}

// ------------------------------------------------------------------ drawing

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
const pctText = (v) => `${v < 0 ? "-" : ""}${Math.round(Math.abs(v) * 100)}%`;

/** A bipolar meter for a value in [-1, 1]. */
function meterStyle(v) {
  const c = Math.max(-1, Math.min(1, v || 0));
  const left = c < 0 ? 50 + c * 50 : 50;
  return `left:${left}%;width:${Math.abs(c) * 50}%`;
}

/**
 * The response of one axis as a drawing: stick travel across, what the robot gets up. The mode in
 * force is a continuous line; the modes a button would switch to are phantom dashes, because they
 * ship but are not engaged. The deadband is hatched, because the stick moves there and nothing does.
 */
export function curveSvg(axis, speed) {
  const W = 280, H = 200, L = 34, B = 28, T = 10, R = 10;
  const x = (u) => L + u * (W - L - R);
  const y = (v) => H - B - v * (H - B - T);
  const flat = { ...axis, invert: false };
  const line = (mode) => {
    const pts = [];
    for (let k = 0; k <= 120; k++) {
      const u = k / 120;
      pts.push(`${x(u).toFixed(1)},${y(Math.abs(shape(u, flat, speed, mode).value)).toFixed(1)}`);
    }
    return pts.join(" ");
  };
  const isDrive = DRIVE_ROLES.includes(axis.role);
  const caps = capsFor(axis, speed, isDrive);
  const grid = [0.25, 0.5, 0.75, 1].map((g) =>
    `<line x1="${x(0)}" y1="${y(g)}" x2="${x(1)}" y2="${y(g)}" style="stroke:var(--cat-hair)"/>` +
    `<line x1="${x(g)}" y1="${y(0)}" x2="${x(g)}" y2="${y(1)}" style="stroke:var(--cat-hair)"/>`).join("");
  const db = Math.max(0, Math.min(1, axis.deadband || 0));
  const phantom = (mode, label) => `<polyline points="${line(mode)}" fill="none" style="stroke:var(--cat-muted);stroke-width:1.2;stroke-dasharray:5 4"/>` +
    `<text x="${x(1) - 2}" y="${y(Math.abs(shape(1, flat, speed, mode).value)) - 4}" text-anchor="end" class="svg-t">${label}</text>`;
  return `<svg class="plot" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(roleLabel(axis.role))} response curve">
    <defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <line x1="0" y1="0" x2="0" y2="6" style="stroke:var(--cat-hair-str);stroke-width:2"/></pattern></defs>
    <style>.svg-t{font:9.5px var(--cat-mono);fill:var(--cat-muted);letter-spacing:.06em}</style>
    ${grid}
    <rect x="${x(0)}" y="${y(1)}" width="${x(db) - x(0)}" height="${y(0) - y(1)}" fill="url(#hatch)"/>
    <line x1="${x(0)}" y1="${y(0)}" x2="${x(1)}" y2="${y(0)}" style="stroke:var(--cat-hair-str)"/>
    <line x1="${x(0)}" y1="${y(0)}" x2="${x(0)}" y2="${y(1)}" style="stroke:var(--cat-hair-str)"/>
    ${isDrive && speed.slow < 1 ? phantom("slow", "SLOW") : ""}
    ${isDrive && caps.turbo > caps.normal + 1e-9 ? phantom("turbo", "TURBO") : ""}
    <polyline points="${line("normal")}" fill="none" style="stroke:var(--cat-white);stroke-width:1.8"/>
    <circle id="curveDot" r="4" cx="${x(0)}" cy="${y(0)}" style="fill:var(--cat-coral)"/>
    <text x="${x(0)}" y="${H - 10}" class="svg-t">0</text>
    <text x="${x(1)}" y="${H - 10}" text-anchor="end" class="svg-t">FULL STICK</text>
    <text x="${x(db) + 3}" y="${y(0) - 6}" class="svg-t">${db > 0.02 ? `DEADBAND ${db}` : ""}</text>
    <text x="4" y="${y(1) + 4}" class="svg-t">100%</text>
    <text x="4" y="${y(0.5) + 4}" class="svg-t">50%</text>
  </svg>`;
}

/** Where the dot goes for a raw value, in the same frame as curveSvg. */
function dotAt(u, v) {
  const W = 280, H = 200, L = 34, B = 28, T = 10, R = 10;
  return { cx: L + Math.min(1, Math.abs(u)) * (W - L - R), cy: H - B - Math.min(1, Math.abs(v)) * (H - B - T) };
}

/** A pattern's strength over time, drawn to scale: 0.4 s across. */
export function patternStrip(pattern) {
  const p = RUMBLE_PATTERNS[pattern];
  if (!p) return "";
  const W = 96, H = 14, sx = W / 0.4;
  const shapes = p.ramp
    ? `<polygon points="0,${H} ${0.3 * sx},0 ${0.3 * sx},${H}" style="fill:var(--cat-white)"/>`
    : p.segments.map(([a, b]) => `<rect x="${a * sx}" y="0" width="${(b - a) * sx}" height="${H}" style="fill:var(--cat-white)"/>`).join("");
  return `<svg class="strip" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-label="${esc(p.label)}, ${p.ms} ms">
    <rect x="0" y="${H - 1}" width="${W}" height="1" style="fill:var(--cat-hair-str)"/>${shapes}</svg>`;
}

/** Play a pattern on the pad plugged into this computer, when the browser can. */
export function playPattern(pattern) {
  const snap = snapshot();
  const act = snap && snap.gp && snap.gp.vibrationActuator;
  const p = RUMBLE_PATTERNS[pattern];
  if (!act || typeof act.playEffect !== "function" || !p) return false;
  const play = (delayS, ms, s) => setTimeout(() => {
    try { act.playEffect("dual-rumble", { startDelay: 0, duration: ms, strongMagnitude: s, weakMagnitude: s }); } catch { /* unplugged */ }
  }, delayS * 1000);
  if (p.ramp) for (let k = 0; k < 10; k++) play(k * 0.03, 30, (k + 1) / 10);
  else for (const [a, b, s] of p.segments) play(a, Math.round((b - a) * 1000), s);
  return true;
}

// ------------------------------------------------------------------ the loop

/**
 * Start the live panel. `get()` returns { profile, layout, speed-bearing profile, bindings } for the
 * profile on screen; `hooks.onButton(robotIndex)` is told about new presses while listening.
 */
export function startLive(root, get, hooks = {}) {
  const slew = new Map();
  const toggles = new Map();
  let prevDown = new Set();
  let prevBrowser = [];
  let lastT = performance.now();
  let built = "";

  const build = (ctx, snap) => {
    const key = JSON.stringify([ctx.profile.name, ctx.profile.axes, ctx.layout.id, ctx.layout.axes, !!snap, snap && snap.id, snap && snap.axes.length, snap && snap.buttons.length]);
    if (key === built) return;
    built = key;
    const p = ctx.profile;
    const lay = ctx.layout;
    const rows = p.axes.map((a, i) => `<div class="live-row">
        <span class="who" title="${esc(roleLabel(a.role))} reads robot axis ${a.axis}">${esc(roleLabel(a.role))} <span class="mono muted">axis ${a.axis}${axisName(lay, a.axis) ? ` · ${esc(axisName(lay, a.axis))}` : ""}</span></span>
        <div class="meter"><span class="mid"></span><i data-lv-out="${i}" style="left:50%;width:0"></i></div>
        <span class="v" data-lv-outv="${i}">0%</span></div>`).join("");
    const rawAxes = snap ? snap.axes.map((_, k) => {
      const robot = lay.browserRaw || !snap.standard ? k : lay.axes.findIndex((id) => id && CONTROLS[id] && CONTROLS[id].std && CONTROLS[id].std.axis === k);
      return `<div class="live-row"><span class="who mono">B-axis ${k}${browserName("axis", k, snap.standard) ? ` · ${esc(browserName("axis", k, snap.standard))}` : ""}
        <span class="muted">${robot >= 0 ? `= robot axis ${robot}` : "= no robot axis"}</span></span>
        <div class="meter"><span class="mid"></span><i data-lv-raw="${k}" style="left:50%;width:0"></i></div><span class="v" data-lv-rawv="${k}">0.00</span></div>`;
    }).join("") : "";
    const rawButtons = snap ? snap.buttons.map((_, k) => {
      const robot = robotButtonFor(snap, lay, k);
      return `<span class="pb" data-lv-btn="${k}" title="browser button ${k}${browserName("button", k, snap.standard) ? `, ${browserName("button", k, snap.standard)}` : ""}: ${robot === null ? "no robot button on this layout" : `robot button ${robot}${buttonName(lay, robot) ? ` (${buttonName(lay, robot)})` : ""}`}">${robot === null ? `B${k}` : `B${k}&rarr;${robot}`}</span>`;
    }).join("") : "";
    root.innerHTML = `
      <div class="side-h"><span class="lbl">Live controller</span><span class="cap" data-lv-status></span></div>
      ${snap ? `<div class="cap" style="overflow-wrap:anywhere">${esc(snap.id)}${snap.count > 1 ? ` (1 of ${snap.count})` : ""} ·
        ${snap.standard ? "standard browser mapping" : "no standard mapping: raw browser indices, not checked against the robot"}</div>`
        : `<p class="small muted" style="margin:4px 0 0">No controller seen. Plug one into this computer and press any button: browsers only report a pad after it is touched.</p>`}
      <div class="lbl" style="margin-top:12px">What the robot receives</div>
      <div class="mode" data-lv-mode></div>
      ${rows}
      <p class="cap" style="margin-top:6px">Through the ${esc(lay.label)} map on the Controller tab. If a stick moves the wrong row, the map is wrong, not the robot.</p>
      ${snap ? `<div class="lbl" style="margin-top:12px">Raw, as this computer numbers it</div>
        ${rawAxes}
        <div class="btn-grid">${rawButtons}</div>
        <p class="cap" style="margin-top:6px">B-axis and B are the browser's numbers. The robot's are after the arrow: robot buttons count from 0, the n in button(n).</p>` : ""}`;
  };

  const frame = (t) => {
    const ctx = get();
    const snap = snapshot();
    if (ctx && ctx.profile) {
      build(ctx, snap);
      const p = ctx.profile;
      const lay = ctx.layout;
      const dt = Math.min(0.1, (t - lastT) / 1000);
      lastT = t;

      // Speed mode, from the pad's own buttons, the way the robot decides it.
      const down = new Set();
      p.bindings.forEach((b, i) => { if (inputIsDown(snap, lay, b.input)) down.add(i); });
      let slowHeld = false;
      let turboHeld = false;
      p.bindings.forEach((b, i) => {
        if (b.action.kind !== "builtin" || (b.action.id !== "slow" && b.action.id !== "turbo")) return;
        let on = false;
        if (b.when === "whileTrue") on = down.has(i);
        else if (b.when === "toggleOnTrue") {
          const k = `${p.name}:${i}`;
          if (down.has(i) && !prevDown.has(i)) toggles.set(k, !toggles.get(k));
          on = !!toggles.get(k);
        }
        if (b.action.id === "slow") slowHeld = slowHeld || on;
        else turboHeld = turboHeld || on;
      });
      prevDown = down;
      const mode = modeOf(slowHeld, turboHeld);

      const outs = p.axes.map((a, i) => {
        const r = robotAxis(snap, lay, a.axis);
        const s = shape(r ? r.value : 0, a, p.speed, DRIVE_ROLES.includes(a.role) ? mode : "normal");
        const k = `${p.name}:${a.role}`;
        const v = slewStep(slew.get(k) || 0, s.value, a.slew, dt);
        slew.set(k, v);
        return { i, r, s, v };
      });
      for (const o of outs) {
        const bar = root.querySelector(`[data-lv-out="${o.i}"]`);
        const val = root.querySelector(`[data-lv-outv="${o.i}"]`);
        if (bar) bar.setAttribute("style", meterStyle(o.v));
        if (val) val.textContent = pctText(o.v);
      }
      const m = root.querySelector("[data-lv-mode]");
      if (m) {
        m.innerHTML = ["normal", "slow", "turbo"].map((x) => `<span class="${x === mode ? "proven" : "attempted"}" style="font-size:11px">${x.toUpperCase()}</span>`).join("");
      }
      const st = root.querySelector("[data-lv-status]");
      if (st) st.textContent = snap ? "connected" : "";
      if (snap) {
        snap.axes.forEach((v, k) => {
          const bar = root.querySelector(`[data-lv-raw="${k}"]`);
          const val = root.querySelector(`[data-lv-rawv="${k}"]`);
          if (bar) bar.setAttribute("style", meterStyle(v));
          if (val) val.textContent = v.toFixed(2);
        });
        snap.buttons.forEach((b, k) => {
          const el = root.querySelector(`[data-lv-btn="${k}"]`);
          if (el) el.classList.toggle("on", b.pressed);
          if (b.pressed && !prevBrowser[k] && hooks.onBrowserButton) hooks.onBrowserButton(k, snap, lay);
        });
        prevBrowser = snap.buttons.map((b) => b.pressed);
      }

      // The Sticks tab's plot and stage readout, when they are on screen.
      const sel = ctx.selectedAxis != null ? outs[ctx.selectedAxis] : null;
      const dot = document.getElementById("curveDot");
      if (dot && sel) {
        const d = dotAt(sel.s.inverted, sel.s.value);
        dot.setAttribute("cx", d.cx.toFixed(1));
        dot.setAttribute("cy", d.cy.toFixed(1));
      }
      const stages = document.getElementById("stages");
      if (stages && sel) {
        const f = (v) => (v >= 0 ? " " : "") + v.toFixed(3);
        stages.innerHTML = `
          <dt>Raw from pad</dt><dd>${sel.r ? f(sel.r.value) : "no pad"}</dd>
          <dt>Inverted</dt><dd>${f(sel.s.inverted)}</dd>
          <dt>After deadband</dt><dd>${f(sel.s.deadbanded)}</dd>
          <dt>After curve</dt><dd>${f(sel.s.curved)}</dd>
          <dt>Cap (${mode})</dt><dd>&times;${sel.s.cap.toFixed(3)}</dd>
          <dt>After slew</dt><dd>${f(sel.v)}</dd>
          <dt>Robot gets</dt><dd>${pctText(sel.v)} of top speed</dd>`;
      }
      if (hooks.onDown) hooks.onDown(down);
    }
    requestAnimationFrame(frame);
  };
  window.addEventListener("gamepadconnected", () => { built = ""; });
  window.addEventListener("gamepaddisconnected", () => { built = ""; });
  requestAnimationFrame(frame);
  return { rebuild: () => { built = ""; } };
}
