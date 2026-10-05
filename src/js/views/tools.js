// The tools grid, and the card every other view uses to show one.
//
// The tools themselves are separate documents that belong to the library repo — the app only ships
// copies and opens them in a frame. Nothing here knows what any of them do.

import { $, invoke, IN_APP, svg, escapeHtml } from "../core.js";
import { TOOLS } from "../data.js";
import { go } from "../app.js";

/** One card. A caller can pass `onClick` for a row that is not a tool, like another Catalyst app. */
export function toolCard({ id, name, desc, icon, onClick, go: target }) {
  const b = document.createElement("button");
  b.className = "card-btn";
  b.innerHTML = `<span class="card-btn__ico">${svg(icon || id)}</span>
    <span><span class="card-btn__name">${name}</span><span class="card-btn__desc">${desc}</span></span>`;
  if (onClick) b.onclick = () => onClick(b);
  else if (target) b.onclick = () => go(target);
  return b;
}

export function fillToolGrid(el) {
  el.innerHTML = "";
  for (const t of TOOLS) el.appendChild(toolCard({ ...t, go: `tool/${t.id}` }));
}

/*
 * The other Catalyst apps are separate programs, not tool pages, so their cards start them rather
 * than routing to a view.
 *
 * Only what can be started is listed: the backend returns the apps that are installed on this
 * machine (and the console bundled into this build, when there is one). A card that says "not
 * installed" when you press it is worse than no card, and Catalyst Setup is where a team sees what
 * it does not have yet. With nothing to show, the whole section stays hidden.
 */
const APPS = {
  console: { icon: "console", desc: "The driver station dashboard: live telemetry, tuning, the field in 3D." },
  pit: { icon: "pit", desc: "Match day in the pit: the pre-match checklist, batteries, the queue and the match log." },
  sim: { icon: "sim", desc: "Driver practice on the field, with the robot's own controls and a defender." },
  link: { icon: "tablet", desc: "The Tab5's companion on this computer." },
};

export async function fillAppGrid(wrap, el) {
  if (!IN_APP) return;
  let apps = [];
  try { apps = await invoke("suite_apps"); } catch { return; }
  apps = apps.filter((a) => APPS[a.id]);
  if (!apps.length) return;

  el.innerHTML = "";
  for (const a of apps) {
    const card = toolCard({
      id: a.id,
      icon: APPS[a.id].icon,
      name: escapeHtml(a.name),
      desc: APPS[a.id].desc,
      onClick: async (b) => {
        const name = b.querySelector(".card-btn__name");
        const was = name.textContent;
        b.style.pointerEvents = "none";
        try {
          await invoke("launch_suite_app", { id: a.id });
          // An app takes a moment to put a window up, and a card that looks inert in the meantime
          // reads as broken. The apps enforce their own single instance, so pressing again is harmless.
          name.textContent = "Opening…";
        } catch (e) {
          name.textContent = "Could not open";
          console.warn(e);
        }
        setTimeout(() => { name.textContent = was; b.style.pointerEvents = ""; }, 2200);
      },
    });
    if (a.version) card.title = `${a.name} ${a.version}`;
    el.appendChild(card);
  }
  wrap.hidden = false;
}

export function init() {
  fillToolGrid($("#toolsList"));
  fillAppGrid($("#toolsAppsWrap"), $("#toolsApps"));
}
