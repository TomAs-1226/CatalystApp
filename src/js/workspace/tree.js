// The project's files, one level at a time.
//
// Every level is a separate `ws_tree` call with depth 1, because a robot project contains a Gradle
// `build/` tree and walking one is how a file tree becomes a hang. The backend refuses to descend
// into those directories at all; this side never asks for more than the level it is about to draw.
//
// The rule this module is built around: never show a folder as empty unless the backend said it is.
// A directory that could not be read gets a row carrying the error text - a silently empty folder is
// the same picture as a genuinely empty one, and the difference is the entire question.
//
//   import { mountTree } from "./tree.js";
//   const tree = mountTree({ el, root: "C:/dev/Robot2027", onOpen: (path) => editor.openFile(path) });
//   tree.destroy();

/*
 * The classes and data attributes this draws, for the stylesheet:
 *
 *   .tree                     role="tree", the container; --tree-depth is set per row
 *   .tree-row                 one node; [data-kind="dir"|"file"], [aria-expanded], [data-active]
 *   .tree-twisty              the folder's disclosure marker (CSS draws it; rotate when expanded)
 *   .tree-glyph               a file's type letter; [data-type="java"|"json"|...] to colour it
 *   .tree-name                the file name
 *   .tree-note                a folder that is empty or being read - dim, not interactive
 *   .tree-error               a directory that could not be read; click retries
 *
 * No icon fonts and no SVG: a letter in a box is drawable in CSS, needs nothing vendored, and stays
 * legible at the one size this list uses.
 */

const TAURI = () => (typeof window === "undefined" ? null : window.__TAURI__ || null);

/** Type letters. Only the extensions a robot project actually contains earn an entry. */
const GLYPHS = {
  java: ["J", "java"],
  kt: ["K", "kotlin"],
  py: ["P", "python"],
  json: ["{", "json"],
  gradle: ["G", "gradle"],
  properties: ["=", "properties"],
  md: ["M", "markdown"],
  xml: ["X", "xml"],
  yml: ["Y", "yaml"],
  yaml: ["Y", "yaml"],
  js: ["S", "javascript"],
  mjs: ["S", "javascript"],
  ts: ["T", "typescript"],
  html: ["<", "html"],
  css: ["#", "css"],
  toml: ["T", "toml"],
  rs: ["R", "rust"],
  txt: ["T", "text"],
  csv: ["C", "text"],
  log: ["L", "log"],
  jar: ["A", "archive"],
  zip: ["A", "archive"],
  png: ["I", "image"],
  jpg: ["I", "image"],
  svg: ["I", "image"],
  chor: ["C", "choreo"],
  traj: ["C", "choreo"],
};

/**
 * The letter and type name for a file, for `.tree-glyph` and its `data-type`.
 *
 * Dotfiles are not extensions: `.gitignore` is a file called .gitignore, and reading "gitignore" as
 * its type would put a G in the box next to build.gradle's G.
 *
 * @param {string} name a file name, not a path
 * @returns {{glyph: string, type: string}}
 */
export function fileGlyph(name) {
  const n = String(name ?? "");
  const dot = n.lastIndexOf(".");
  if (dot <= 0 || dot === n.length - 1) return { glyph: "\u00b7", type: "plain" };
  const ext = n.slice(dot + 1).toLowerCase();
  const known = GLYPHS[ext];
  if (known) return { glyph: known[0], type: known[1] };
  return { glyph: ext[0].toUpperCase(), type: ext };
}

/**
 * The last segment of a path, with either separator. Used only for the root's own label; every other
 * row gets its name from the backend.
 *
 * @param {string} path
 * @returns {string}
 */
export function baseName(path) {
  const p = String(path ?? "").replace(/[\\/]+$/, "");
  const cut = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return cut === -1 ? p : p.slice(cut + 1);
}

/** Directories first, then by name, case-insensitively. Deterministic whatever the filesystem says. */
export function sortNodes(nodes) {
  return [...(nodes || [])].sort((a, b) => {
    if (!!a.dir !== !!b.dir) return a.dir ? -1 : 1;
    return String(a.name).localeCompare(String(b.name), undefined, { sensitivity: "base" });
  });
}

/**
 * Fold a freshly read level into what is already known about it.
 *
 * A refresh must not collapse the tree underneath it: a directory that is still there keeps the
 * children that were already read, so re-reading `src/` does not throw away everything the user had
 * opened below it. A directory that is gone takes its subtree with it.
 *
 * @param {Array|null} previous the children this directory had, or null
 * @param {Array} incoming what ws_tree just returned
 * @returns {Array} new node objects; nothing in `previous` or `incoming` is mutated
 */
export function mergeChildren(previous, incoming) {
  const before = new Map((previous || []).map((n) => [n.path, n]));
  return sortNodes(incoming).map((node) => {
    const old = before.get(node.path);
    const keepable = old && old.dir && node.dir && Array.isArray(old.children);
    return keepable ? { ...node, children: old.children } : { ...node, children: node.children || null };
  });
}

