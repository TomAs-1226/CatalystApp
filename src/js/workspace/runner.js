// The devtools runner: four buttons, one PTY at a time, and a confirmation in front of the one
// that reaches hardware.
//
// The action table is data, and it is exported, because the arguments are the whole contract with
// the Rust side: `pty_open` with kind "devtools" runs `devtools <args…>` in the project directory,
// so a wrong array here is a wrong command on someone's robot. `devtools gradle -- build` is three
// arguments and the `--` is one of them - it is what separates the devtools arguments from
// Gradle's, and dropping it makes devtools try to interpret `build` itself.
//
// Deploy asks every time. Not "remember this choice", not a checkbox: the cost of an accidental
// deploy is a robot moving while someone has their hands in it, and a dialog that can be switched
// off is a dialog that is off by the second week of build season.

import { mountTerminal } from "./terminal.js";

/**
 * The four things this project actually does with devtools.
 *
 * `args` are the arguments after `devtools`, exactly as `PtyOpen.args` wants them.
 */
export const RUNNER_ACTIONS = [
  {
    id: "status",
    label: "Status",
    args: [],
    blurb: "What needs attention. Reads a cache, so it is instant.",
  },
  {
    id: "build",
    label: "Build",
    args: ["gradle", "--", "build"],
    blurb: "Compile with the JDK this branch needs.",
  },
  {
    id: "test",
    label: "Test",
    args: ["test"],
    blurb: "Run this project's own test command.",
  },
  {
    id: "deploy",
    label: "Deploy",
    args: ["gradle", "--", "deploy"],
    blurb: "Build and send the code to the robot.",
    confirm: "Deploy to the robot?",
    caution: "This is the one that reaches hardware. The robot will restart its code, and anything already enabled will move.",
  },
];

/** The action with this id, or null. */
export function actionById(id) {
  return RUNNER_ACTIONS.find((a) => a.id === id) || null;
}

/**
 * The devtools arguments for an action, as a fresh array.
 *
 * A copy, not the table's own array: the request object handed to `pty_open` travels through
 * serialisation and anything that mutated it in passing would change the command for every later
 * run in the session.
 */
export function argsFor(id) {
  const action = actionById(id);
  return action ? action.args.slice() : null;
}

/** True for actions that must be confirmed in the UI before they run. */
export function needsConfirm(id) {
  const action = actionById(id);
  return !!(action && action.confirm);
}

/** What the command looks like written out, for the label above the terminal. */
export function commandLine(id) {
  const args = argsFor(id);
  if (!args) return null;
  return args.length ? `devtools ${args.join(" ")}` : "devtools";
}

/**
 * Which buttons may be pressed right now.
 *
 * One at a time is the rule: a build and a deploy in the same directory race over the same Gradle
 * lock and the loser reports a failure that has nothing to do with the code.
 */
export function buttonState({ running, activeId, awaitingConfirm }) {
  const state = {};
  for (const action of RUNNER_ACTIONS) {
    state[action.id] = {
      disabled: running,
      active: running ? action.id === activeId : action.id === awaitingConfirm,
    };
  }
  return state;
}

// ---------------------------------------------------------------- the pane

/**
 * Mount the runner.
 *
 * @param {object}  opts
 * @param {Element} opts.el   the element to fill
 * @param {string}  opts.dir  the project directory every action runs in
 * @param {function} [opts.onStart]   (id) before an action's first output
 * @param {function} [opts.onOutput]  (text) each chunk it prints - what the problems list reads
 * @param {function} [opts.onFinish]  (id, code|null, { stopped }) when it ends
 * @returns {{ destroy, run, stop, isRunning }}
 */
