// Apply to project: say exactly what will change, write it through the app's own project door, and
// say what was written and where.
//
// Nothing is written that was not shown first. The preview reads each file fresh, and the write is
// refused by the backend if the file changed after that read, so the diff on screen is the change
// that lands. A project that has not allowed writing gets the reason and the way to allow it - the
// same switch the Projects page gives an AI agent - rather than a button that silently fails.

import { newFile, planConstants, planWrite, readJava } from "./codegen.js";
import { diffLines, hunks, stats } from "./diff.js";
import { changes, errorsOf, javaPath, validate } from "./model.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));

function diffHtml(oldText, newText) {
  const ops = diffLines(oldText, newText);
  const st = stats(ops);
  const hs = hunks(ops, 3);
  if (!hs.length) return { st, html: "<p class=\"cap\">No change: the file already says exactly this.</p>" };
  const body = hs.map((h) => `<div class="hh">@@ line ${h.oldStart} (was ${h.oldLines} lines, now ${h.newLines}) @@</div>` +
    h.lines.map((l) => `<div class="l ${l.op === "+" ? "add" : l.op === "-" ? "del" : ""}"><span class="no">${l.a ?? ""}</span><span class="no">${l.b ?? ""}</span><span class="op">${l.op === " " ? "" : l.op === "-" ? "&minus;" : "+"}</span><span>${esc(l.text)}</span></div>`).join("")).join("");
  return { st, html: `<div class="diff" role="region" aria-label="changes">${body}</div>` };
}

/** Where the generated class goes: the file already carrying its regions, or the standard path. */
function classPath(ctx) {
  return (ctx.scan && ctx.scan.generated && ctx.scan.generated[0]) || javaPath(ctx.config);
}

/** The static field that holds the robot, e.g. `ROBOT` in `static final X1 ROBOT = new X1();`. */
function robotRef(ctx) {
  const cls = ctx.config.target.robotClass;
  if (!cls || !ctx.sources) return "robot";
  const re = new RegExp(`\\bstatic\\s+(?:final\\s+)?${cls}\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*new\\s+${cls}\\s*\\(`);
  for (const f of ctx.sources) { const m = re.exec(f.text); if (m) return m[1]; }
  return "robot";
}

/** The lines a team adds once, so the robot uses the generated class. */
export function wiringSnippet(ctx) {
  const t = ctx.config.target;
  const cls = t.className;
  const ref = robotRef(ctx);
  if (!t.robotClass) {
    return `// Where the robot is built:\nfinal ${cls} driverConfig = new ${cls}();\n\n// The drive command: use driverConfig.forward(), strafe() and turn(), with a deadband of 0.\n// The teleop op mode's onStart(): driverConfig.bind();\n// robotPeriodic(): driverConfig.periodic();\n`;
  }
  return `// 1. In ${t.robotClass}.java, with the other fields:
public final ${cls} driverConfig = new ${cls}(this);

// 2. In ${t.robotClass}'s periodic method, every loop, enabled or not:
driverConfig.periodic();

// 3. In the teleop op mode's onStart(), in place of the drive command and driver bindings it has now:
${t.swerveField ? `${ref}.${t.swerveField}.setDefaultCommand(${ref}.driverConfig.drive());\n` : ""}${ref}.driverConfig.bind();
`;
}

/**
 * Open the Apply dialog. `ctx` is the page's state plus what it can do:
 * { config, baseline, project, scan, sources, invoke, inApp, refreshProjects, onWritten }.
 */
