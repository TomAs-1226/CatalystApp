// The code editor: Monaco, loaded from src/vendor/, themed from the identity's tokens.
//
// Monaco is vendored rather than installed, and loaded through its own AMD loader rather than as an
// ES module, because this frontend has no bundler and the CSP is `script-src 'self'`: the ESM build
// is thousands of files that only a bundler can assemble, while `min/vs` is a bundle that a plain
// <script src> can start. `npm run vendor` is what puts it there.
//
// Web workers are off. The CSP has no `worker-src`, and monaco's own editor.main.js starts its
// workers from blob: URLs, which such a policy blocks. So every editor option whose work happens in
// a worker is disabled below, deliberately and by name. Syntax highlighting is Monarch and runs
// in-thread, which is the part that matters for reading robot code.
//
// What that costs, and what this module puts back. Without a worker there is no language service,
// so monaco's own Go to Symbol has nothing to list: `editor.action.quickOutline` is gated on
// `hasDocumentSymbolProvider`, and for Java no provider exists at all. This file registers its own,
// built from regular expressions and run in-thread, for the languages a robot project is made of.
// The same applies to folding, which is pinned to the indentation strategy rather than to a
// provider that would ask for a worker.
//
//   import { mountEditor } from "./editor.js";
//   const editor = mountEditor({ el, root: "C:/dev/Robot2027" });
//   await editor.openFile("C:/dev/Robot2027/src/main/java/frc/robot/Robot.java");
//   editor.onDirty(({ dirtyPaths }) => ...);

import { cssToken, hexToken } from "../theme.js";
import { settings } from "../core.js";

/*
 * The classes this draws, for the stylesheet:
 *
 *   .ed              the pane
 *   .ed-tabbar       the strip's frame; [data-overflow="none|start|end|both"] draws the edge fades
 *   .ed-tabs         role="tablist"; .ed-tab [data-active] [data-dirty] [data-confirm], .ed-dot, .ed-close
 *   .ed-message      role="status"; [data-tone="bad"] when it carries an error
 *   .ed-host         the element Monaco owns - nothing else may write into it
 *   .ed-empty        the panel shown in place of Monaco when no file is open
 *   .ed-status       the bar under the editor; .ed-status__path, __item, __mark
 *
 * src/styles/app.css carries the ones that existed before this file grew a status bar; the rest,
 * and every rule that has to reach inside Monaco's own DOM, are in src/styles/editor.css, which is
 * injected below because index.html belongs to the shell.
 */

// Document-relative, and it has to stay that way: monaco resolves its own nested modules and its
// worker assets against this, and against document.baseURI. index.html is at src/, so this is
// src/vendor/monaco/vs. The contract fixes the path; do not make it clever.
const VS_PATH = "vendor/monaco/vs";

// This module's own stylesheet, injected rather than assumed: index.html is the shell's file and
// cannot be edited from here. Same id check the terminal pane uses, so two mounts link it once.
const EDITOR_STYLES = "../../styles/editor.css";

// How long a dirty tab stays armed after the first close press. Long enough to read the sentence
// the message line prints, short enough that the arming cannot be forgotten and fire later.
const CONFIRM_MS = 4000;

/*
 * Files an editor should not try to open.
 *
 * A project tree lists everything in it, and a robot project is full of things that are not text: a
 * Gradle wrapper jar, the icons, a .glb of the field. Handing one to `ws_read` gets back a refusal
 * written for someone who typed a path — "is not UTF-8 text, so the editor cannot open it safely" —
 * and it lands in red, which says the person did something wrong by clicking a file that was offered
 * to them. Recognising them here costs one lookup and answers with what the file is instead.
 */
const BINARY_EXT = new Set([
  "jar", "class", "zip", "gz", "tgz", "7z", "rar", "exe", "dll", "so", "dylib", "bin", "o", "obj",
  "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "tiff", "svgz",
  "pdf", "glb", "gltf", "fbx", "stl", "step", "stp", "3mf", "blend",
  "mp3", "mp4", "wav", "ogg", "mov", "avi", "webm",
  "ttf", "otf", "woff", "woff2", "eot",
  "wpilog", "dslog", "dsevents", "hprof", "db", "sqlite", "pyc", "wasm",
]);

/** Whether a path is something the editor should decline before asking the backend to read it. */
export function isBinaryPath(path) {
  const name = String(path || "").split(/[\\/]/).pop() || "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  return BINARY_EXT.has(name.slice(dot + 1).toLowerCase());
}

/** What to say about a file the editor will not open. One sentence, no blame. */
export function binaryNote(path) {
  const name = String(path || "").split(/[\\/]/).pop() || "this file";
  return `${name} is a binary file. The editor opens text.`;
}

const TAURI = () => (typeof window === "undefined" ? null : window.__TAURI__ || null);

const pathParts = (p) => String(p ?? "").split(/[\\/]+/).filter(Boolean);

/**
 * The file name a tab shows.
 *
 * @param {string} path
 * @returns {string}
 */
export function tabTitle(path) {
  const parts = pathParts(path);
  return parts.length ? parts[parts.length - 1] : String(path ?? "");
}

/**
 * Titles for a set of open files, made distinct.
 *
 * A robot project has several files called Robot.java, Constants.java or build.gradle, and a row of
 * tabs that all say build.gradle tells you nothing about which one you are about to overwrite. Each
 * colliding tab takes as many parent segments as it needs, up to three, which is where the label
 * stops being readable and the tooltip takes over.
 *
 * @param {string[]} paths
 * @returns {string[]} one label per path, in the same order
 */
export function tabLabels(paths) {
  const all = paths.map(pathParts);
  return all.map((parts, i) => {
    const limit = Math.min(parts.length, 3);
    for (let take = 1; ; take++) {
      const label = parts.slice(-take).join("/");
      const clash = all.some((other, j) => j !== i && other.slice(-take).join("/") === label);
      if (!clash || take >= limit) return label || String(paths[i] ?? "");
    }
  });
}

/**
 * Where a file sits inside the project, for the status bar.
 *
 * A status bar that prints `C:\Users\yu_th\dev\Robot2027\src\main\java\frc\robot\Robot.java` has
 * spent its whole width on the part that never changes. Inside the project the answer is the tail;
 * outside it — a file opened from a search hit in another folder — it is the whole path, because
 * that is exactly the case where the whole path is the interesting fact.
 *
 * Segments compare without case: on Windows `c:\dev\robot` and `C:\Dev\Robot` are one folder, and a
 * comparison that says otherwise prints an absolute path for every file in the project.
 *
 * @param {string} root the project directory
 * @param {string} path
 * @returns {string} forward-slashed, relative when it can be
 */
export function relativePath(root, path) {
  const file = pathParts(path);
  const base = pathParts(root);
  const whole = file.join("/") || String(path ?? "");
  if (!base.length || base.length >= file.length) return whole;
  for (let i = 0; i < base.length; i++) {
    if (base[i].toLowerCase() !== file[i].toLowerCase()) return whole;
  }
  return file.slice(base.length).join("/");
}

/**
 * The @-mention Claude Code reads for a file, or for lines of it: `@src/Robot.java#L10-20 `.
 *
 * It is the form Claude Code's own editor integrations insert, so the session resolves it the way it
 * would from an IDE. Project-relative, because the session runs in the project directory and an
 * absolute Windows path is both longer and a second way of naming the same file.
 *
 * A selection dragged to the start of the next line has not selected anything on that line, and
 * counting it would name a line the question is not about. An empty selection is the file.
 *
 * @param {string} root the project directory
 * @param {string} path the file
 * @param {{startLineNumber, startColumn, endLineNumber, endColumn}|null} [sel] Monaco's selection
 */
export function mentionFor(root, path, sel) {
  const rel = relativePath(root, path);
  if (!sel) return `@${rel} `;
  const { startLineNumber: a, startColumn: ac, endLineNumber: b, endColumn: bc } = sel;
  if (a === b && ac === bc) return `@${rel} `;
  const end = b > a && bc === 1 ? b - 1 : b;
  return end > a ? `@${rel}#L${a}-${end} ` : `@${rel}#L${a} `;
}

/**
 * A path split where the status bar can let it give way.
 *
 * The folders are the part that can be dropped when the pane is narrow; the file name is the part
 * that must never be, and plain `text-overflow: ellipsis` drops exactly the wrong one. So they are
 * two elements and only one of them is allowed to shrink.
 *
 * @param {string} path forward-slashed, as `relativePath` returns it
 * @returns {{dir: string, name: string}} `dir` keeps its trailing slash, or is empty
 */
export function splitPath(path) {
  const text = String(path ?? "");
  const cut = text.lastIndexOf("/");
  return cut < 0 ? { dir: "", name: text } : { dir: text.slice(0, cut + 1), name: text.slice(cut + 1) };
}

/**
 * The indentation a file is already written in.
 *
 * Nothing else decides this: a robot project holds 4-space Java beside 2-space JSON beside a
 * tab-indented Makefile, and an editor that inserts its own preference into whichever one is open
 * produces a diff where every line moved. The status bar prints the answer so it can be checked at
 * a glance, and the model is set to it so typing agrees with the file.
 *
 * The vote is on the *step* between one line's indent and the next, not on the indents themselves:
 * a deeply nested Java file is full of leading runs of 8, 12 and 16 spaces, all of which are 4.
 *
 * @param {string} text
 * @returns {{insertSpaces: boolean, size: number}}
 */