export function mountRunner({ el, dir, onStart, onOutput, onFinish }) {
  el.classList.add("ws-runner");
  el.innerHTML = "";

  const bar = document.createElement("div");
  bar.className = "ws-runner-bar";

  const buttons = new Map();
  for (const action of RUNNER_ACTIONS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cat-btn ws-runner-btn";
    b.dataset.action = action.id;
    b.textContent = action.label;
    b.title = action.blurb;
    bar.appendChild(b);
    buttons.set(action.id, b);
  }

  const state = document.createElement("span");
  state.className = "ws-runner-state";

  const stopBtn = document.createElement("button");
  stopBtn.type = "button";
  stopBtn.className = "cat-btn ws-runner-stop hidden";
  stopBtn.textContent = "Stop";

  bar.append(state, stopBtn);

  // The confirmation. Rebuilt empty on every deploy click, never remembered.
  const confirm = document.createElement("div");
  confirm.className = "ws-runner-confirm hidden";
  const confirmText = document.createElement("div");
  confirmText.className = "ws-runner-confirm-text";
  const confirmRow = document.createElement("div");
  confirmRow.className = "ws-runner-confirm-row";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "cat-btn";
  cancelBtn.textContent = "Cancel";
  const goBtn = document.createElement("button");
  goBtn.type = "button";
  goBtn.className = "cat-btn cat-btn--loud";
  goBtn.textContent = "Deploy";
  confirmRow.append(cancelBtn, goBtn);
  confirm.append(confirmText, confirmRow);

  const termHost = document.createElement("div");
  termHost.className = "ws-runner-term";

  const idle = document.createElement("div");
  idle.className = "ws-runner-idle";
  idle.textContent = "Pick an action. It runs in " + dir + ".";
  termHost.appendChild(idle);

  el.append(bar, confirm, termHost);

  let terminal = null;
  let running = false;
  let activeId = null;
  let awaitingConfirm = null;
  let destroyed = false;

  const paint = () => {
    const s = buttonState({ running, activeId, awaitingConfirm });
    for (const [id, b] of buttons) {
      b.disabled = s[id].disabled;
      b.classList.toggle("active", s[id].active);
    }
    stopBtn.classList.toggle("hidden", !running);
    if (running) state.textContent = "Running " + commandLine(activeId);
    else if (activeId) state.textContent = commandLine(activeId) + " — done";
    else state.textContent = "";
    state.dataset.running = running ? "yes" : "no";
  };

  const closeConfirm = () => {
    awaitingConfirm = null;
    confirm.classList.add("hidden");
    paint();
  };

  const openConfirm = (action) => {
    awaitingConfirm = action.id;
    confirmText.textContent = action.confirm + " " + action.caution;
    goBtn.textContent = action.label;
    confirm.classList.remove("hidden");
    paint();
    // The cancel takes focus, so a stray Enter after clicking Deploy does not deploy.
    cancelBtn.focus();
  };

  async function start(id) {
    const args = argsFor(id);
    if (!args || running || destroyed) return;
    closeConfirm();
    if (terminal) {
      const old = terminal;
      terminal = null;
      await old.destroy();
    }
    idle.remove();
    termHost.innerHTML = "";
    const host = document.createElement("div");
    termHost.appendChild(host);

    activeId = id;
    running = true;
    paint();
    // Told before the first byte, so whatever collects the output starts from nothing rather than
    // appending this run's errors to the last one's.
    if (onStart) { try { onStart(id); } catch (_) { /* a listener is not the run */ } }

    terminal = mountTerminal({
      el: host,
      kind: "devtools",
      cwd: dir,
      args,
      restartable: false,
      onOutput,
      onExit: (code, info) => {
        running = false;
        paint();
        if (onFinish) { try { onFinish(id, code, info); } catch (_) { /* as above */ } }
      },
      onError: () => { running = false; paint(); },
    });
    terminal.focus();
  }

  const onBarClick = (ev) => {
    const btn = ev.target.closest("button[data-action]");
    if (!btn || btn.disabled) return;
    const action = actionById(btn.dataset.action);
    if (!action) return;
    // Any other action cancels a confirmation that is open - the answer belongs to the question
    // that was asked, and the question has just changed.
    if (awaitingConfirm && awaitingConfirm !== action.id) closeConfirm();
    if (needsConfirm(action.id)) {
      if (awaitingConfirm === action.id) closeConfirm();
      else openConfirm(action);
      return;
    }
    start(action.id).catch(() => { running = false; paint(); });
  };

  bar.addEventListener("click", onBarClick);
  cancelBtn.addEventListener("click", () => closeConfirm());
  goBtn.addEventListener("click", () => {
    const id = awaitingConfirm;
    if (id) start(id).catch(() => { running = false; paint(); });
  });
  stopBtn.addEventListener("click", () => {
    if (terminal) Promise.resolve(terminal.stop()).catch(() => {});
  });

  paint();

  return {
    async destroy() {
      destroyed = true;
      bar.removeEventListener("click", onBarClick);
      if (terminal) {
        const old = terminal;
        terminal = null;
        await old.destroy();
      }
      el.innerHTML = "";
      el.classList.remove("ws-runner");
    },
    /** Start an action by id. Deploy still asks: this opens the confirmation, it does not skip it. */
    run(id) {
      if (needsConfirm(id)) {
        const action = actionById(id);
        if (action) openConfirm(action);
        return;
      }
      return start(id);
    },
    stop() {
      if (terminal) return terminal.stop();
    },
    isRunning: () => running,
  };
}
