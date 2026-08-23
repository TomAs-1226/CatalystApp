import { test } from "node:test";
import assert from "node:assert/strict";

import { cmpVer } from "./version.js";

const newer = (a, b, why) => assert.equal(cmpVer(a, b), 1, why || `${a} should be newer than ${b}`);
const older = (a, b, why) => assert.equal(cmpVer(a, b), -1, why || `${a} should be older than ${b}`);
const same = (a, b) => assert.equal(cmpVer(a, b), 0, `${a} should rank the same as ${b}`);

// --- the cases the old comparator got wrong ---------------------------------

test("a finished release outranks its own pre-releases", () => {
  // The one that only arrives once, and would have arrived at season start: the old comparator
  // reported 2.0.0 as OLDER than 2.0.0-alpha.1, so every team still on the alpha would have been
  // told they were up to date and never offered the real thing.
  newer("2.0.0", "2.0.0-alpha.1");
  newer("2.0.0", "2.0.0-beta.3");
  newer("2.0.0", "2.0.0-rc.1");
});

test("beta outranks alpha", () => {
  // Previously equal, because both tags parsed to 0.
  newer("2.0.0-beta.1", "2.0.0-alpha.1");
  newer("2.0.0-rc.1", "2.0.0-beta.9");
});

test("the last stable release is older than the next major's alpha", () => {
  older("1.12.0", "2.0.0-alpha.1");
  newer("2.0.0-alpha.1", "1.12.0");
});

// --- ordinary ordering ------------------------------------------------------

test("release numbers compare numerically, not as text", () => {
  newer("1.12.0", "1.9.0", "12 is after 9 even though '12' sorts before '9'");
  newer("2.0.0", "1.99.99");
  newer("1.0.10", "1.0.9");
});

test("pre-release numbers compare numerically too", () => {
  newer("2.0.0-alpha.2", "2.0.0-alpha.1");
  newer("2.0.0-alpha.10", "2.0.0-alpha.9");
});

test("a longer pre-release outranks its prefix", () => {
  newer("2.0.0-alpha.1", "2.0.0-alpha");
});

test("identical versions rank the same", () => {
  same("2.0.0-alpha.1", "2.0.0-alpha.1");
  same("1.12.0", "1.12.0");
});

// --- the shapes these strings actually arrive in -----------------------------

test("a leading v is ignored", () => {
  // Vendordeps write "v2.0.0-alpha.1" in dependency entries and "2.0.0-alpha.1" in the version
  // field, and both reach this function.
  same("v2.0.0-alpha.1", "2.0.0-alpha.1");
  newer("v2.0.0", "v2.0.0-alpha.1");
});

test("build metadata does not affect precedence", () => {
  // Semver says so, and a build tag differing is not a reason to offer someone an update.
  same("2.0.0+build.7", "2.0.0");
  same("2.0.0-alpha.1+abc", "2.0.0-alpha.1");
});

test("a short version is padded rather than mis-ranked", () => {
  same("2.0", "2.0.0");
  newer("2.1", "2.0.9");
});

test("nothing usable ranks as the lowest possible version rather than throwing", () => {
  // An offline or malformed response must not take the update check down with it.
  assert.doesNotThrow(() => cmpVer(null, "2.0.0"));
  assert.doesNotThrow(() => cmpVer(undefined, undefined));
  older("", "0.0.1");
});

// --- the decision this actually drives --------------------------------------

test("an update is offered exactly when the published version is genuinely newer", () => {
  const bundled = "2.0.0-alpha.1";
  const offers = (published) => cmpVer(published, bundled) > 0;

  assert.equal(offers("2.0.0-alpha.2"), true, "a newer alpha");
  assert.equal(offers("2.0.0-beta.1"), true, "the first beta");
  assert.equal(offers("2.0.0"), true, "the real release");
  assert.equal(offers("2.0.0-alpha.1"), false, "the same build");
  assert.equal(offers("1.12.0"), false, "the old stable line is not an update");
});