export function detectIndent(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const votes = new Map();
  let tabbed = 0;
  let spaced = 0;
  let previous = 0;
  let previousWasSpaces = false;

  for (const line of lines) {
    if (!line.trim()) continue;
    const lead = /^[ \t]*/.exec(line)[0];
    if (lead.includes("\t")) {
      tabbed++;
      previousWasSpaces = false;
      continue;
    }
    const width = lead.length;
    if (width > 0) spaced++;
    if (previousWasSpaces) {
      const step = Math.abs(width - previous);
      if (step >= 1 && step <= 8) votes.set(step, (votes.get(step) || 0) + 1);
    }
    previous = width;
    previousWasSpaces = true;
  }

  // Four spaces is the fallback in both branches because it is what every WPILib and Gradle
  // template writes, so it is the value that changes the fewest files when nothing can be told.
  if (tabbed > spaced) return { insertSpaces: false, size: 4 };

  let best = 0;
  let bestCount = 0;
  for (const [step, count] of votes) {
    // A tie goes to the wider step: a file indented by 4 also produces a handful of 2s from wrapped
    // argument lists, and picking 2 there would re-indent the whole file on the first edit.
    if (count > bestCount || (count === bestCount && step > best)) { best = step; bestCount = count; }
  }
  return { insertSpaces: true, size: best || 4 };
}

/** How the status bar prints what `detectIndent` found. */
export function indentLabel(indent) {
  if (!indent) return "";
  return indent.insertSpaces ? `Spaces: ${indent.size}` : "Tabs";
}

/*
 * Monaco's language ids are lower-case identifiers; these are the names a person uses for them.
 * Only the languages `language_for` in src-tauri/src/workspace.rs can return need an entry - the
 * rest fall through to a capitalised id, which is right for `rust` and harmless for anything else.
 */
const LANGUAGE_NAMES = {
  java: "Java", kotlin: "Kotlin", json: "JSON", groovy: "Groovy", markdown: "Markdown",
  xml: "XML", python: "Python", javascript: "JavaScript", typescript: "TypeScript",
  toml: "TOML", ini: "INI", yaml: "YAML", plaintext: "Plain text", shell: "Shell",
  bat: "Batch", css: "CSS", html: "HTML", sql: "SQL", cpp: "C++", csharp: "C#",
};

/** The language name the status bar prints. */
export function languageLabel(id) {
  const key = String(id || "").trim();
  if (!key) return "Plain text";
  return LANGUAGE_NAMES[key] || key[0].toUpperCase() + key.slice(1);
}

/** What the status bar says about where the caret is, and how much is selected. */
export function cursorLabel(line, column, selected) {
  const base = `Ln ${line}, Col ${column}`;
  if (!selected || !selected.chars) return base;
  if (selected.lines > 1) return `${base} · ${selected.lines} lines selected`;
  return `${base} · ${selected.chars} selected`;
}

/**
 * Where Ctrl+Tab lands.
 *
 * `order` is most-recently-used first, so `order[0]` is the file on screen and one press is
 * `order[1]` — the file you were in before this one, which is the whole point of the shortcut.
 * Pressing past either end wraps rather than stopping, because a held Ctrl with repeated Tab is one
 * gesture and it should not silently do nothing halfway through.
 *
 * @param {string[]} order
 * @param {number} steps how many presses; negative for Ctrl+Shift+Tab
 * @returns {string|null}
 */
export function mruStep(order, steps) {
  if (!Array.isArray(order) || !order.length) return null;
  const n = order.length;
  const at = (((Math.trunc(steps) % n) + n) % n);
  return order[at];
}

// ---------- the outline ----------

/*
 * Go to Symbol, without a language service.
 *
 * These are regular expressions, and they are wrong in the ways regular expressions are wrong about
 * a nested language: a method signature broken across two lines is missed, and a string containing
 * `class Foo` is found. That trade is deliberate. The alternative is no outline at all, because the
 * only parser monaco ships for Java is none, and the four languages it does parse do it in a worker
 * this app cannot start. A list that finds 95% of a robot project's methods is worth having; a
 * wrong entry costs one keystroke to skip past.
 *
 * Kinds are strings rather than monaco's SymbolKind enum so this function stays testable under
 * `node --test`; `symbolKind` below turns one into the other.
 */

/** Words that begin a statement, so they are never a declaration however much they look like one. */
const NOT_A_NAME = new Set([
  "if", "for", "while", "switch", "catch", "return", "new", "do", "else", "try", "finally",
  "synchronized", "assert", "super", "this", "case", "throw", "throws", "yield", "instanceof",
  "import", "package", "break", "continue",
]);

const JAVA_MODIFIER = "public|protected|private|static|final|abstract|synchronized|native|default|strictfp|transient|volatile|sealed|non-sealed";
const JAVA_TYPE_DECL = new RegExp(
  `^[ \\t]*(?:(?:${JAVA_MODIFIER})[ \\t]+)*(class|interface|enum|record|@interface)[ \\t]+([A-Za-z_$][\\w$]*)`);
const JAVA_CALLABLE = new RegExp(
  `^[ \\t]*(?:@[\\w$.]+(?:\\([^)]*\\))?[ \\t]*)*((?:(?:${JAVA_MODIFIER})[ \\t]+)*)` +
  `(?:<[^>]*>[ \\t]*)?(?:([\\w$.<>,?\\[\\]]+)[ \\t]+)?([A-Za-z_$][\\w$]*)[ \\t]*\\(`);
const JAVA_FIELD = new RegExp(
  `^[ \\t]*((?:(?:${JAVA_MODIFIER})[ \\t]+)+)([\\w$.<>,?\\[\\]]+)[ \\t]+([A-Za-z_$][\\w$]*)[ \\t]*[=;]`);

const KOTLIN_DECL = /^[ \t]*(?:(?:public|private|internal|protected|open|final|abstract|override|inline|suspend|data|sealed|companion|lateinit|const)[ \t]+)*(class|object|interface|enum class|fun|val|var)[ \t]+([A-Za-z_][\w]*)/;
const GROOVY_BLOCK = /^([ \t]*)([A-Za-z_][\w.]*)[ \t]*(?:\([^)]*\))?[ \t]*\{[ \t]*$/;
const GROOVY_DEF = /^[ \t]*(?:def|task)[ \t]+([A-Za-z_][\w]*)/;
const PYTHON_DECL = /^([ \t]*)(def|class)[ \t]+([A-Za-z_]\w*)/;
const MARKDOWN_HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*#*$/;
const JS_DECL = /^[ \t]*(?:export[ \t]+)?(?:default[ \t]+)?(?:async[ \t]+)?(class|function|const|let|var)[ \t]+([A-Za-z_$][\w$]*)/;
const JS_METHOD = /^[ \t]+(?:(?:static|async|get|set)[ \t]+)*([A-Za-z_$][\w$]*)[ \t]*\([^)]*\)[ \t]*\{/;

/**
 * The symbols in a file, for Go to Symbol and for anything else that wants an outline.
 *
 * @param {string} language a monaco language id
 * @param {string} text
 * @returns {{name: string, detail: string, kind: string, line: number}[]} 1-based line numbers
 */
export function outlineSymbols(language, text) {
  const lang = String(language || "").toLowerCase();
  const lines = String(text ?? "").split(/\r?\n/);
  const out = [];
  const push = (name, kind, detail, line) => out.push({ name, kind, detail: detail || "", line });

  if (lang === "java" || lang === "csharp") {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const type = JAVA_TYPE_DECL.exec(line);
      if (type) {
        const kind = { class: "class", record: "class", interface: "interface", "@interface": "interface", enum: "enum" }[type[1]] || "class";
        push(type[2], kind, type[1], i + 1);
        continue;
      }
      const callable = JAVA_CALLABLE.exec(line);
      if (callable) {
        const [, mods, returns, name] = callable;
        // A line needs either a modifier or a return type to be a declaration. Without that rule
        // every `drive.andThen(shoot)` in the file becomes a method called andThen.
        if (!NOT_A_NAME.has(name) && !NOT_A_NAME.has(String(returns || "")) && (mods.trim() || returns)) {
          push(name, returns ? "method" : "constructor", returns || "", i + 1);
          continue;
        }
      }
      const field = JAVA_FIELD.exec(line);
      if (field) {
        const [, mods, type2, name] = field;
        const constant = /\bstatic\b/.test(mods) && /\bfinal\b/.test(mods);
        push(name, constant ? "constant" : "field", type2, i + 1);
      }
    }
    return out;
  }

  if (lang === "kotlin") {
    for (let i = 0; i < lines.length; i++) {
      const m = KOTLIN_DECL.exec(lines[i]);
      if (!m) continue;
      const kind = { class: "class", "enum class": "enum", object: "class", interface: "interface", fun: "method", val: "constant", var: "field" }[m[1]] || "field";
      push(m[2], kind, m[1], i + 1);
    }
    return out;
  }

  if (lang === "groovy") {
    // build.gradle is a tree of named blocks — dependencies, repositories, frc, deploy — and
    // getting to one of them is the whole of navigating a Gradle file.
    for (let i = 0; i < lines.length; i++) {
      const block = GROOVY_BLOCK.exec(lines[i]);
      if (block && !NOT_A_NAME.has(block[2])) { push(block[2], "namespace", "block", i + 1); continue; }
      const def = GROOVY_DEF.exec(lines[i]);
      if (def) push(def[1], "function", "def", i + 1);
    }
    return out;
  }

  if (lang === "python") {
    for (let i = 0; i < lines.length; i++) {
      const m = PYTHON_DECL.exec(lines[i]);
      if (!m) continue;
      push(m[3], m[2] === "class" ? "class" : "function", m[2], i + 1);
    }
    return out;
  }

  if (lang === "markdown") {
    for (let i = 0; i < lines.length; i++) {
      const m = MARKDOWN_HEADING.exec(lines[i]);
      if (m) push(m[2], "heading", "#".repeat(m[1].length), i + 1);
    }
    return out;
  }

  if (lang === "json") {
    // The keys of the top-level object, which for a vendordep is its whole shape: name, version,
    // frcYear, javaDependencies. Nesting is skipped on purpose - a Choreo path has thousands of
    // numbers in it and none of them is a place anyone navigates to.
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const startDepth = depth;
      for (let c = 0; c < line.length; c++) {
        const ch = line[c];
        if (inString) {
          if (escaped) escaped = false;
          else if (ch === "\\") escaped = true;
          else if (ch === '"') inString = false;
          continue;
        }
        if (ch === '"') inString = true;
        else if (ch === "{" || ch === "[") depth++;
        else if (ch === "}" || ch === "]") depth--;
      }
      if (startDepth !== 1) continue;
      const key = /^[ \t]*"((?:[^"\\]|\\.)*)"[ \t]*:/.exec(line);
      if (key) push(key[1], "key", "", i + 1);
    }
    return out;
  }

  if (lang === "javascript" || lang === "typescript") {
    for (let i = 0; i < lines.length; i++) {
      const decl = JS_DECL.exec(lines[i]);
      if (decl) {
        const kind = decl[1] === "class" ? "class" : decl[1] === "function" ? "function"
          : /=>|\bfunction\b/.test(lines[i]) ? "function" : "constant";
        push(decl[2], kind, decl[1], i + 1);
        continue;
      }
      const method = JS_METHOD.exec(lines[i]);
      if (method && !NOT_A_NAME.has(method[1])) push(method[1], "method", "", i + 1);
    }
    return out;
  }

  return out;
}

