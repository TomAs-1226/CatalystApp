import { test } from "node:test";
import assert from "node:assert/strict";

import { seasonOf } from "./season.js";

// The inputs that actually appear. The alpha-suffixed one is the case that matters: comparing whole
// strings passed every test anyone would think to write by hand and then reported every real 2027
// project as the wrong season.

test("a WPILib alpha project year is its season", () => {
  // Read off SystemCoreTesting/testprojects/pwmoutput/.wpilib/wpilib_preferences.json.
  assert.equal(seasonOf("2027_alpha1"), "2027");
  assert.equal(seasonOf("2027_alpha5"), "2027");
});

test("a plain year is its own season", () => {
  assert.equal(seasonOf("2027"), "2027");
  assert.equal(seasonOf("2026"), "2026");
});

test("frcYear written as a number works too", () => {
  // Vendordeps write this both ways depending on who generated them.
  assert.equal(seasonOf(2027), "2027");
});

test("beta and release-candidate spellings resolve", () => {
  assert.equal(seasonOf("2027beta"), "2027");
  assert.equal(seasonOf("2027.0.0-alpha-6"), "2027");
  assert.equal(seasonOf("2027-rc1"), "2027");
});

test("a different season is still reported as different", () => {
  // The whole point of the check. Loosening it must not make it blind.
  assert.notEqual(seasonOf("2026_alpha1"), "2027");
  assert.equal(seasonOf("2026.3.2"), "2026");
});

test("nothing usable gives null rather than a guess", () => {
  for (const bad of [null, undefined, "", "unknown", "alpha", {}, []]) {
    assert.equal(seasonOf(bad), null, `input: ${JSON.stringify(bad)}`);
  }
});

test("a year that is not at the start does not count", () => {
  // "v2027" is not a season string anyone writes, and matching loosely here would let a version
  // like "1.2027" read as season 2027.
  assert.equal(seasonOf("v2027"), null);
  assert.equal(seasonOf("1.2027"), null);
});