/**
 * The rows to draw, top to bottom - the same order the arrow keys move through.
 *
 * Pure: everything it needs is passed in, so the keyboard order can be checked without a DOM.
 *
 * @param {object} args
 * @param {object} args.root the root node, with children filled in as far as they have been read
 * @param {Set<string>} args.open paths of expanded directories
 * @param {Map<string,string>} [args.errors] path -> the message ws_tree returned
 * @param {Set<string>} [args.pending] paths currently being read
 * @returns {Array<{path: string, name: string, dir: boolean, depth: number, kind: string, message?: string}>}
 */
export function flattenTree({ root, open, errors, pending }) {
  const rows = [];
  const errs = errors || new Map();
  const busy = pending || new Set();

  const walk = (node, depth) => {
    rows.push({ path: node.path, name: node.name, dir: !!node.dir, depth, kind: "node" });
    if (!node.dir || !open.has(node.path)) return;

    const message = errs.get(node.path);
    if (message) {
      rows.push({ path: node.path, name: message, dir: false, depth: depth + 1, kind: "error", message });
      return;
    }
    if (!Array.isArray(node.children)) {
      if (busy.has(node.path)) rows.push({ path: node.path, name: "Reading\u2026", dir: false, depth: depth + 1, kind: "pending" });
      return;
    }
    if (!node.children.length) {
      rows.push({ path: node.path, name: "empty", dir: false, depth: depth + 1, kind: "empty" });
      return;
    }
    for (const child of node.children) walk(child, depth + 1);
  };

  walk(root, 0);
  return rows;
}

/**
 * Mount the file tree into `el`.
 *
 * @param {object} args
 * @param {HTMLElement} args.el
 * @param {string} args.root the project directory
 * @param {(path: string, node: object) => void} [args.onOpen] called when a file is activated
 * @returns {{destroy: () => void, refresh: (dir?: string) => Promise<void>, root: string}}
 */