/** The languages `outlineSymbols` can actually say something about. */
export const OUTLINE_LANGUAGES = [
  "java", "csharp", "kotlin", "groovy", "python", "markdown", "json", "javascript", "typescript",
];

/** A kind name from `outlineSymbols`, as monaco's SymbolKind. Unknown kinds land on Field. */
function symbolKind(monaco, kind) {
  const K = monaco.languages.SymbolKind;
  const map = {
    class: K.Class, interface: K.Interface, enum: K.Enum, method: K.Method,
    constructor: K.Constructor, field: K.Field, constant: K.Constant, function: K.Function,
    namespace: K.Namespace, key: K.Key, heading: K.String,
  };
  return map[kind] === undefined ? K.Field : map[kind];
}

/**
 * Which files have unsaved edits.
 *
 * Monaco's alternative version id is the right thing to compare against, not a boolean set on the
 * first keystroke: it returns to its earlier value when the user undoes back to the saved text, so
 * typing a character and undoing it leaves the file clean, as it actually is.
 *
 * @returns {{track: Function, forget: Function, isDirty: Function, knows: Function, paths: Function}}
 */
export function createDirtyTracker() {
  const saved = new Map();
  return {
    /** Record the version that is on disk - on open, and again after every successful write. */
    track(path, versionId) { saved.set(path, versionId); },
    forget(path) { saved.delete(path); },
    knows(path) { return saved.has(path); },
    isDirty(path, versionId) { return saved.has(path) && saved.get(path) !== versionId; },
    paths() { return [...saved.keys()]; },
  };
}

// ---------- loading monaco ----------

let monacoPromise = null;

/*
 * No web workers, and no exceptions from asking for one.
 *
 * The rule is the CSP: `script-src 'self'` with no `worker-src`, and monaco starts its workers from
 * blob: URLs, which such a policy blocks. The contract's line for that is
 * `getWorker: () => null`, and it does stop every worker - but monaco does not check the return
 * value. Measured against the vendored 0.56.0: opening a .json file (also .css, .html, .ts - the
 * four languages that have a language service) throws five uncaught errors,
 * "FAILED to post message to worker" among them, because those modes ask for a worker the moment a
 * model of theirs is created. Highlighting, editing and saving are unaffected; the console is not.
 *
 * So this returns a worker-shaped object that starts nothing and answers nothing. No Worker is
 * constructed, which is the whole point of the rule, and the language service simply waits forever
 * for a reply that never comes - which is what "no language service" means here. With it, opening
 * the same .json file logs nothing at all.
 */
const deadWorker = () => ({
  postMessage() {}, terminate() {}, addEventListener() {}, removeEventListener() {},
  onmessage: null, onerror: null, onmessageerror: null,
});

/*
 * A reply that never comes is quiet, but it is not free: monaco's document-symbol registry waits on
 * every provider before the Go to Symbol list can open, so one worker-backed provider on a .json
 * file is a quick-open box that spins for ever. These four modes are the ones that have a language
 * service at all, and every feature of theirs listed here is worker-bound. Tokenisation is not: for
 * json it is jsonc-parser running in-thread, which is the colouring a vendordep actually needs.
 */
const DEAD_MODE = {
  documentFormattingEdits: false, documentRangeFormattingEdits: false, completionItems: false,
  hovers: false, documentSymbols: false, colors: false, foldingRanges: false, diagnostics: false,
  selectionRanges: false, tokens: true,
};

function silenceLanguageServices(monaco) {
  const defaults = [
    monaco.languages.json && monaco.languages.json.jsonDefaults,
    monaco.languages.css && monaco.languages.css.cssDefaults,
    monaco.languages.css && monaco.languages.css.scssDefaults,
    monaco.languages.css && monaco.languages.css.lessDefaults,
    monaco.languages.html && monaco.languages.html.htmlDefaults,
  ];
  for (const d of defaults) {
    // Each mode has its own extra keys; spreading what it already holds keeps them.
    try { d?.setModeConfiguration({ ...d.modeConfiguration, ...DEAD_MODE }); } catch (_) { /* older build */ }
  }
  // TypeScript's defaults are a different shape and its only in-thread piece is the Monarch
  // grammar, which `setModeConfiguration` does not gate. Everything it offers needs the worker.
  for (const d of [monaco.languages.typescript?.typescriptDefaults, monaco.languages.typescript?.javascriptDefaults]) {
    try {
      d?.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: true, noSuggestionDiagnostics: true });
    } catch (_) { /* older build */ }
  }
}

/** Link this module's stylesheet once, however many editors mount. */
function ensureStylesheet(id, href) {
  if (typeof document === "undefined" || document.getElementById(id)) return;
  const link = document.createElement("link");
  link.id = id;
  link.rel = "stylesheet";
  link.href = new URL(href, import.meta.url).href;
  document.head.appendChild(link);
}

/** Load monaco once per window, whatever mounts and unmounts. Resolves to the monaco namespace. */
function loadMonaco() {
  if (monacoPromise) return monacoPromise;
  monacoPromise = new Promise((resolve, reject) => {
    // Set before the loader runs. It does not survive on its own: monaco's editor.main.js assigns
    // its own MonacoEnvironment with blob-URL workers while it evaluates, so this is set again
    // below, after the module has loaded. Ours has to be the one that is left.
    self.MonacoEnvironment = { getWorker: deadWorker };

    const script = document.createElement("script");
    script.src = `${VS_PATH}/loader.js`;
    script.onerror = () => reject(new Error(
      `Monaco is not vendored: ${VS_PATH}/loader.js did not load. Run \`npm run vendor\`.`));
    script.onload = () => {
      // The AMD loader's own globals. They are the loader's, not this app's, and nothing outside
      // this function touches them.
      const amdRequire = window.require;
      if (typeof amdRequire !== "function") {
        reject(new Error("Monaco's loader did not define require - the vendored copy is damaged."));
        return;
      }
      amdRequire.config({ paths: { vs: VS_PATH } });
      amdRequire(["vs/editor/editor.main"], () => {
        self.MonacoEnvironment = { getWorker: deadWorker };
        if (!window.monaco) { reject(new Error("Monaco loaded but defined no editor API.")); return; }
        silenceLanguageServices(window.monaco);
        registerOutline(window.monaco);
        resolve(window.monaco);
      }, (err) => reject(err instanceof Error ? err : new Error(String((err && err.message) || err))));
    };
    document.head.appendChild(script);
  });
  return monacoPromise;
}

let outlineRegistered = false;

/** The in-thread document symbol provider that makes Ctrl+Shift+O say anything at all. */
function registerOutline(monaco) {
  if (outlineRegistered) return;
  outlineRegistered = true;
  monaco.languages.registerDocumentSymbolProvider(OUTLINE_LANGUAGES, {
    displayName: "Catalyst outline",
    provideDocumentSymbols(model) {
      const language = model.getLanguageId();
      const found = outlineSymbols(language, model.getValue());
      return found.map((s) => {
        const text = model.getLineContent(s.line);
        const range = { startLineNumber: s.line, startColumn: 1, endLineNumber: s.line, endColumn: text.length + 1 };
        const at = text.indexOf(s.name);
        const selectionRange = at < 0 ? range : {
          startLineNumber: s.line, startColumn: at + 1,
          endLineNumber: s.line, endColumn: at + 1 + s.name.length,
        };
        return { name: s.name, detail: s.detail, kind: symbolKind(monaco, s.kind), tags: [], range, selectionRange };
      });
    },
  });
}

// ---------- the theme ----------

