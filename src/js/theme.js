// The identity's design tokens, read from CSS at run time.
//
// Monaco's theme is a JSON object, not a stylesheet: it cannot say var(--cat-signal). Left alone it
// would carry a second copy of the palette in JavaScript, and a second copy is a copy that drifts -
// this app has already paid for that once with the hand-kept version constant that claimed 2.0.0 for
// four releases. So the editor's theme is built from the very custom properties the stylesheet
// defines, and this module is the only place that turns one into the other.
//
// A token that is not defined returns null rather than a guess. The caller then leaves that entry
// out of the theme and Monaco falls back to its own base colour, instead of a colour invented here.

/**
 * The raw value of a CSS custom property, as the browser computed it.
 *
 * Custom properties are substituted at computed-value time, so this follows `var()` chains -
 * `--cat-signal: var(--coral)` reads as the accent the user picked, including after app.js rewrites
 * it. It does not convert units or evaluate `color-mix()`; that is hexToken's job.
 *
 * @param {string} name e.g. "--cat-signal"
 * @param {Element} [el] the element to read from; the document root by default
 * @returns {string} the value, or "" when the token is not defined (or there is no DOM at all)
 */
export function cssToken(name, el) {
  const target = el || (typeof document === "undefined" ? null : document.documentElement);
  if (!target) return "";
  return String(getComputedStyle(target).getPropertyValue(name) || "").trim();
}

/**
 * A CSS colour as the hex string Monaco accepts, or null if it is not a colour this can pin down.
 *
 * @param {string} name e.g. "--cat-ground"
 * @param {Element} [el]
 * @returns {string|null} "#rrggbb" or "#rrggbbaa"
 */
export function hexToken(name, el) {
  const raw = cssToken(name, el);
  if (!raw) return null;
  // Direct first: most tokens are already hex or rgb(), and parsing them touches no DOM. The probe
  // is the fallback for everything else a stylesheet may legitimately say - a named colour,
  // color-mix(), oklch() - which only the browser can resolve.
  return toHex(raw) || toHex(usedColour(raw, el));
}

const clamp255 = (n) => Math.max(0, Math.min(255, Math.round(n)));
const pair = (n) => clamp255(n).toString(16).padStart(2, "0");

/**
 * A hex/rgb()/rgba() colour in the one spelling Monaco parses. Pure, so it can be tested.
 *
 * Monaco reads `#RGB`, `#RGBA`, `#RRGGBB` and `#RRGGBBAA` and nothing else - a theme entry of
 * "rgba(228, 231, 225, 0.1)" is dropped on the floor with no error, which is exactly how a hairline
 * goes missing and nobody can say when. Hairlines in this identity are written as rgba(), so this
 * conversion is load-bearing, not decoration.
 *
 * @param {string} value
 * @returns {string|null} lower-case "#rrggbb" or "#rrggbbaa"
 */
export function toHex(value) {
  const v = String(value ?? "").trim().toLowerCase();
  if (!v) return null;

  const hex = /^#([0-9a-f]+)$/.exec(v);
  if (hex) {
    const d = hex[1];
    if (d.length === 3 || d.length === 4) return "#" + [...d].map((c) => c + c).join("");
    if (d.length === 6 || d.length === 8) return "#" + d;
    return null;
  }

  // Both spellings: rgb(1, 2, 3) / rgba(1, 2, 3, .5) and the space syntax rgb(1 2 3 / 50%).
  //
  // color(srgb 0.35 0.37 0.36) is here because it is what Chromium hands back for a resolved
  // color-mix(in srgb, ...) - the probe below asks the browser to resolve a token it cannot parse,
  // and this is the shape the answer comes back in. A colour in any other space (oklch, lab,
  // display-p3) is left alone: converting it properly is a colour-management job, and a wrong
  // conversion is worse than letting monaco use its own base colour.
  const srgb = /^color\(\s*srgb\s+([^)]*)\)$/.exec(v);
  const fn = srgb || /^rgba?\(\s*([^)]*)\)$/.exec(v);
  if (!fn) return null;
  const parts = fn[1].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3 || parts.length > 4) return null;

  // A percentage means the same thing in both; a bare number is 0-255 in rgb() and 0-1 in color().
  const channel = (t) =>
    t.endsWith("%") ? (parseFloat(t) / 100) * 255 : srgb ? parseFloat(t) * 255 : parseFloat(t);
  const rgb = parts.slice(0, 3).map(channel);
  if (rgb.some((n) => !Number.isFinite(n))) return null;

  let out = "#" + rgb.map(pair).join("");
  if (parts.length === 4) {
    const t = parts[3];
    const alpha = t.endsWith("%") ? parseFloat(t) / 100 : parseFloat(t);
    if (!Number.isFinite(alpha)) return null;
    // A fully opaque colour stays six digits: Monaco's token rules reject the eight-digit form.
    if (alpha < 1) out += pair(alpha * 255);
  }
  return out;
}

// A colour nothing here can parse, handed to the browser to resolve. An invalid value leaves the
// sentinel in place, which is how this tells "could not parse" apart from "resolved to something".
const SENTINEL = "rgb(1, 2, 3)";

function usedColour(value, el) {
  const doc = (el && el.ownerDocument) || (typeof document === "undefined" ? null : document);
  if (!doc) return "";
  const probe = doc.createElement("span");
  probe.style.color = SENTINEL;
  probe.style.color = value;
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  // documentElement rather than body: this can run before <body> exists, and an element outside the
  // document has no computed style to read.
  doc.documentElement.appendChild(probe);
  const used = getComputedStyle(probe).color;
  probe.remove();
  return used === SENTINEL && value.trim() !== SENTINEL ? "" : used;
}
