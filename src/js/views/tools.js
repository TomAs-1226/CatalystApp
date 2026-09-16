// The tools grid, and the card every other view uses to show one.
//
// The tools themselves are separate documents that belong to the library repo — the app only ships
// copies and opens them in a frame. Nothing here knows what any of them do.

import { $, invoke, IN_APP, svg } from "../core.js";
import { TOOLS } from "../data.js";
import { go } from "../app.js";

/** One card. `extra` lets a caller add a row that is not a tool, like the Console. */
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
  addConsoleCard(el);
}

/*
 * Catalyst Console is a separate binary bundled in as a resource, not a tool page, so its card
 * launches it rather than routing to a view.
 *
 * The card only appears if a console was actually bundled. The app and the console have separate
 * release cadences, so a build made before a console release will not have one, and a button that
 * says "not found" when you press it is worse than no button at all.
 */
export async function addConsoleCard(el) {
  if (!IN_APP) return;
  let available = false;
  try { available = await invoke("console_available"); } catch { return; }
  if (!available) return;

  const card = toolCard({
    id: "console",
    name: "Driver Console",
    desc: "The driver station dashboard: live telemetry, tuning, the field in 3D.",
    onClick: async (b) => {
      const name = b.querySelector(".card-btn__name");
      const was = name.textContent;
      b.style.pointerEvents = "none";
      try {
        await invoke("launch_console");
        // The console takes a moment to put a window up, and a card that looks inert in the meantime
        // reads as broken. It enforces its own single instance, so pressing again is harmless.
        name.textContent = "Opening…";
      } catch (e) {
        name.textContent = "Could not open";
        console.warn(e);
      }
      setTimeout(() => { name.textContent = was; b.style.pointerEvents = ""; }, 2200);
    },
  });
  el.appendChild(card);
}

export function init() {
  fillToolGrid($("#toolsList"));
}