/*
 * catalyst-dark: the identity's tokens, translated into the only shape monaco reads.
 *
 * Every colour here is looked up from CSS at run time - see src/js/theme.js. A token that the
 * stylesheet does not define is left out of the theme entirely, so monaco falls back to its vs-dark
 * base rather than to a colour invented in this file.
 *
 * The list is long because a theme object is the only way to reach most of monaco's chrome. The
 * find widget, the Ctrl+G and Ctrl+Shift+O quick-open boxes, the sticky-scroll header and the
 * bracket colours are all drawn from these keys; left out, they render as stock vs-dark grey on
 * this app's graphite, which is the one thing they must not do.
 */
const COLOURS = [
  // --- the text surface ---
  ["editor.background", "--cat-ground"],
  ["editor.foreground", "--cat-ink"],
  ["editorGutter.background", "--cat-ground"],
  ["editorLineNumber.foreground", "--cat-faint"],
  ["editorLineNumber.activeForeground", "--cat-dim"],
  ["editorCursor.foreground", "--cat-signal"],
  ["editorCursor.background", "--cat-ground"],
  ["editor.lineHighlightBackground", "--cat-surface-1"],
  // Monaco draws a border round the current line unless it is told otherwise, and vs-dark's is a
  // grey that reads as a box. Pointing it at the ground makes the highlight a fill and nothing else.
  ["editor.lineHighlightBorder", "--cat-ground"],
  ["editor.selectionBackground", "--cat-surface-3"],
  ["editor.inactiveSelectionBackground", "--cat-surface-2"],
  ["editor.selectionHighlightBackground", "--cat-surface-2"],
  ["editor.selectionHighlightBorder", "--cat-line-strong"],
  ["editor.wordHighlightBackground", "--cat-surface-2"],
  ["editor.rangeHighlightBackground", "--cat-surface-1"],
  ["editor.foldBackground", "--cat-surface-1"],
  ["editorIndentGuide.background1", "--cat-line"],
  ["editorIndentGuide.activeBackground1", "--cat-line-strong"],
  ["editorWhitespace.foreground", "--cat-faint"],
  ["editorBracketMatch.background", "--cat-surface-2"],
  ["editorBracketMatch.border", "--cat-line-strong"],
  ["editorGutter.foldingControlForeground", "--cat-dim"],
  ["editorRuler.foreground", "--cat-line"],
  ["editorUnnecessaryCode.border", "--cat-line"],

  // --- brackets. The identity has four hues and one of them is reserved, so the levels run
  //     info, ok, warn and then three tones of ink rather than a rainbow. Crimson appears only on
  //     the bracket that has no partner, which is a fault and is what crimson is for. ---
  ["editorBracketHighlight.foreground1", "--cat-info"],
  ["editorBracketHighlight.foreground2", "--cat-ok"],
  ["editorBracketHighlight.foreground3", "--cat-warn"],
  ["editorBracketHighlight.foreground4", "--cat-body"],
  ["editorBracketHighlight.foreground5", "--cat-dim"],
  ["editorBracketHighlight.foreground6", "--cat-quiet"],
  ["editorBracketHighlight.unexpectedBracket.foreground", "--cat-bad"],
  ["editorBracketPairGuide.background1", "--cat-line"],
  ["editorBracketPairGuide.background2", "--cat-line"],
  ["editorBracketPairGuide.background3", "--cat-line"],
  ["editorBracketPairGuide.activeBackground1", "--cat-info"],
  ["editorBracketPairGuide.activeBackground2", "--cat-ok"],
  ["editorBracketPairGuide.activeBackground3", "--cat-warn"],

  // --- find and replace (Ctrl+F / Ctrl+H) ---
  // The match under the caret is a solid amber with ground-coloured text; the rest are the same
  // hue as a tint. One hue for one idea, and not the signal colour, which marks faults.
  ["editor.findMatchBackground", "--cat-warn"],
  ["editor.findMatchForeground", "--cat-ground"],
  ["editor.findMatchHighlightBackground", "--cat-warn-tint"],
  ["editor.findMatchHighlightForeground", "--cat-ink"],
  ["editor.findMatchBorder", "--cat-warn"],
  ["editor.findRangeHighlightBackground", "--cat-surface-1"],

  // --- every floating piece of monaco chrome ---
  ["editorWidget.background", "--cat-surface-1"],
  ["editorWidget.foreground", "--cat-ink"],
  ["editorWidget.border", "--cat-line-strong"],
  ["editorWidget.resizeBorder", "--cat-signal-line"],
  ["editorHoverWidget.background", "--cat-surface-1"],
  ["editorHoverWidget.border", "--cat-line-strong"],
  ["editorSuggestWidget.background", "--cat-surface-1"],
  ["editorSuggestWidget.border", "--cat-line-strong"],
  ["editorSuggestWidget.foreground", "--cat-ink"],
  ["editorSuggestWidget.selectedBackground", "--cat-surface-3"],
  ["editorSuggestWidget.highlightForeground", "--cat-signal-ink"],
  ["widget.border", "--cat-line-strong"],
  ["widget.shadow", "--cat-ground-bottom"],
  ["menu.background", "--cat-surface-1"],
  ["menu.foreground", "--cat-body"],
  ["menu.border", "--cat-line-strong"],
  ["menu.selectionBackground", "--cat-surface-3"],
  ["menu.selectionForeground", "--cat-ink-strong"],
  ["menu.separatorBackground", "--cat-line"],

  // --- the inputs inside those widgets ---
  ["input.background", "--cat-surface-2"],
  ["input.foreground", "--cat-ink"],
  ["input.border", "--cat-line-strong"],
  ["input.placeholderForeground", "--cat-faint"],
  ["inputOption.activeBackground", "--cat-signal-tint"],
  ["inputOption.activeBorder", "--cat-signal-line"],
  ["inputOption.activeForeground", "--cat-signal-ink"],
  ["inputOption.hoverBackground", "--cat-surface-3"],
  ["inputValidation.errorBackground", "--cat-bad-tint"],
  ["inputValidation.errorBorder", "--cat-bad"],
  ["inputValidation.errorForeground", "--cat-ink"],
  ["inputValidation.warningBackground", "--cat-warn-tint"],
  ["inputValidation.warningBorder", "--cat-warn"],
  ["inputValidation.infoBackground", "--cat-info-tint"],
  ["inputValidation.infoBorder", "--cat-info"],
  ["focusBorder", "--cat-signal"],
  ["contrastBorder", "--cat-line-strong"],
  ["toolbar.hoverBackground", "--cat-surface-3"],
  ["toolbar.activeBackground", "--cat-surface-3"],
  ["icon.foreground", "--cat-dim"],
  ["button.background", "--cat-signal-tint"],
  ["button.foreground", "--cat-signal-ink"],
  ["button.border", "--cat-signal-line"],
  ["button.hoverBackground", "--cat-signal-tint-2"],
  ["badge.background", "--cat-surface-3"],
  ["badge.foreground", "--cat-ink"],
  ["progressBar.background", "--cat-signal"],
  ["errorForeground", "--cat-bad"],
  ["descriptionForeground", "--cat-quiet"],
  ["textLink.foreground", "--cat-signal-ink"],
  ["editorLink.activeForeground", "--cat-signal-ink"],

  // --- the quick-open box: Go to Line (Ctrl+G) and Go to Symbol (Ctrl+Shift+O) ---
  ["quickInput.background", "--cat-surface-1"],
  ["quickInput.foreground", "--cat-ink"],
  ["quickInputTitle.background", "--cat-surface-2"],
  ["quickInputList.focusBackground", "--cat-signal-tint"],
  ["quickInputList.focusForeground", "--cat-ink-strong"],
  ["quickInputList.focusIconForeground", "--cat-signal-ink"],
  ["pickerGroup.border", "--cat-line"],
  ["pickerGroup.foreground", "--cat-dim"],
  ["list.hoverBackground", "--cat-surface-2"],
  ["list.hoverForeground", "--cat-ink"],
  ["list.focusBackground", "--cat-surface-3"],
  ["list.focusForeground", "--cat-ink-strong"],
  ["list.activeSelectionBackground", "--cat-surface-3"],
  ["list.activeSelectionForeground", "--cat-ink-strong"],
  ["list.inactiveSelectionBackground", "--cat-surface-2"],
  // The characters the query matched. This is the one place the signal earns its place in a list:
  // it is what the person just typed, pointed at.
  ["list.highlightForeground", "--cat-signal-ink"],
  ["list.focusHighlightForeground", "--cat-signal-ink"],
  ["keybindingLabel.background", "--cat-surface-2"],
  ["keybindingLabel.foreground", "--cat-dim"],
  ["keybindingLabel.border", "--cat-line-strong"],
  ["keybindingLabel.bottomBorder", "--cat-line-strong"],

  // --- sticky scroll: the class and method you are inside, pinned to the top ---
  ["editorStickyScroll.background", "--cat-surface-1"],
  ["editorStickyScroll.border", "--cat-line"],
  ["editorStickyScroll.shadow", "--cat-ground-bottom"],
  ["editorStickyScrollHover.background", "--cat-surface-2"],

  // --- the edges ---
  ["editorOverviewRuler.border", "--cat-line"],
  ["editorOverviewRuler.background", "--cat-ground"],
  ["editorOverviewRuler.findMatchForeground", "--cat-warn"],
  ["editorOverviewRuler.selectionHighlightForeground", "--cat-line-strong"],
  ["editorOverviewRuler.bracketMatchForeground", "--cat-line-strong"],
  ["editorOverviewRuler.rangeHighlightForeground", "--cat-line-strong"],
  ["editorOverviewRuler.errorForeground", "--cat-bad"],
  ["editorOverviewRuler.warningForeground", "--cat-warn"],
  ["scrollbar.shadow", "--cat-ground-bottom"],
  ["scrollbarSlider.background", "--cat-line"],
  ["scrollbarSlider.hoverBackground", "--cat-line-strong"],
  ["scrollbarSlider.activeBackground", "--cat-line-strong"],
  ["sash.hoverBorder", "--cat-signal-line"],
  ["editorError.foreground", "--cat-bad"],
  ["editorWarning.foreground", "--cat-warn"],
  ["editorInfo.foreground", "--cat-info"],
];

