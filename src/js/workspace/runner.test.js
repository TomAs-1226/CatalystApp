import { test } from "node:test";
import assert from "node:assert/strict";

import { RUNNER_ACTIONS, actionById, argsFor, buttonState, commandLine, needsConfirm } from "./runner.js";

// The arguments are the whole contract with the backend: `pty_open` with kind "devtools" runs
// `devtools <args…>` in the project directory. A wrong array here is a wrong command on someone's
// robot, and there is no layer under this one that would catch it.

test("each action sends exactly the devtools arguments it claims to", () => {
  assert.deepEqual(argsFor("status"), [], "plain `devtools` takes no arguments");
  assert.deepEqual(argsFor("build"), ["gradle", "--", "build"]);
  assert.deepEqual(argsFor("deploy"), ["gradle", "--", "deploy"]);
  assert.deepEqual(argsFor("test"), ["test"]);
});

test("the gradle separator is its own argument and is never dropped", () => {
  // `devtools gradle -- build` is three arguments. Without the `--`, devtools reads `build` as one
  // of its own and never reaches Gradle - and it does it quietly enough to look like a build.
  for (const id of ["build", "deploy"]) {
    const args = argsFor(id);
    assert.equal(args[0], "gradle");
    assert.equal(args[1], "--", `${id} must keep the separator`);
    assert.equal(args.length, 3);
  }
});

test("argsFor hands out a copy, so a caller cannot rewrite the next run's command", () => {
  // The array goes into the request object that crosses the IPC boundary. If that were the table's
  // own array, anything that mutated it in passing would change the command for the rest of the
  // session - a deploy that used to be a build.
  const first = argsFor("build");
  first.push("--offline");
  first[2] = "clean";
  assert.deepEqual(argsFor("build"), ["gradle", "--", "build"]);
});

test("an unknown action produces nothing at all", () => {
  // The alternative - falling back to plain `devtools` - would run a command nobody asked for.
  assert.equal(argsFor("publish"), null);
  assert.equal(actionById("publish"), null);
  assert.equal(commandLine("publish"), null);
  assert.equal(needsConfirm("publish"), false);
  assert.equal(argsFor(undefined), null);
});

test("deploy is the only action that asks first", () => {
  // It is the one that reaches hardware. Everything else touches files.
  assert.equal(needsConfirm("deploy"), true);
  for (const id of ["status", "build", "test"]) {
    assert.equal(needsConfirm(id), false, `${id} should not need a confirmation`);
  }
});

test("the deploy confirmation says what it is about to do to the robot", () => {
  const deploy = actionById("deploy");
  assert.ok(deploy.confirm, "there must be a question");
  assert.match(deploy.caution, /robot/i, "and it must name the hardware it reaches");
});

test("the command is written out the way it would be typed", () => {
  assert.equal(commandLine("status"), "devtools");
  assert.equal(commandLine("build"), "devtools gradle -- build");
  assert.equal(commandLine("deploy"), "devtools gradle -- deploy");
  assert.equal(commandLine("test"), "devtools test");
});

test("the four actions are the four this project uses, each with its own id", () => {
  const ids = RUNNER_ACTIONS.map((a) => a.id);
  assert.deepEqual([...ids].sort(), ["build", "deploy", "status", "test"]);
  assert.equal(new Set(ids).size, ids.length, "a duplicate id would make one button unreachable");
  for (const action of RUNNER_ACTIONS) {
    assert.ok(action.label, `${action.id} needs a label`);
    assert.ok(action.blurb, `${action.id} needs a description`);
    assert.ok(Array.isArray(action.args));
  }
});

test("while something is running, nothing else can be started", () => {
  // One at a time: a build and a deploy in the same directory race over the same Gradle lock, and
  // the loser reports a failure that has nothing to do with the code.
  const state = buttonState({ running: true, activeId: "build", awaitingConfirm: null });
  for (const id of ["status", "build", "deploy", "test"]) {
    assert.equal(state[id].disabled, true, `${id} must be disabled while a run is in flight`);
  }
  assert.equal(state.build.active, true, "the running one is the one marked active");
  assert.equal(state.deploy.active, false);
});

test("when nothing is running every action is available", () => {
  const state = buttonState({ running: false, activeId: "build", awaitingConfirm: null });
  for (const id of ["status", "build", "deploy", "test"]) {
    assert.equal(state[id].disabled, false);
    assert.equal(state[id].active, false, "a finished run does not leave a button lit");
  }
});

test("the action waiting on its confirmation is the one marked active", () => {
  const state = buttonState({ running: false, activeId: null, awaitingConfirm: "deploy" });
  assert.equal(state.deploy.active, true);
  assert.equal(state.build.active, false);
  assert.equal(state.deploy.disabled, false);
});
