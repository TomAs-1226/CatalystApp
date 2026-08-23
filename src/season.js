// Which FRC season a version string belongs to.
//
// Its own module so it can be tested. app.js is a browser module that touches window and the DOM at
// import time, and this rule is worth checking against real inputs rather than by eye.

/**
 * The season a version string belongs to, as the four leading digits, or null if there are none.
 *
 * Nothing writes a bare year during an alpha. A real WPILib 2027 project has
 * `"projectYear": "2027_alpha1"` in `.wpilib/wpilib_preferences.json` — read off the
 * SystemCoreTesting test projects, not guessed — and vendordeps carry `frcYear` in their own
 * variations, sometimes as a number and sometimes as a string.
 *
 * Comparing whole strings reports every correct 2027 project as the wrong season, which is worse
 * than not checking at all: it tells a team their working setup is broken and sends them off to
 * re-import a project that was already right.
 *
 * @param {unknown} value a projectYear, frcYear, or anything else
 * @returns {string|null} e.g. "2027"
 */
export function seasonOf(value) {
  const m = String(value ?? "").match(/^\s*(\d{4})/);
  return m ? m[1] : null;
}