/** Monarch token scopes, grouped by the identity colour they take. */
const RULES = [
  [["comment", "comment.doc", "comment.content"], "--cat-faint"],
  [["keyword", "keyword.json", "constant.language"], "--cat-signal"],
  [["annotation", "metatag", "tag"], "--cat-signal"],
  [["string.key.json"], "--cat-signal"],
  [["string", "string.escape", "string.value.json", "attribute.value"], "--cat-ok"],
  [["number", "number.hex", "number.float", "constant.numeric"], "--cat-warn"],
  [["type", "type.identifier", "namespace"], "--cat-ink"],
  [["delimiter", "delimiter.bracket", "delimiter.parenthesis", "operator", "attribute.name"], "--cat-dim"],
  [["invalid"], "--cat-bad"],
];

/** Define (or redefine) catalyst-dark from whatever the stylesheet currently says. */
export function defineCatalystTheme(monaco) {
  const colors = {};
  for (const [key, token] of COLOURS) {
    const hex = hexToken(token);
    if (hex) colors[key] = hex;
  }

  const rules = [];
  for (const [scopes, token] of RULES) {
    const hex = hexToken(token);
    if (!hex) continue;
    // Token rules take six digits and no leading hash; an eight-digit value is silently ignored.
    const foreground = hex.slice(1, 7);
    for (const token2 of scopes) rules.push({ token: token2, foreground });
  }

  monaco.editor.defineTheme("catalyst-dark", { base: "vs-dark", inherit: true, rules, colors });
  return { rules: rules.length, colors: Object.keys(colors).length };
}

