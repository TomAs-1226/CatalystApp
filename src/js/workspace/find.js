/**
 * Find in project.
 *
 * `ws_search` has existed since the workspace's first commit and nothing called it, which made the
 * workspace a place you could read one file at a time — fine for a file you already knew the name
 * of, useless for "where is the CAN id for the elevator". This is the pane that asks it.
 *
 * Deliberately literal and case-insensitive, the way the backend searches: a student looking for
 * `kElevatorId` should not have to know what a regular expression is, and a search box that
 * sometimes interprets its input is a search box nobody trusts.
 *
 *   mountFind({ el, dir, onOpen }) -> { destroy(), focus(), search(query) }
 *
 * `onOpen(path, line)` fires when a hit is clicked.
 */

import { escapeHtml, invoke } from "../core.js";

/** How long to wait after the last keystroke, ms. Long enough not to search a prefix of a word. */
const SETTLE_MS = 220;
/** The most hits worth having: past this, the answer is "narrow the search". */
const MAX_HITS = 200;

/** Hits grouped by the file they are in, because that is the unit somebody opens. */
export function groupByFile(hits) {
  const byFile = new Map();
  for (const hit of hits || []) {
    if (!byFile.has(hit.path)) byFile.set(hit.path, []);
    byFile.get(hit.path).push(hit);
  }
  return [...byFile.entries()].map(([path, rows]) => ({ path, rows }));
}

/** The path as it reads inside the project, which is the part anyone recognises. */
export function relativeTo(root, path) {
  const r = String(root || "").replace(/[\\/]+$/, "");
  const p = String(path || "");
  if (r && p.toLowerCase().startsWith(r.toLowerCase())) {
    return p.slice(r.length).replace(/^[\\/]+/, "");
  }
  return p;
}

/** One line of a hit, with the match marked. Escaped first: this is somebody's source code. */
export function markedLine(text, query) {
  const line = escapeHtml(String(text ?? "").trim().slice(0, 240));
  const needle = escapeHtml(String(query || ""));
  if (!needle) return line;
  const at = line.toLowerCase().indexOf(needle.toLowerCase());
  if (at < 0) return line;
  return `${line.slice(0, at)}<mark>${line.slice(at, at + needle.length)}</mark>${line.slice(at + needle.length)}`;
}

/** What to say about a result set, in words rather than a bare number. */
export function countNote(hits, capped) {
  // Not `!hits`: zero is a result, and "nothing" is the most useful thing this line ever says.
  if (hits === null || hits === undefined) return "";
  if (hits === 0) return "nothing";
  if (capped) return `first ${hits}`;
  return hits === 1 ? "1 hit" : `${hits} hits`;
}

export function mountFind({ el, dir, onOpen }) {
  el.innerHTML = `
    <div class="find">
      <div class="find__bar">
        <input class="cat-field find__q" type="search" placeholder="Find in project" aria-label="Find in project" />
        <span class="find__count"></span>
      </div>
      <div class="find__results" role="list"></div>
    </div>`;

  const input = el.querySelector(".find__q");
  const count = el.querySelector(".find__count");
  const results = el.querySelector(".find__results");
  let timer = 0;
  let run = 0;
  let destroyed = false;

  async function search(query) {
    const q = String(query || "").trim();
    if (!q) {
      results.innerHTML = "";
      count.textContent = "";
      return;
    }
    // Every search gets a number; only the newest one is allowed to draw, so a slow search for a
    // short prefix cannot overwrite the answer to what was typed after it.
    const mine = ++run;
    count.textContent = "searching…";
    let hits;
    try {
      hits = await invoke("ws_search", { dir, query: q, max: MAX_HITS });
    } catch (e) {
      if (destroyed || mine !== run) return;
      count.textContent = "";
      results.innerHTML = `<div class="find__error">${escapeHtml(String(e))}</div>`;
      return;
    }
    if (destroyed || mine !== run) return;

    count.textContent = countNote(hits.length, hits.length >= MAX_HITS);
    results.innerHTML = groupByFile(hits).map((group) => `
      <div class="find__file">
        <div class="find__path">${escapeHtml(relativeTo(dir, group.path))}<span class="find__n">${group.rows.length}</span></div>
        ${group.rows.map((row) => `
          <button class="find__hit" role="listitem" data-path="${escapeHtml(row.path)}" data-line="${row.line}">
            <span class="find__line">${row.line}</span>
            <span class="find__text">${markedLine(row.text, q)}</span>
          </button>`).join("")}
      </div>`).join("");

    results.querySelectorAll(".find__hit").forEach((b) => {
      b.onclick = () => onOpen?.(b.dataset.path, Number(b.dataset.line));
    });
  }

  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => search(input.value), SETTLE_MS);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { clearTimeout(timer); search(input.value); }
    if (e.key === "Escape") { input.value = ""; search(""); }
  });

  return {
    destroy() { destroyed = true; clearTimeout(timer); el.innerHTML = ""; },
    focus() { input.focus(); input.select(); },
    search(query) { input.value = query; return search(query); },
  };
}