export async function openApply(dlg, ctx) {
  const findings = validate(ctx.config, ctx.scan);
  const errs = errorsOf(findings);
  const t = ctx.config.target;
  const files = [];

  const read = async (rel) => {
    if (!ctx.inApp || !ctx.project) return undefined;
    return ctx.invoke("read_project_file", { dir: ctx.project.path, rel });
  };

  let readError = "";
  try {
    if (t.classFile) {
      const rel = classPath(ctx);
      const existing = await read(rel);
      const plan = existing === undefined ? { ok: true, mode: "create", text: newFile(ctx.config), preview: true } : planWrite(existing, ctx.config);
      const prior = existing ? readJava(existing) : null;
      files.push({ rel, existing, plan, prior, what: "profiles, buttons and rumble" });
    }
    if (t.constants) {
      const rel = t.constants.path;
      const existing = await read(rel);
      const plan = existing === undefined ? { ok: false, preview: true, problems: ["Reading the file needs the desktop app and a project."] } : planConstants(existing, ctx.config);
      const prior = existing ? readJava(existing) : null;
      files.push({ rel, existing, plan, prior, what: `the ${t.constants.className} constants block` });
    }
  } catch (e) {
    readError = String(e && e.message ? e.message : e);
  }

  const project = ctx.project;
  const canWrite = ctx.inApp && project && project.agent_write;
  const blocked = [];
  if (!ctx.inApp) blocked.push("Writing into a project needs the desktop app. This preview can show the file and copy it.");
  else if (!project) blocked.push("No project is chosen. Import your robot project on the Projects page, then pick it at the top of this page.");
  if (errs.length) blocked.push(`${errs.length} problem${errs.length === 1 ? "" : "s"} must be fixed first - the Checks list names ${errs.length === 1 ? "it" : "them"}.`);
  if (readError) blocked.push(`Could not read the project: ${readError}`);
  // A constants file still waiting for its marker lines is skipped, not a reason to write nothing:
  // the dialog shows the two lines to paste, and the other file goes ahead.
  for (const f of files) if (!f.plan.ok && !f.plan.preview && !f.plan.needsMarkers) blocked.push(`${f.rel}: ${f.plan.problems.join(" ")}`);

  const permission = ctx.inApp && project && !project.agent_write ? `
    <div class="dc-note warn" style="margin:0 0 16px">
      <b>Writing is off for ${esc(project.name)}.</b> Driver Config writes only the file${files.length === 1 ? "" : "s"} below, and only after
      you have seen ${files.length === 1 ? "it" : "them"} here. It uses the same switch that lets an AI agent write: open <b>Projects</b>,
      find ${esc(project.name)}, and switch on <b>Let agents write</b>. Then press Check again. Nothing has been written.
      <div class="row-btns"><button class="btn" data-apply="projects">Open Projects</button><button class="btn" data-apply="recheck">Check again</button></div>
    </div>` : "";

  const inWords = ctx.baseline ? changes(ctx.baseline, ctx.config) : [];
  const fileBlocks = files.map((f, i) => {
    let status;
    let body = "";
    if (f.plan.ok) {
      const d = diffHtml(f.existing || "", f.plan.text);
      status = f.plan.mode === "create" ? `<span class="attempted">new file</span> <span class="cap">${d.st.added} lines</span>`
        : d.st.added + d.st.removed === 0 ? "<span class=\"proven\">no change</span>"
          : `<span class="proven">marked regions replaced</span> <span class="cap mono">+${d.st.added} &minus;${d.st.removed}</span>`;
      body = d.html;
    } else if (f.plan.needsMarkers) {
      status = "<span class=\"attempted\">needs its two marker lines</span>";
      body = `<p class="small">${esc(f.plan.problems[0])}</p><pre class="code" id="markers${i}">${esc(f.plan.markers.join("\n"))}</pre>
        <div class="row-btns" style="margin-top:8px"><button class="btn tiny" data-copy="markers${i}">Copy the two lines</button></div>`;
    } else {
      status = "<span class=\"attempted\">cannot be written yet</span>";
      body = `<p class="small">${esc(f.plan.problems.join(" "))}</p>`;
    }
    const hand = f.prior && f.prior.handEdited ? `<div class="dc-note warn" style="margin:8px 0">Someone edited the generated region of this file by hand. Writing replaces those edits; the lines marked &minus; below are them.</div>` : "";
    const copy = !ctx.inApp && f.plan.ok ? `<div class="row-btns" style="margin-top:8px"><button class="btn tiny" data-copy="file${i}">Copy the whole file</button></div><textarea id="file${i}" hidden>${esc(f.plan.text)}</textarea>` : "";
    return `<div style="margin-top:16px">
      <div class="file"><span class="path mono">${esc(f.rel)}</span>${status}<span class="cap">${esc(f.what)}</span></div>${hand}${body}${copy}</div>`;
  }).join("");

  const ready = canWrite && !blocked.length && files.some((f) => f.plan.ok);
  dlg.innerHTML = `
    <div class="dlg-h"><div class="lbl">Apply to project</div><h2 id="applyTitle">${project ? esc(project.name) : "Browser preview"}</h2>
      ${project ? `<div class="path mono" style="margin-top:4px">${esc(project.path)}</div>` : ""}</div>
    <div class="dlg-b">
      ${permission}
      ${blocked.length ? `<div class="finds" style="margin-bottom:8px">${blocked.map((b) => `<div class="find error"><span class="g">&#x2715;</span><div>${esc(b)}</div></div>`).join("")}</div>` : ""}
      <div class="lbl">What will change</div>
      ${fileBlocks || "<p class=\"cap\">Nothing is set to be written.</p>"}
      ${inWords.length ? `<div class="lbl" style="margin-top:20px">In words, against ${esc(ctx.origin || "what the project has")}</div>
        <div class="changes">${inWords.slice(0, 60).map((c) => `<div class="change"><span>${esc(c.label)}</span><span class="rev">${c.from != null ? `<span class="rev-1">${esc(c.from)}</span>` : "<span class=\"cap\">added</span>"}${c.to != null ? `<span class="rev-2">${esc(c.to)}</span>` : "<span class=\"cap\">removed</span>"}</span></div>`).join("")}</div>` : ""}
      <div id="applyResult"></div>
    </div>
    <div class="dlg-f">
      <button class="btn" data-apply="close">${ready ? "Cancel" : "Close"}</button>
      ${ready ? `<button class="btn primary" data-apply="write">Write ${files.filter((f) => f.plan.ok).length} file${files.filter((f) => f.plan.ok).length === 1 ? "" : "s"} to ${esc(project.name)}</button>` : ""}
    </div>`;

  dlg.onclick = async (e) => {
    const b = e.target.closest("[data-apply],[data-copy]");
    if (!b) return;
    if (b.dataset.copy) {
      const el = document.getElementById(b.dataset.copy);
      try { await navigator.clipboard.writeText(el.value !== undefined && el.tagName === "TEXTAREA" ? el.value : el.textContent); b.textContent = "Copied"; } catch { b.textContent = "Select and copy by hand"; }
      return;
    }
    const act = b.dataset.apply;
    if (act === "close") dlg.close();
    else if (act === "projects") { try { window.parent.postMessage({ type: "catalyst:navigate", view: "settings/projects" }, "*"); } catch { /* not in the app */ } dlg.close(); }
    else if (act === "recheck") { await ctx.refreshProjects(); openApply(dlg, ctx.refreshed()); }
    else if (act === "write") await write(dlg, ctx, files.filter((f) => f.plan.ok));
  };
  if (!dlg.open) dlg.showModal();
}

