// Home: what this app is, the projects you were last in, and every tool.
//
// The three things a team does most are a button each, in the order they happen: open a project,
// install the library into one, and see which version that is.

import { $, IN_APP, invoke, settings, svg, escapeHtml } from "../core.js";
import { LIB_VERSION } from "../data.js";
import { go, project } from "../app.js";
import { fillToolGrid, toolCard } from "./tools.js";

export function init() {
  $("#homeOpenBtn").innerHTML = `${svg("workspace")} Open a robot project`;
  $("#homeInstallBtn").innerHTML = `${svg("install")} Install Catalyst into a project`;
  $("#homeVersion").textContent = LIB_VERSION;
  $("#homeOpenBtn").onclick = () => go("workspace");
  fillToolGrid($("#homeList"));
  document.addEventListener("catalyst:project", renderRecent);
}

export function activate() {
  renderRecent();
}

/*
 * Recent projects come from the registry when there is one, because that is the list the MCP server
 * and the workspace already agree on. localStorage keeps only the order they were last opened in —
 * two copies of the same fact is how the old list drifted from the registry.
 */
async function renderRecent() {
  const wrap = $("#recentWrap");
  const list = $("#recentList");
  if (!IN_APP) { wrap.hidden = true; return; }

  let projects = [];
  try { projects = await invoke("list_projects"); } catch (_) { wrap.hidden = true; return; }
  if (!projects.length) { wrap.hidden = true; return; }

  let order = [];
  try { order = JSON.parse(settings.get("recentOrder", "[]")); } catch (_) { /* unordered is fine */ }
  projects.sort((a, b) => {
    const ia = order.indexOf(a.path), ib = order.indexOf(b.path);
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
  });

  wrap.hidden = false;
  list.innerHTML = "";
  for (const p of projects.slice(0, 6)) {
    const meta = [
      p.catalyst_version ? "Catalyst v" + p.catalyst_version : "no Catalyst vendordep",
      p.year ? "WPILib " + p.year : null,
    ].filter(Boolean).join(" · ");
    list.appendChild(toolCard({
      id: "folder",
      icon: "folder",
      name: escapeHtml(p.name),
      desc: escapeHtml(meta),
      onClick: () => {
        const next = [p.path, ...order.filter((x) => x !== p.path)].slice(0, 6);
        settings.set("recentOrder", JSON.stringify(next));
        project.set({ name: p.name, path: p.path });
        go("workspace");
      },
    }));
  }
}