/** A pixel count from a token, when the token is a length this can read. */
function pxToken(name, fallback) {
  const n = parseFloat(cssToken(name));
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Editor options.
 *
 * Two groups, and it matters which is which. Everything switched off here is switched off because
 * it does its work in a web worker, and this app has none; everything switched on is a reading aid
 * that runs in-thread and earns its place in a file of robot code.
 *
 * @param {"on"|"off"} wordWrap what Alt+Z last left it at
 */
function editorOptions(wordWrap) {
  const mono = cssToken("--cat-mono");
  return {
    theme: "catalyst-dark",
    automaticLayout: true,
    fontFamily: mono || undefined,
    fontSize: pxToken("--cat-fs-13", 13),
    // Cascadia Code is a ligature font and this identity ships it. `->`, `!=`, `>=` and `::` are
    // the shapes a student is reading for in Java; left off they are two glyphs pretending.
    fontLigatures: true,
    padding: { top: pxToken("--cat-space-2", 8), bottom: pxToken("--cat-space-4", 16) },

    // --- reading ---
    lineNumbers: "on",
    lineNumbersMinChars: 3,
    glyphMargin: false,
    folding: true,
    // Indentation, not "auto". Auto asks the folding-range providers first, and the only ones this
    // build has are the four language services that need a worker: the fold arrows would simply
    // never appear on a .json file. Indentation is in-thread and right for every language here.
    foldingStrategy: "indentation",
    foldingHighlight: true,
    showFoldingControls: "mouseover",
    // The class and the method you are inside, pinned above the text. Four lines is the depth a
    // Java file reaches — class, method, an if, a lambda — before the header costs more than it says.
    stickyScroll: { enabled: true, maxLineCount: 4, defaultModel: "indentationModel", scrollWithEditor: true },
    guides: {
      indentation: true,
      highlightActiveIndentation: true,
      bracketPairs: "active",
      highlightActiveBracketPair: true,
    },
    bracketPairColorization: { enabled: true, independentColorPoolPerBracketType: true },
    matchBrackets: "always",
    renderWhitespace: "selection",
    renderLineHighlight: "all",
    renderLineHighlightOnlyWhenFocus: false,
    selectionHighlight: true,
    roundedSelection: false,
    minimap: { enabled: false },
    overviewRulerBorder: false,
    overviewRulerLanes: 2,
    wordWrap: wordWrap === "on" ? "on" : "off",
    wrappingIndent: "indent",

    // --- feel ---
    // A caret that eases rather than jumps, and a viewport that never teleports. Both are monaco's
    // own animations; neither is a spring, so neither competes with the identity's curves.
    cursorBlinking: "smooth",
    cursorSmoothCaretAnimation: "on",
    cursorSurroundingLines: 3,
    smoothScrolling: true,
    scrollBeyondLastLine: false,
    fastScrollSensitivity: 5,
    scrollbar: {
      verticalScrollbarSize: 10,
      horizontalScrollbarSize: 10,
      useShadows: false,
      // The editor fills its pane; swallowing the wheel at the last line would trap a scroll that
      // belongs to the workspace around it.
      alwaysConsumeMouseWheel: false,
    },
    find: {
      addExtraSpaceOnTop: false,
      seedSearchStringFromSelection: "selection",
      autoFindInSelection: "multiline",
      loop: true,
    },
    autoIndent: "full",
    trimAutoWhitespace: true,
    tabCompletion: "off",

    // --- worker-bound. Left on, each throws once the editor asks for a worker it cannot start. ---
    wordBasedSuggestions: "off",
    quickSuggestions: false,
    suggestOnTriggerCharacters: false,
    snippetSuggestions: "none",
    acceptSuggestionOnEnter: "off",
    parameterHints: { enabled: false },
    inlayHints: { enabled: "off" },
    lightbulb: { enabled: "off" },
    formatOnType: false,
    formatOnPaste: false,
    links: false,
    occurrencesHighlight: "off",
    codeLens: false,
    // With no provider left there is nothing for a hover to say, and an empty hover that follows
    // the pointer around is worse than none.
    hover: { enabled: false },
    // These two are the ones that matter, and they are not obvious: monaco's default document
    // colour provider - the little swatch next to a colour literal - runs in the editor worker and
    // asks for one the moment a model is attached, before anything is typed. Measured against the
    // vendored 0.56.0 under `script-src 'self'`: with them on, mounting an editor throws
    // "FAILED to post message to worker" twice; with them off, nothing asks for a worker at all.
    colorDecorators: false,
    defaultColorDecorators: "never",
    // Also worker-bound, and it would put boxes around the em dashes and middots this project's own
    // files are full of.
    unicodeHighlight: { nonBasicASCII: false, ambiguousCharacters: false, invisibleCharacters: false },
  };
}

// ---------- the pane ----------

const WRAP_KEY = "ws.editor.wrap";

/**
 * Mount the editor into `el`.
 *
 * @param {object} args
 * @param {HTMLElement} args.el
 * @param {string} [args.root] the project directory, for the path the status bar prints
 * @returns {object} the pane's API; see the return statement at the end of this function
 */
export function mountEditor({ el, root, onAsk }) {
  if (!el) throw new Error("mountEditor needs an element");
  ensureStylesheet("cat-editor-css", EDITOR_STYLES);

  const tabs = [];                  // { path, model, viewState, indent, listener, confirmAt }
  const dirt = createDirtyTracker();
  const listeners = new Set();
  const disposers = [];
  let mru = [];                     // open paths, most recently used first
  let cycling = null;               // { order, index } while Ctrl is held down for Ctrl+Tab
  let monaco = null;
  let editor = null;
  let activePath = null;
  let destroyed = false;
  let noteTimer = 0;
  let confirmTimer = 0;
  let saving = null;
  let stripSignature = null;
  let wordWrap = settings.get(WRAP_KEY, "off") === "on" ? "on" : "off";

  // --- the frame ---
  const frame = document.createElement("div");
  frame.className = "ed";

  const tabbar = document.createElement("div");
  tabbar.className = "ed-tabbar";
  tabbar.dataset.overflow = "none";
  const strip = document.createElement("div");
  strip.className = "ed-tabs";
  strip.setAttribute("role", "tablist");
  tabbar.appendChild(strip);

  /*
   * The mark under the active tab.
   *
   * app.css draws it as the active tab's own ::after, which is right for a strip that is read and
   * wrong for one that is clicked along: the mark goes out here and comes on there, and nothing
   * says the two are the same mark. This is one element that travels instead — `settle`, because it
   * is going where you just sent it — and `scaleX` on a 1px bar keeps the travel and the stretch
   * inside a single composited transform rather than an animated width. Setting `data-mark` is what
   * turns the drawn underline off.
   *
   * It lives inside the strip so it scrolls with the tabs, it is never re-appended (a node that is
   * removed and re-inserted has no previous style to transition from), and it paints over the
   * active tab's own background on a z-index rather than by being last in the DOM.
   */
  const mark = document.createElement("span");
  mark.className = "tab-mark";
  mark.setAttribute("aria-hidden", "true");
  strip.appendChild(mark);
  strip.dataset.mark = "";
  let markPlaced = false;

  function moveMark() {
    const on = strip.querySelector('.ed-tab[data-active="true"]');
    if (!on) { mark.dataset.on = "false"; return; }
    const to = `translateX(${on.offsetLeft}px) scaleX(${on.offsetWidth})`;
    if (mark.style.transform === to) { mark.dataset.on = "true"; return; }
    if (!markPlaced) {
      // The first file opened has nowhere to travel from.
      mark.style.transition = "none";
      mark.style.transform = to;
      void mark.offsetWidth;
      mark.style.transition = "";
      markPlaced = true;
    } else {
      mark.style.transform = to;
    }
    mark.dataset.on = "true";
  }

  const message = document.createElement("div");
  message.className = "ed-message";
  message.setAttribute("role", "status");

  const host = document.createElement("div");
  host.className = "ed-host";

  const empty = buildEmptyState();
  const status = buildStatusBar();

  frame.append(tabbar, message, host, empty.el, status.el);
  el.appendChild(frame);
  // Before monaco has even been asked for, the pane already says what it is: the panel, and no
  // empty tab strip or status bar for a file that is not open.
  showHost();

  const invoke = (cmd, args) => {
    const tauri = TAURI();
    if (!tauri) return Promise.reject(new Error("Opening files needs the desktop app."));
    return tauri.core.invoke(cmd, args);
  };

  /** Say what went wrong, in the words the backend used. Nothing here swallows an Err. */
  function say(text, tone) {
    if (destroyed) return;
    if (noteTimer) { clearTimeout(noteTimer); noteTimer = 0; }
    message.textContent = text || "";
    if (tone) message.dataset.tone = tone;
    else delete message.dataset.tone;
    message.hidden = !text;
    // A failure stays on screen until something replaces it; a success gets out of the way.
    if (text && tone !== "bad" && tone !== "note") {
      noteTimer = setTimeout(() => { if (!destroyed) say(""); }, 2400);
    }
  }
  const errorText = (e) => String((e && e.message) || e);

  // ---------- the empty state ----------

  /*
   * What the pane shows with no file in it. Before this it showed a live Monaco with no model,
   * which draws one line number and a caret for a file that does not exist - the picture of a bug.
   * The three shortcuts are the three that get a student from here to editing: the shell owns all
   * of them, so this panel names them rather than binding them.
   */
  function buildEmptyState() {
    const wrap = document.createElement("div");
    wrap.className = "ed-empty";
    // .cat-card and .cat-card__title are the identity's own; this panel adds a layout and no colour.
    const panel = document.createElement("div");
    panel.className = "cat-card ed-empty__panel";

    const eyebrow = document.createElement("div");
    eyebrow.className = "cat-eyebrow";
    eyebrow.textContent = "EDITOR";
    const title = document.createElement("div");
    title.className = "cat-card__title ed-empty__title";
    title.textContent = "No file open";
    const rule = document.createElement("hr");
    rule.className = "cat-rule";

    const keys = document.createElement("dl");
    keys.className = "ed-empty__keys";
    const SHORTCUTS = [
      [["Ctrl", "P"], "Open a file by name"],
      [["Ctrl", "Shift", "F"], "Find in this project"],
      [["Ctrl", "S"], "Save what is open"],
      [["Ctrl", "Alt", "K"], "Ask Claude about the selection"],
    ];
    for (const [caps, what] of SHORTCUTS) {
      const dt = document.createElement("dt");
      dt.className = "ed-empty__combo";
      caps.forEach((cap, i) => {
        if (i) dt.append(document.createTextNode("+"));
        const chip = document.createElement("kbd");
        chip.className = "cat-chip ed-empty__cap";
        chip.textContent = cap;
        dt.appendChild(chip);
      });
      const dd = document.createElement("dd");
      dd.className = "ed-empty__what";
      dd.textContent = what;
      keys.append(dt, dd);
    }

    panel.append(eyebrow, title, rule, keys);
    wrap.appendChild(panel);
    return { el: wrap };
  }

  // ---------- the status bar ----------

  /*
   * Where you are, in one line: the file inside the project, the caret, what it is being coloured
   * as, what it is indented with, and whether it is on disk. Monaco emits an event for every one of
   * these, so none of it is polled and none of it can go stale while you look at it.
   */
  function buildStatusBar() {
    const bar = document.createElement("div");
    bar.className = "ed-status";

    const path = document.createElement("span");
    path.className = "ed-status__path";
    const dir = document.createElement("span");
    dir.className = "ed-status__dir";
    const name = document.createElement("span");
    name.className = "ed-status__file";
    path.append(dir, name);

    const spacer = document.createElement("span");
    spacer.className = "ed-status__spacer";

    const make = (cls, tag = "span") => {
      const node = document.createElement(tag);
      node.className = `ed-status__item ${cls}`;
      if (tag === "button") node.type = "button";
      return node;
    };
    const caret = make("ed-status__caret", "button");
    caret.title = "Go to line or column (Ctrl+G)";
    const symbol = make("ed-status__symbol", "button");
    symbol.title = "Go to symbol (Ctrl+Shift+O)";
    symbol.textContent = "Symbols";
    const wrap = make("ed-status__wrap", "button");
    wrap.title = "Word wrap (Alt+Z)";
    const indent = make("ed-status__indent");
    const language = make("ed-status__language");

    const saved = document.createElement("span");
    saved.className = "ed-status__saved";
    const mark = document.createElement("span");
    mark.className = "ed-status__mark";
    mark.setAttribute("aria-hidden", "true");
    const savedText = document.createElement("span");
    saved.append(mark, savedText);

    bar.append(path, spacer, caret, symbol, wrap, indent, language, saved);

    caret.addEventListener("click", () => runEditorAction("editor.action.gotoLine"));
    symbol.addEventListener("click", () => runEditorAction("editor.action.quickOutline"));
    wrap.addEventListener("click", () => toggleWordWrap());

    return { el: bar, path, dir, name, caret, symbol, wrap, indent, language, saved, savedText };
  }

  function paintStatus() {
    const tab = activePath && tabFor(activePath);
    status.el.hidden = !tab;
    if (!tab) return;

    const shown = splitPath(relativePath(root, tab.path));
    status.dir.textContent = shown.dir;
    status.name.textContent = shown.name;
    status.path.title = tab.path;

    if (editor && editor.getModel() === tab.model) {
      const pos = editor.getPosition() || { lineNumber: 1, column: 1 };
      const sel = editor.getSelection();
      let selected = null;
      if (sel && !sel.isEmpty()) {
        selected = {
          chars: tab.model.getValueLengthInRange(sel),
          lines: sel.endLineNumber - sel.startLineNumber + 1,
        };
      }
      status.caret.textContent = cursorLabel(pos.lineNumber, pos.column, selected);
    }

    const options = tab.model.getOptions();
    status.indent.textContent = indentLabel({ insertSpaces: options.insertSpaces, size: options.tabSize });
    status.language.textContent = languageLabel(tab.model.getLanguageId());
    status.wrap.textContent = wordWrap === "on" ? "Wrap on" : "Wrap off";
    status.wrap.dataset.on = wordWrap === "on" ? "true" : "false";
    status.symbol.hidden = !OUTLINE_LANGUAGES.includes(tab.model.getLanguageId());

    const dirty = isDirty(tab);
    status.saved.dataset.dirty = dirty ? "true" : "false";
    status.savedText.textContent = dirty ? "Unsaved" : "Saved";
    status.saved.title = dirty ? `${tabTitle(tab.path)} has changes that are not on disk` : "Matches the file on disk";
  }

  // ---------- tabs ----------

  const tabFor = (path) => tabs.find((t) => t.path === path);
  const isDirty = (tab) => dirt.isDirty(tab.path, tab.model.getAlternativeVersionId());
  const dirtyPaths = () => tabs.filter(isDirty).map((t) => t.path);
  const armed = (tab) => !!tab.confirmAt && Date.now() - tab.confirmAt < CONFIRM_MS;

  function announce(path) {
    const snapshot = { path, dirty: path ? !!tabFor(path) && isDirty(tabFor(path)) : false, dirtyPaths: dirtyPaths() };
    for (const cb of listeners) {
      try { cb(snapshot); } catch (e) { console.warn("onDirty listener threw", e); }
    }
  }

  /*
   * The strip is rebuilt from scratch, which is fine as long as it is not rebuilt for nothing: it
   * used to run on every keystroke, throwing away the scroll position and any focus inside it
   * several times a second. This is everything a tab draws, as one string; when it has not moved,
   * neither does the DOM.
   */
  function stripState() {
    return tabs.map((t) => `${t.path}\u0000${t.path === activePath ? 1 : 0}${isDirty(t) ? 1 : 0}${armed(t) ? 1 : 0}`).join("\u0001");
  }

  function renderTabs(force) {
    const state = stripState();
    if (!force && state === stripSignature) return;
    stripSignature = state;

    const labels = tabLabels(tabs.map((t) => t.path));
    // Everything but the mark. Re-parenting it would cancel its travel every time the strip redrew.
    for (const old of [...strip.children]) if (old !== mark) old.remove();
    tabs.forEach((tab, i) => {
      // A div rather than a button: the close control is a real button and one cannot nest inside
      // the other. role="tab" plus a roving tabindex gives the keyboard the same thing.
      const item = document.createElement("div");
      item.className = "ed-tab";
      item.setAttribute("role", "tab");
      item.tabIndex = tab.path === activePath ? 0 : -1;
      item.dataset.path = tab.path;
      item.title = tab.path;
      item.setAttribute("aria-selected", tab.path === activePath ? "true" : "false");
      if (tab.path === activePath) item.dataset.active = "true";
      const dirty = isDirty(tab);
      if (dirty) item.dataset.dirty = "true";
      if (armed(tab)) item.dataset.confirm = "true";

      const dot = document.createElement("span");
      dot.className = "ed-dot";
      dot.setAttribute("aria-hidden", "true");
      const name = document.createElement("span");
      name.className = "ed-name";
      name.textContent = labels[i];
      const close = document.createElement("button");
      close.className = "ed-close";
      close.type = "button";
      close.tabIndex = -1;
      close.dataset.close = tab.path;
      // The second press is a different act from the first, so it says so: the control reads
      // "discard", not "close", and it is the only crimson in the strip.
      close.setAttribute("aria-label", armed(tab)
        ? `Discard unsaved changes in ${labels[i]} and close it`
        : dirty ? `Close ${labels[i]} (unsaved)` : `Close ${labels[i]}`);
      close.textContent = armed(tab) ? "Discard" : "\u00d7";
      if (armed(tab)) close.dataset.confirm = "true";

      item.append(dot, name, close);
      strip.appendChild(item);
    });
    moveMark();
    updateOverflow();
  }

  /*
   * The fade at each end of the strip. Overflow with no edge is a row of tabs that simply stops,
   * and nothing on screen says there are three more to the right.
   */
  function updateOverflow() {
    const slack = strip.scrollWidth - strip.clientWidth;
    if (slack <= 1) { tabbar.dataset.overflow = "none"; return; }
    const left = strip.scrollLeft > 1;
    const right = strip.scrollLeft < slack - 1;
    tabbar.dataset.overflow = left && right ? "both" : left ? "start" : right ? "end" : "none";
  }

  function scrollActiveIntoView() {
    const el2 = strip.querySelector('.ed-tab[data-active="true"]');
    if (el2 && el2.scrollIntoView) el2.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  strip.addEventListener("scroll", updateOverflow, { passive: true });
  const stripSize = typeof ResizeObserver === "function" ? new ResizeObserver(updateOverflow) : null;
  if (stripSize) stripSize.observe(strip);

  strip.addEventListener("click", (e) => {
    const closer = e.target.closest("[data-close]");
    if (closer) { e.stopPropagation(); closeFile(closer.dataset.close); return; }
    const tab = e.target.closest(".ed-tab");
    if (tab) activate(tab.dataset.path);
  });

  // Middle-click closes, as it does in every editor and every browser. `mousedown` has to be
  // cancelled as well or the platform starts its own autoscroll on the way past.
  strip.addEventListener("mousedown", (e) => { if (e.button === 1) e.preventDefault(); });
  strip.addEventListener("auxclick", (e) => {
    if (e.button !== 1) return;
    const tab = e.target.closest(".ed-tab");
    if (!tab) return;
    e.preventDefault();
    closeFile(tab.dataset.path);
  });

  strip.addEventListener("keydown", (e) => {
    const tab = e.target.closest(".ed-tab");
    if (!tab) return;
    const index = tabs.findIndex((t) => t.path === tab.dataset.path);
    if (index < 0) return;
    if (e.key === "Enter" || e.key === " ") { activate(tab.dataset.path); }
    else if (e.key === "ArrowRight" && tabs[index + 1]) { activate(tabs[index + 1].path, false); }
    else if (e.key === "ArrowLeft" && tabs[index - 1]) { activate(tabs[index - 1].path, false); }
    else if (e.key === "Delete") { closeFile(tab.dataset.path); }
    else return;
    e.preventDefault();
  });

  function touchMru(path) {
    mru = [path, ...mru.filter((p) => p !== path)];
  }

  function activate(path, focusEditor = true, remember = true) {
    const tab = tabFor(path);
    if (!tab || !editor) return;
    if (activePath && activePath !== path) {
      const previous = tabFor(activePath);
      if (previous) previous.viewState = editor.saveViewState();
    }
    activePath = path;
    if (remember) touchMru(path);
    showHost();
    editor.setModel(tab.model);
    if (tab.viewState) editor.restoreViewState(tab.viewState);
    renderTabs();
    scrollActiveIntoView();
    // Arrowing along the tab strip must not throw the caret into the text; clicking a tab should.
    if (focusEditor) editor.focus();
    else { const el2 = strip.querySelector('.ed-tab[data-active="true"]'); if (el2) el2.focus(); }
    paintStatus();
    announce(path);
  }

  /** Ctrl+Tab, and Ctrl+Shift+Tab. The order is most-recently-used, not left-to-right. */
  function cycleTabs(direction) {
    if (tabs.length < 2) return;
    if (!cycling) cycling = { order: mru.filter(tabFor), index: 0 };
    if (cycling.order.length < 2) { cycling = null; return; }
    cycling.index += direction;
    const next = mruStep(cycling.order, cycling.index);
    // Nothing is written back to the order until Ctrl comes up: walking three tabs back and
    // stopping there must not renumber the two you passed through on the way.
    if (next) activate(next, true, false);
  }

  function commitCycle() {
    if (!cycling) return;
    cycling = null;
    if (activePath) touchMru(activePath);
  }

  /**
   * Close a tab. A file with unsaved edits takes two presses: the first says so, the second
   * discards. There is no dialog, and there is no silent loss either.
   */
  function closeFile(path, force) {
    const tab = tabFor(path);
    if (!tab) return;
    if (!force && isDirty(tab)) {
      if (armed(tab)) { /* second press: fall through */ }
      else {
        tab.confirmAt = Date.now();
        say(`${tabTitle(path)} has unsaved changes. Ctrl+S to save, or press close again to discard.`, "bad");
        renderTabs();
        // The arming expires on its own, and the tab has to stop looking armed when it does -
        // a close button reading "Discard" that has quietly gone back to meaning "close" is worse
        // than either state on its own.
        if (confirmTimer) clearTimeout(confirmTimer);
        confirmTimer = setTimeout(() => {
          confirmTimer = 0;
          if (!destroyed) { renderTabs(); paintStatus(); }
        }, CONFIRM_MS + 50);
        return;
      }
    }
    const index = tabs.indexOf(tab);
    tabs.splice(index, 1);
    mru = mru.filter((p) => p !== path);
    dirt.forget(path);
    try { tab.listener?.dispose(); } catch (_) { /* the model is going anyway */ }
    tab.model.dispose();
    if (activePath === path) {
      activePath = null;
      // The tab that takes its place is the one you were in before, not the neighbour: after
      // closing a file you were reading against another, that other file is where you want to be.
      const next = mru.find(tabFor) || (tabs[index] || tabs[index - 1] || {}).path;
      if (next) activate(next);
      else if (editor) { editor.setModel(null); showHost(); renderTabs(true); paintStatus(); }
    } else renderTabs();
    announce(activePath);
  }

  /** Monaco on screen when there is a file, the panel when there is not. */
  function showHost() {
    const any = tabs.length > 0;
    host.hidden = !any;
    empty.el.hidden = any;
    status.el.hidden = !any;
    // An empty strip is a 32px band with a hairline under it and nothing in it, which reads as a
    // control that has broken rather than as one that has nothing to show.
    tabbar.hidden = !any;
    if (any && editor) {
      // A Monaco that was display:none measured itself at zero. automaticLayout notices on the next
      // frame, but the frame in between is a blank pane, so ask for the measurement now.
      try { editor.layout(); } catch (_) { /* not mounted yet */ }
    }
  }

  // ---------- opening and saving ----------

  /**
   * Put the caret on a line and bring it into view, after a file has opened.
   *
   * Only when the line is outside the viewport does the view move: a jump to a line already on screen
   * that recentres anyway makes the code under the reader's eye slide away for no reason.
   */
  const revealAt = (at) => {
    const line = Math.floor(Number(at?.line));
    if (!editor || !Number.isFinite(line) || line < 1) return;
    const model = editor.getModel();
    const target = model ? Math.min(line, model.getLineCount()) : line;
    const column = Math.max(1, Math.floor(Number(at?.col)) || 1);
    editor.setPosition({ lineNumber: target, column });
    editor.revealLineInCenterIfOutsideViewport(target);
    editor.focus();
  };

  async function openFile(path, at) {
    if (!path) return;
    const open = tabFor(path);
    if (open) { activate(path); revealAt(at); return; }

    // Decline the ones we already know about, before the round trip.
    if (isBinaryPath(path)) { say(binaryNote(path), "note"); return; }

    let file;
    try {
      file = await invoke("ws_read", { path });
    } catch (e) {
      // ws_read refuses files over 2 MiB and anything that is not UTF-8, by message. A file with no
      // extension, or one this list has never heard of, still reaches here — say the same calm thing
      // rather than passing on a sentence written for a command line.
      const text = errorText(e);
      if (/not UTF-8 text/i.test(text)) say(binaryNote(path), "note");
      else say(text, "bad");
      return;
    }
    let m;
    try {
      m = await ready;
    } catch (e) {
      say(errorText(e), "bad");
      return;
    }
    if (destroyed) return;

    const uri = m.Uri.file(file.path || path);
    const model = m.editor.getModel(uri) || m.editor.createModel(file.text, file.language || undefined, uri);
    const indent = detectIndent(file.text);
    model.updateOptions({ tabSize: indent.size, insertSpaces: indent.insertSpaces });

    const tab = { path: file.path || path, model, viewState: null, indent, listener: null, confirmAt: 0 };
    tabs.push(tab);
    dirt.track(tab.path, model.getAlternativeVersionId());
    tab.listener = model.onDidChangeContent(() => {
      renderTabs();
      paintStatus();
      announce(tab.path);
    });
    activate(tab.path);
    say("");
    revealAt(at);
  }

  /**
   * Write one tab to disk and mark it clean at the version that was written.
   *
   * The text and its version are read together, before the write, not after it returns: whatever
   * is typed while the write is crossing the IPC boundary is not on disk, and reading the version
   * afterwards marked those keystrokes saved.
   */
  async function writeTab(tab) {
    const version = tab.model.getAlternativeVersionId();
    const content = tab.model.getValue();
    try {
      await invoke("ws_write", { path: tab.path, content });
    } catch (e) {
      // ws_write refuses a path outside a registered project. That is the message to show, verbatim.
      say(errorText(e), "bad");
      return false;
    }
    dirt.track(tab.path, version);
    tab.confirmAt = 0;
    renderTabs();
    paintStatus();
    announce(tab.path);
    return true;
  }

  async function saveActive() {
    const tab = activePath && tabFor(activePath);
    if (!tab) return false;
    // Ctrl+S reaches this from three places - monaco's own action, this pane's frame, and the
    // workspace view's document listener. One press must be one ws_write, so a save in flight is
    // the answer to a second press rather than a second write.
    if (saving) return saving;
    saving = (async () => {
      const ok = await writeTab(tab);
      if (ok) say(`Saved ${tabTitle(tab.path)}`);
      return ok;
    })().finally(() => { saving = null; });
    return saving;
  }

  /**
   * Every file with changes, one write at a time. True only when all of them reached the disk,
   * because the caller is usually about to throw the buffers away and needs to know it can.
   */
  async function saveAll() {
    if (saving) await saving;
    const dirty = tabs.filter(isDirty);
    let ok = true;
    for (const tab of dirty) ok = (await writeTab(tab)) && ok;
    if (dirty.length && ok) {
      say(dirty.length === 1 ? `Saved ${tabTitle(dirty[0].path)}` : `Saved ${dirty.length} files`);
    }
    return ok;
  }

  /** Alt+Z. The setting is remembered, because a person who wraps wraps every file. */
  function toggleWordWrap(next) {
    wordWrap = next === undefined ? (wordWrap === "on" ? "off" : "on") : (next ? "on" : "off");
    settings.set(WRAP_KEY, wordWrap);
    if (editor) editor.updateOptions({ wordWrap });
    paintStatus();
    return wordWrap;
  }

  function runEditorAction(id) {
    if (!editor) return false;
    const action = editor.getAction(id);
    if (!action) return false;
    editor.focus();
    action.run();
    return true;
  }

  /*
   * Ctrl+S and Ctrl+W from anywhere in the pane - the tab strip, the status bar, the empty panel.
   * Monaco has its own keybinding for both inside the text, and stops propagation when it handles
   * one, so this never runs twice for the same press; it stops propagation itself so the
   * workspace view's own document-level Ctrl+S does not run a second time either.
   */
  const onKeyDown = (e) => {
    const ctrl = (e.ctrlKey || e.metaKey) && !e.altKey;
    if (ctrl && (e.key === "s" || e.key === "S")) {
      e.preventDefault();
      e.stopPropagation();
      saveActive();
    } else if (ctrl && (e.key === "w" || e.key === "W")) {
      e.preventDefault();
      e.stopPropagation();
      if (activePath) closeFile(activePath);
    } else if (ctrl && e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      cycleTabs(e.shiftKey ? -1 : 1);
    } else if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === "z" || e.key === "Z")) {
      e.preventDefault();
      toggleWordWrap();
    }
  };
  frame.addEventListener("keydown", onKeyDown);

  // Ctrl coming back up is what ends a Ctrl+Tab walk, and it can come up over any element - the
  // pointer may not be in the pane at all - so this one listener is on the window.
  const onKeyUp = (e) => { if (e.key === "Control" || e.key === "Meta") commitCycle(); };
  const onBlur = () => commitCycle();
  window.addEventListener("keyup", onKeyUp, true);
  window.addEventListener("blur", onBlur);

  // ---------- start ----------

  const ready = loadMonaco().then((m) => {
    if (destroyed) return m;
    monaco = m;
    defineCatalystTheme(m);
    editor = m.editor.create(host, editorOptions(wordWrap));
    showHost();

    const act = (id, label, keybindings, run) =>
      disposers.push(editor.addAction({ id, label, keybindings, run }));

    act("catalyst.save", "Save", [m.KeyMod.CtrlCmd | m.KeyCode.KeyS], () => { saveActive(); });
    act("catalyst.closeTab", "Close this file", [m.KeyMod.CtrlCmd | m.KeyCode.KeyW],
      () => { if (activePath) closeFile(activePath); });
    act("catalyst.nextTab", "Next file (most recent first)", [m.KeyMod.CtrlCmd | m.KeyCode.Tab],
      () => cycleTabs(1));
    act("catalyst.previousTab", "Previous file (most recent first)",
      [m.KeyMod.CtrlCmd | m.KeyMod.Shift | m.KeyCode.Tab], () => cycleTabs(-1));
    act("catalyst.wordWrap", "Toggle word wrap", [m.KeyMod.Alt | m.KeyCode.KeyZ],
      () => { toggleWordWrap(); });

    // Ctrl+Alt+K is the key Claude Code's own editor integrations use for the same thing, so the
    // hand that already knows it does not have to learn a second one. It goes in the context menu
    // first, because right-clicking the code in question is where someone looks for it.
    if (typeof onAsk === "function") {
      disposers.push(editor.addAction({
        id: "catalyst.askClaude",
        label: "Ask Claude about this",
        keybindings: [m.KeyMod.CtrlCmd | m.KeyMod.Alt | m.KeyCode.KeyK],
        contextMenuGroupId: "navigation",
        contextMenuOrder: 0,
        run: () => {
          if (!activePath) return;
          onAsk(mentionFor(root, activePath, editor.getSelection()), { path: activePath });
        },
      }));
    }

    // The status bar is only ever as true as its last event, so it takes every event that can
    // change it: the caret, the selection, the text, the model, its language and its indentation.
    disposers.push(editor.onDidChangeCursorPosition(paintStatus));
    disposers.push(editor.onDidChangeCursorSelection(paintStatus));
    disposers.push(editor.onDidChangeModel(paintStatus));
    disposers.push(editor.onDidChangeModelLanguage(paintStatus));
    disposers.push(editor.onDidChangeModelOptions(paintStatus));
    disposers.push(editor.onDidChangeConfiguration(() => {
      const wrapping = editor.getOption(m.editor.EditorOption.wordWrap);
      if (wrapping === "on" || wrapping === "off") wordWrap = wrapping;
      paintStatus();
    }));

    paintStatus();
    return m;
  }).catch((e) => {
    say(errorText(e), "bad");
    throw e;
  });

  return {
    ready,
    openFile,
    saveActive,
    saveAll,
    closeFile,
    activePath: () => activePath,
    dirtyPaths,
    /** Every open file, left to right, as the tab strip has them. */
    openPaths: () => tabs.map((t) => t.path),
    /** The open files in the order Ctrl+Tab walks them: the one on screen first. */
    recentPaths: () => mru.filter(tabFor),
    /** What the status bar is saying, for anything that wants it without reading the DOM. */
    status: () => {
      const tab = activePath && tabFor(activePath);
      if (!tab) return null;
      const options = tab.model.getOptions();
      return {
        path: tab.path,
        relative: relativePath(root, tab.path),
        language: tab.model.getLanguageId(),
        indent: { insertSpaces: options.insertSpaces, size: options.tabSize },
        dirty: isDirty(tab),
        wordWrap,
      };
    },
    /** Re-measure. The pane's width changes when the tree or the Claude panel folds away. */
    layout() { try { editor?.layout(); } catch (_) { /* not mounted yet */ } },
    focus() { editor?.focus(); },
    /** Monaco's own widgets, so a menu or a button can reach what the keyboard reaches. */
    goToLine: () => runEditorAction("editor.action.gotoLine"),
    goToSymbol: () => runEditorAction("editor.action.quickOutline"),
    find: () => runEditorAction("actions.find"),
    replace: () => runEditorAction("editor.action.startFindReplaceAction"),
    /** Alt+Z. With no argument it flips; with one it sets. Returns "on" or "off". */
    toggleWordWrap,
    /**
     * Register a listener for dirty changes. Called with { path, dirty, dirtyPaths }.
     * @returns {() => void} unsubscribe
     */
    onDirty(cb) {
      if (typeof cb !== "function") return () => {};
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    /** Rebuild the theme from CSS - call it after the accent changes, or the stylesheet swaps. */
    refreshTheme() {
      if (!monaco) return null;
      const built = defineCatalystTheme(monaco);
      monaco.editor.setTheme("catalyst-dark");
      return built;
    },
    destroy() {
      destroyed = true;
      if (noteTimer) clearTimeout(noteTimer);
      if (confirmTimer) clearTimeout(confirmTimer);
      frame.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
      if (stripSize) { try { stripSize.disconnect(); } catch (_) {} }
      for (const d of disposers) { try { d.dispose(); } catch (_) {} }
      for (const tab of tabs) {
        try { tab.listener?.dispose(); } catch (_) {}
        try { tab.model.dispose(); } catch (_) {}
      }
      tabs.length = 0;
      mru = [];
      listeners.clear();
      if (editor) { try { editor.dispose(); } catch (_) {} }
      frame.remove();
    },
  };
}
