// Comparing two version strings.
//
// Its own module so it can be tested, and worth testing because the previous version got the
// pre-release cases backwards in a way nothing would have noticed until it mattered:
//
//   2.0.0 vs 2.0.0-alpha.1   ->  reported the finished release as OLDER than its own alpha
//   2.0.0-beta.2 vs -alpha.1 ->  reported them as the same version
//
// It split on both dots and hyphens and ran parseInt over the pieces, so "alpha" became 0 and the
// pre-release tag vanished into an extra numeric field. Every alpha comparison happened to work,
// which is exactly why it survived: the case it breaks is the one that only arrives once, when the
// real release ships and every team still on the alpha is told they are up to date.

/**
 * Compare two semver-ish version strings.
 *
 * Follows semver's ordering rules, which exist for precisely the case above:
 *
 *  - major, minor and patch compare numerically;
 *  - a version WITH a pre-release tag is lower than the same version without one, so
 *    `2.0.0-alpha.1 < 2.0.0`;
 *  - pre-release identifiers compare left to right; numeric ones numerically, others as text, and
 *    a numeric identifier ranks below a non-numeric one;
 *  - if all shared identifiers match, the version with more of them is higher, so
 *    `2.0.0-alpha < 2.0.0-alpha.1`.
 *
 * Build metadata after `+` is ignored, as semver requires — it never affects precedence.
 *
 * @returns {number} 1 if a is newer, -1 if b is newer, 0 if they rank the same
 */
export function cmpVer(a, b) {
  const A = parse(a);
  const B = parse(b);

  for (let i = 0; i < 3; i++) {
    if (A.release[i] !== B.release[i]) return A.release[i] > B.release[i] ? 1 : -1;
  }

  // A release outranks any pre-release of the same numbers.
  if (!A.pre.length && B.pre.length) return 1;
  if (A.pre.length && !B.pre.length) return -1;

  for (let i = 0; i < Math.max(A.pre.length, B.pre.length); i++) {
    const x = A.pre[i];
    const y = B.pre[i];
    // Fewer identifiers ranks lower: 2.0.0-alpha < 2.0.0-alpha.1.
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;

    const xn = isNumeric(x);
    const yn = isNumeric(y);
    if (xn && yn) return Number(x) > Number(y) ? 1 : -1;
    // Numeric identifiers always rank below non-numeric ones.
    if (xn !== yn) return xn ? -1 : 1;
    return x > y ? 1 : -1;
  }

  return 0;
}

function isNumeric(s) {
  return /^\d+$/.test(s);
}

function parse(v) {
  const text = String(v ?? "").trim().replace(/^v/i, "");
  // Build metadata never affects precedence.
  const noBuild = text.split("+")[0];
  const dash = noBuild.indexOf("-");
  const core = dash === -1 ? noBuild : noBuild.slice(0, dash);
  const pre = dash === -1 ? "" : noBuild.slice(dash + 1);

  const release = core.split(".").slice(0, 3).map((n) => {
    const parsed = parseInt(n, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  });
  while (release.length < 3) release.push(0);

  return { release, pre: pre ? pre.split(".") : [] };
}