export function mountTree({ el, root, onOpen }) {
  if (!el) throw new Error("mountTree needs an element");

  const rootNode = { name: baseName(root) || root, path: root, dir: true, children: null };
  const open = new Set();
  const errors = new Map();
  const pending = new Set();
  let rows = [];
  let active = 0;          // index into rows: the row the keyboard is on
  let destroyed = false;

  const list = document.createElement("div");
  list.className = "tree";
  list.setAttribute("role", "tree");
  list.tabIndex = 0;       // the tree owns one tab stop; rows take focus from it
  list.setAttribute("aria-label", "Project files");
  el.appendChild(list);

  // ---------- reading ----------

  const invoke = (cmd, args) => {
    const tauri = TAURI();
    if (!tauri) return Promise.reject(new Error("Reading files needs the desktop app."));
    return tauri.core.invoke(cmd, args);
  };

  const findNode = (path, node = rootNode) => {
    if (node.path === path) return node;
    if (!Array.isArray(node.children)) return null;
    for (const child of node.children) {
      const hit = findNode(path, child);
      if (hit) return hit;
    }
    return null;
  };

  async function load(path) {
    const node = findNode(path);
    if (!node || pending.has(path)) return;
    pending.add(path);
    errors.delete(path);
    render();
    try {
      const children = await invoke("ws_tree", { dir: path, depth: 1 });
      node.children = mergeChildren(node.children, children || []);
    } catch (e) {
      // The backend's Err string is the only thing that knows why - a permission denial and a
      // deleted folder look identical once the message is thrown away.
      errors.set(path, String(e && e.message ? e.message : e));
    } finally {
      pending.delete(path);
      if (!destroyed) render();
    }
  }

  // ---------- drawing ----------

  function row(entry, index) {
    const div = document.createElement("div");
    div.style.setProperty("--tree-depth", String(entry.depth));
    div.dataset.path = entry.path;

    if (entry.kind === "error") {
      div.className = "tree-error";
      div.setAttribute("role", "treeitem");
      div.setAttribute("aria-level", String(entry.depth + 1));
      div.title = "Click to try again";
      div.textContent = entry.message;
      return div;
    }
    if (entry.kind === "empty" || entry.kind === "pending") {
      div.className = "tree-note";
      div.setAttribute("role", "none");
      div.textContent = entry.name;
      return div;
    }

    div.className = "tree-row";
    div.setAttribute("role", "treeitem");
    div.setAttribute("aria-level", String(entry.depth + 1));
    div.dataset.kind = entry.dir ? "dir" : "file";
    div.tabIndex = index === active ? 0 : -1;
    if (index === active) div.dataset.active = "true";

    const mark = document.createElement("span");
    if (entry.dir) {
      div.setAttribute("aria-expanded", open.has(entry.path) ? "true" : "false");
      mark.className = "tree-twisty";
    } else {
      const { glyph, type } = fileGlyph(entry.name);
      mark.className = "tree-glyph";
      mark.dataset.type = type;
      mark.textContent = glyph;
    }
    mark.setAttribute("aria-hidden", "true");
    div.appendChild(mark);

    const name = document.createElement("span");
    name.className = "tree-name";
    name.textContent = entry.name;
    div.appendChild(name);
    return div;
  }

  /*
   * What was on screen before this draw, so that opening a folder can animate the rows it revealed
   * and nothing else.
   *
   * Every render rebuilds the whole list, so "new" cannot be read off the DOM — it has to be
   * remembered. `null` until the first draw has happened, which is what keeps the project's own
   * first read from arriving as a curtain of two hundred rows: the first list is not an arrival,
   * it is what was already there.
   *
   * Collapse is deliberately instant. The rows are gone from `list.children` the moment this runs,
   * and both `onClick` and the arrow keys find a row by its index in that list — holding dead rows
   * on screen to fade them would make those indices point at the wrong file for as long as the fade
   * lasted, and opening the wrong file is a worse bug than a fold that does not animate. The twisty
   * turns either way, so the direction is never in doubt.
   */
  let drawn = null;

  function render() {
    rows = flattenTree({ root: rootNode, open, errors, pending });
    if (active >= rows.length) active = rows.length - 1;
    if (active < 0) active = 0;
    // Keep the keyboard on a real row: a pending or empty note is not a place to stand.
    if (rows[active] && rows[active].kind !== "node") active = Math.max(0, nextNode(active, -1));

    const focused = list.contains(document.activeElement);
    const before = drawn;
    const now = new Set(rows.map((r) => `${r.kind} ${r.path}`));
    list.textContent = "";
    rows.forEach((entry, i) => {
      const el = row(entry, i);
      if (before && !before.has(`${entry.kind} ${entry.path}`)) el.classList.add("tree-row--in");
      list.appendChild(el);
    });
    drawn = now;
    if (focused) focusActive();
  }

  const nextNode = (from, step) => {
    for (let i = from + step; i >= 0 && i < rows.length; i += step) if (rows[i].kind === "node") return i;
    return from;
  };

  function focusActive() {
    const node = list.children[active];
    if (node && node.tabIndex === 0) node.focus({ preventScroll: false });
  }

  function setActive(index) {
    if (index === active || index < 0 || index >= rows.length) return;
    const previous = list.children[active];
    if (previous) { previous.tabIndex = -1; delete previous.dataset.active; }
    active = index;
    const current = list.children[active];
    if (current) { current.tabIndex = 0; current.dataset.active = "true"; }
    focusActive();
  }

  // ---------- acting ----------

  function toggle(path) {
    if (open.has(path)) {
      open.delete(path);
      // The children stay in memory on purpose: reopening a folder is instant, and the state it had
      // underneath comes back with it.
      render();
      return;
    }
    open.add(path);
    const node = findNode(path);
    if (node && !Array.isArray(node.children)) load(path);
    else render();
  }

  function activate(index) {
    const entry = rows[index];
    if (!entry || entry.kind !== "node") return;
    if (entry.dir) toggle(entry.path);
    else if (onOpen) onOpen(entry.path, findNode(entry.path) || entry);
  }

  function parentIndex(index) {
    const depth = rows[index].depth;
    for (let i = index - 1; i >= 0; i--) if (rows[i].kind === "node" && rows[i].depth < depth) return i;
    return index;
  }

  const onClick = (e) => {
    const errorRow = e.target.closest(".tree-error");
    if (errorRow) { load(errorRow.dataset.path); return; }
    const rowEl = e.target.closest(".tree-row");
    if (!rowEl) return;
    const index = [...list.children].indexOf(rowEl);
    if (index < 0) return;
    setActive(index);
    activate(index);
  };

  const onKeyDown = (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const entry = rows[active];
    switch (e.key) {
      case "ArrowDown": setActive(nextNode(active, 1)); break;
      case "ArrowUp": setActive(nextNode(active, -1)); break;
      case "ArrowRight":
        if (!entry || !entry.dir) return;
        if (!open.has(entry.path)) toggle(entry.path);
        else setActive(nextNode(active, 1));
        break;
      case "ArrowLeft":
        if (entry && entry.dir && open.has(entry.path)) toggle(entry.path);
        else setActive(parentIndex(active));
        break;
      case "Home": setActive(rows.findIndex((r) => r.kind === "node")); break;
      case "End": setActive(nextNode(rows.length, -1)); break;
      case "Enter":
      case " ": activate(active); break;
      default: return;
    }
    e.preventDefault();
  };

  // Focus arriving on the tree itself (a Tab from elsewhere) belongs on the active row.
  const onFocus = (e) => { if (e.target === list) focusActive(); };

  list.addEventListener("click", onClick);
  list.addEventListener("keydown", onKeyDown);
  list.addEventListener("focus", onFocus, true);

  open.add(root);
  render();
  load(root);

  return {
    root,
    /** Re-read a directory that is already open. Defaults to the project root. */
    async refresh(dir) {
      const path = dir || root;
      if (findNode(path)) await load(path);
    },
    destroy() {
      destroyed = true;
      list.removeEventListener("click", onClick);
      list.removeEventListener("keydown", onKeyDown);
      list.removeEventListener("focus", onFocus, true);
      list.remove();
    },
  };
}