async function write(dlg, ctx, files) {
  const out = dlg.querySelector("#applyResult");
  const btn = dlg.querySelector("[data-apply=write]");
  if (btn) { btn.disabled = true; btn.textContent = "Writing..."; }
  const done = [];
  for (const f of files) {
    try {
      const r = await ctx.invoke("write_project_file", {
        dir: ctx.project.path, rel: f.rel, content: f.plan.text,
        expected: f.existing == null ? null : f.existing, expectAbsent: f.existing == null,
      });
      done.push(r);
    } catch (e) {
      out.innerHTML = `<div class="find error" style="margin-top:16px"><span class="g">&#x2715;</span><div><b>Not written:</b> ${esc(String(e))}
        ${done.length ? `<br>Already written before this: ${done.map((d) => esc(d.rel)).join(", ")}.` : ""}</div></div>`;
      if (btn) btn.remove();
      return;
    }
  }
  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const t = ctx.config.target;
  const wired = ctx.scan && ctx.scan.wiredIn && ctx.scan.wiredIn.length;
  const snippet = t.classFile && !wired ? wiringSnippet(ctx) : "";
  out.innerHTML = `
    <div class="block" style="margin-top:20px;border-left:2px solid var(--cat-ok)">
      <div class="lbl">Written at ${esc(time)}</div>
      ${done.map((d) => `<p class="small" style="margin:6px 0 0"><span class="proven">${esc(d.rel)}</span> - ${d.created ? "created" : "updated"}, ${d.bytes.toLocaleString()} bytes, in ${esc(d.project)}.<br><span class="path mono">${esc(d.path)}</span></p>`).join("")}
      <div class="lbl" style="margin-top:16px">Next</div>
      <ol class="steps">
        ${snippet ? `<li>Connect it once. Driver Config never edits your other files, so these lines are yours to paste:
          <pre class="code" id="wiring">${esc(snippet)}</pre><button class="btn tiny" data-copy="wiring" style="margin-top:6px">Copy</button></li>` : ""}
        ${t.constants && !t.classFile ? `<li>${esc(t.robotClass || "The robot")} already reads ${esc(t.constants.className)}; nothing to connect.</li>` : ""}
        <li>Build: in WPILib VS Code, <b>Build Robot Code</b> (or <span class="mono">./gradlew build</span>). A name that moved in your code fails here, not on the field.</li>
        <li>Deploy: <b>Deploy Robot Code</b> with the robot connected.</li>
        <li>Pick the driver on the dashboard's <b>Driver Profile</b> drop-down, while the robot is disabled. It starts on <b>${esc(ctx.config.defaultProfile)}</b>.</li>
        <li>Check it: <span class="mono">/Catalyst/DriverConfig/Sticks</span> shows what the sticks send, beside this page's live panel.</li>
      </ol>
    </div>`;
  if (btn) btn.remove();
  const close = dlg.querySelector("[data-apply=close]");
  if (close) close.textContent = "Done";
  ctx.onWritten(done);
}
