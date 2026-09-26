// Reading Catalyst Link's one public route.
//
// The page's whole claim is "this is running, and it is a Link". Both halves are worth a test: a
// port with something else on it must not be reported as a Link, and a Link that answers must not
// be reported as absent because a field was missing.
//
// The module is imported for these two functions alone. It touches the document only inside `init`
// and `probe`, and core.js guards its one `window` read, so importing it here does not need a DOM.

import { test } from "node:test";
import assert from "node:assert/strict";

import { LINK_STATUS_URL, linkFacts, readLinkStatus } from "./tab.js";

/* The unauthenticated body, exactly as catalyst_link/server.py's LinkApp.status builds it before the
 * `if not authed: return base`: five fields, and `auth` false because we sent no token. */
const PUBLIC = { ok: true, name: "PIT-LAPTOP", version: "1.0.0", auth: false, pairing: true };

test("the route is the one that answers without a token", () => {
  // Hard-coded on purpose: this is the only route the Link serves unauthenticated, and reaching for
  // any other one would need the main token off disk - a boundary that is the Link app's, not ours.
  assert.equal(LINK_STATUS_URL, "http://127.0.0.1:8765/link/status");
});

test("the public status reads as a running Link", () => {
  const s = readLinkStatus(PUBLIC);
  assert.deepEqual(s, { ok: true, name: "PIT-LAPTOP", version: "1.0.0", auth: false, pairing: true });
});

test("auth false is the expected answer, not a problem", () => {
  // We deliberately send no token, so `auth` is always false here. Treating that as a failure would
  // report every healthy Link as broken.
  assert.equal(readLinkStatus(PUBLIC).ok, true);
  assert.equal(readLinkStatus(PUBLIC).auth, false);
});

test("something else listening on 8765 is not a Link", () => {
  // A Link always sends ok:true. Another program that happens to hold the port and answer JSON must
  // read as "not found", because the page would otherwise tell someone to go look for a window that
  // does not exist.
  for (const notALink of [{}, { name: "x", version: "2" }, { ok: "true" }, { ok: 1 }, { ok: false }]) {
    assert.equal(readLinkStatus(notALink).ok, false);
  }
});

test("a body that is not an object does not throw", () => {
  for (const nothing of [null, undefined, "", 7, [], "ok"]) {
    const s = readLinkStatus(nothing);
    assert.equal(s.ok, false);
    assert.equal(s.name, null);
    assert.equal(s.version, null);
    assert.equal(s.pairing, null);
  }
});

test("blank strings are not a name or a version", () => {
  const s = readLinkStatus({ ok: true, name: "   ", version: "" });
  assert.equal(s.name, null);
  assert.equal(s.version, null);
});

test("pairing is three states, not two", () => {
  // Absent has to be distinguishable from off: the page says "pairing is off, so the token has to be
  // typed in by hand", which is a claim about how the Link was started and must not be made up.
  assert.equal(readLinkStatus({ ok: true, pairing: true }).pairing, true);
  assert.equal(readLinkStatus({ ok: true, pairing: false }).pairing, false);
  assert.equal(readLinkStatus({ ok: true }).pairing, null);
  assert.equal(readLinkStatus({ ok: true, pairing: "yes" }).pairing, null);
});

test("the facts name the Link and its version", () => {
  const rows = linkFacts(PUBLIC);
  assert.ok(rows.every((r) => ["ok", "warn", "bad"].includes(r.level)), "every row has a level");
  const text = rows.map((r) => r.what).join(" | ");
  assert.match(text, /PIT-LAPTOP/);
  assert.match(text, /1\.0\.0/);
  assert.match(text, /Pairing by code is on/);
});

test("a missing version is a warning, not a silent gap", () => {
  const rows = linkFacts({ ok: true, name: "x" });
  const version = rows.find((r) => /[Vv]ersion/.test(r.what));
  assert.equal(version.level, "warn");
});

test("pairing off says so; pairing unknown says nothing", () => {
  assert.match(linkFacts({ ...PUBLIC, pairing: false }).map((r) => r.what).join(" "), /Pairing by code is off/);
  const silent = linkFacts({ ok: true, name: "x", version: "1" }).map((r) => r.what).join(" ");
  assert.doesNotMatch(silent, /Pairing/);
});
