// The Problems pane: what a build said was wrong, as a list of places to go and fix it.
//
// A failed Gradle build prints its compiler errors between task names and a progress bar, then prints
// them all a second time under "What went wrong", in a different order, beside advice about --scan.
// The line that matters is the one a student scrolls straight past. This reads the same terminal
// output the Build tab shows and keeps only what names a file and a line, so the answer to "what
// broke" is a row that opens the file at the place.
//
// Everything that decides what counts as a problem is a pure function in the first half of this file,
// tested without a DOM. The pane in the second half only draws what those functions return.
//
// Where a line is ambiguous it is left out. A missing row still has its line in the Build tab; a row
// that points at a file that does not exist sends someone looking for it, and after that nobody
// trusts the pane.
//
//   mountProblems({ el, root, onOpen, onAsk }) -> { push(chunk), reset(), destroy(), problems() }

// ---------------------------------------------------------------- terminal text

// One escape sequence of any kind. A CSI (`ESC [`, parameters, a final byte) has its parameters and
// final byte captured, because two families of them mean something to `stripAnsi`. A string sequence
// - OSC, DCS, APC, PM, SOS - runs to BEL or `ESC \`, and may not look past the end of its own line for
// one, so a window title that lost its terminator costs that line rather than the rest of the build.
const ESCAPE = /\u001b(?:\[([0-?]*)[ -\/]*([@-~])|[\]PX^_][^\u0007\u001b\r\n]*(?:\u0007|\u001b\\)|[ -\/]*[0-~])/g;

// C0 controls other than tab and the two line endings. A bell or a backspace in the middle of a path
// is not part of the path.
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

// The CSI finals that send the cursor somewhere else: up, down, back, next line, previous line,
// column, position, row.
const CURSOR_JUMPS = new Set(["A", "B", "D", "E", "F", "G", "H", "d", "f"]);

// A terminal clamps a cursor move to its own width. Text has no width, so this picks one no screen
// reaches, which is enough to stop `ESC[99999999C` becoming a hundred million spaces.
const MAX_CURSOR_STEP = 1000;

// Sequences that neither print nor move the cursor - colour, showing and hiding the cursor, erasing to
// the end of the line - which ConPTY is free to put anywhere, including in the middle of a wrap.
const STILL = String.raw`(?:\u001b\[[0-9;?]*[hlmK])*`;

// ConPTY's way of continuing a line wider than the terminal once the screen has scrolled: the full
// row, a line break, a jump back to that row's last column, and the row's last character printed a
// second time, which re-arms the terminal's pending wrap so the rest flows onto the next row.
const WRAPPED = new RegExp(String.raw`([^\r\n\u001b])(${STILL})\r?\n(${STILL})\u001b\[\d+;(\d+)H(${STILL})\1`, "g");

// What is left after a line break when that break might still turn out to be one of those wraps:
// nothing yet, sequences that print nothing, the jump without the character after it, or an escape
// cut off partway. Nothing yet also leaves a `\r` undecided between a lone return and half a `\r\n`.
const MAYBE_WRAPPED = new RegExp(String.raw`^${STILL}(?:\u001b\[\d+;\d+H${STILL})?(?:\u001b(?:\[[0-9;?]*)?)?$`);

/** `text` with every line ConPTY broke at the terminal's edge put back together. */
function joinWrapped(text) {
  // Column 1 is a repaint starting a row, not a row being continued.
  return text.replace(WRAPPED, (seq, last, before, between, column, after) =>
    Number(column) > 1 ? last + before + between + after : seq,
  );
}

/**
 * The text a terminal would show, without the escape sequences that drew it.
 *
 * Colours and erases are simply deleted. Cursor movement cannot be, because it is how a console puts
 * text at the start of a line without a newline in front of it. Gradle's rich console draws its
 * progress bar, steps back and down with `ESC[14D ESC[1B`, and prints the first compiler error straight
 * after, so with the movement deleted that error reads `…EXECUTING [4s]> :compileJavaC:\…\Robot.java:9:`
 * and is lost. A jump elsewhere therefore becomes a line break. A step to the right is how a console
 * skips cells it has nothing to write in, and javac's caret line is almost nothing but such cells, so
 * that becomes the same number of spaces - otherwise every caret would land in column 1.
 *
 * The one jump that is not a new line is ConPTY continuing a line too wide for the terminal, and it
 * is put back first. A javac error with a full Windows path is wider than a dock terminal, so in a
 * build long enough to scroll, reading that jump as a line break loses nearly every error.
 */
export function stripAnsi(text) {
  return joinWrapped(String(text ?? ""))
    .replace(ESCAPE, (_, params, final) => {
      if (final === "C") return " ".repeat(Math.min(Number.parseInt(params, 10) || 1, MAX_CURSOR_STEP));
      return final && CURSOR_JUMPS.has(final) ? "\n" : "";
    })
    .replace(CONTROLS, "");
}

/**
 * Terminal output as the lines a reader sees, trailing blanks trimmed.
 *
 * All three line endings count. javac mixes two of them inside one error - `\n` between the lines of
 * a diagnostic and `\r\n` after the last - and a lone `\r` is how a line rewrites itself in place, so
 * what was written before the return is not the start of what comes after it.
 */
function plainLines(text) {
  return stripAnsi(text)
    .split(/\r\n|\r|\n/)
    .map((line) => line.replace(/\s+$/, ""));
}

// ---------------------------------------------------------------- what a problem looks like

// A path the way a compiler prints one: a drive letter if it has one, then anything but a colon.
// Windows allows no colon past the drive, which is what lets `:42:` be found without guessing where
// the path stops, and what keeps `12:34:56` and `https://host:443` from reading as files.
const PATH = String.raw`(?:[A-Za-z]:(?=[\\/]))?[^:<>"|?*]+`;

// javac, which is what Gradle compiles Java with: `C:\…\Robot.java:42: error: cannot find symbol`. The
// column is not on this line; it comes from the caret under the source excerpt. The two words are
// javac's English ones, and a JVM running in another locale prints its own, which this does not read.
const JAVAC = new RegExp(String.raw`^(${PATH}):(\d+): (error|warning): (.*)$`);

// Anything that prints the column itself: GCC and Clang, which compile a C++ robot project, and most
// linters. `fatal error` is how GCC says an #include is not there.
const COLUMNED = new RegExp(String.raw`^(${PATH}):(\d+):(\d+): (?:fatal )?(error|warning): (.*)$`);

// Kotlin, including the compiler Gradle runs over a build.gradle.kts: `e:` or `w:`, a file URL, a line
// and a column. Gradle 9 puts a colon after the column; other Kotlin tools only a space.
const KOTLIN = new RegExp(String.raw`^([ew]): (file:\S+?|${PATH}):(\d+):(\d+):?\s+(.*)$`);

// Gradle's own report of a build script it could not run. `* Where:` names the file and the line, and
// the reason arrives a few lines later, under `* What went wrong:`, spread over as many lines as it
// takes - with blank ones among them - until the next `* ` heading.
const GRADLE_WHERE = new RegExp(String.raw`^(?:(?:Build|Settings|Init) file|Script) '(${PATH})' line: (\d+)$`);
const WHAT_WENT_WRONG = "* What went wrong:";

// What a build-script problem says in the moment before Gradle has said what went wrong.
const WHERE_UNTOLD = "Gradle stopped at this line.";

// javac's caret: whitespace, then `^`. The whitespace is a copy of the source line's own, tabs included,
// so the caret sits under the right character; demanding spaces would miss every error on a
// tab-indented line. Gradle's rich console and ConPTY both expand those tabs on the way to the screen,
// though, so on such a line the column that arrives is the displayed one, eight to a tab. The line is
// right either way.
const CARET = /^[ \t]*\^$/;

// Gradle's progress area: the bar (`[####....] 47% EXECUTING` from Gradle 9, `<===---> 47%` before it)
// and the `> :compileJava` rows under it. It is repainted between batches of output, so its rows can
// land between a javac error and its caret, and taken for the source excerpt they would push the real
// caret out of reach.
const PROGRESS = /^(?:\[[#.]*\] \d+%|<[=\-]*> \d+%|> )/;

// The two lines Gradle ends a failed build with. Held to the start of a line, because a robot program
// is free to log "Auto FAILURE: timed out" in the middle of one, and that is not the build failing.
const FAILED = /^(?:BUILD FAILED\b|FAILURE: )/;

/**
 * The path a `file:` URL names.
 *
 * Kotlin reports files as URLs, so a folder called `Robot 2027` arrives as `Robot%202027` and the drive
 * arrives behind a slash - `/C:/Users/…` is a path that exists nowhere on Windows.
 */
function pathFromFileUrl(url) {
  const m = /^file:(?:\/\/([^/]*))?(\/.*)$/i.exec(url);
  if (!m) return url;
  let path = m[2];
  try {
    path = decodeURIComponent(path);
  } catch {
    // A `%` that is not an escape. The undecoded path is still nearer the truth than no path.
  }
  const host = m[1] && m[1].toLowerCase() !== "localhost" ? m[1] : "";
  return host ? `//${host}${path}` : path.replace(/^\/([A-Za-z]:)/, "$1");
}

/**
 * Whether what came before `:42:` is a file a compiler would name.
 *
 * It needs a folder and an extension. Gradle hands every compiler full paths, so this costs no real
 * error, and it is what stops `roborio-5805-frc.local:22: error: …` from a failed deploy becoming a row
 * that opens nothing. It must not be indented either: javac never indents an error, and Gradle's
 * second copy of every one, under "What went wrong", is indented two spaces - read as well, it would
 * put each error in the list twice.
 */
function looksLikeSourceFile(path) {
  if (!path || path !== path.trim()) return false;
  const parts = path.split(/[\\/]/);
  return parts.length > 1 && /[^.]\.[A-Za-z][\w+-]*$/.test(parts[parts.length - 1]);
}

// Windows ignores case and does not mind which slash a path uses, and neither does anything here
// that asks whether two paths are the same file.
const fileKey = (path) => String(path).replace(/\\/g, "/").toLowerCase();

/**
 * What makes two problems the same problem.
 *
 * The same error can arrive more than once without anyone building twice: a console that is resized
 * repaints what is on screen, and the repaint comes through as output like anything else.
 */
function keyOf(problem) {
  return `${fileKey(problem.file)}|${problem.line}|${problem.col ?? ""}|${problem.message}`;
}

/** The problem a line starts, and what the reader should expect next; or null. */
function headerOf(raw) {
  let m;
  if ((m = JAVAC.exec(raw))) {
    return opened({ raw, where: m[1], line: m[2], severity: m[3], message: m[4], expect: "source" });
  }
  if ((m = COLUMNED.exec(raw))) {
    return opened({ raw, where: m[1], line: m[2], col: m[3], severity: m[4], message: m[5] });
  }
  if ((m = KOTLIN.exec(raw))) {
    const severity = m[1] === "e" ? "error" : "warning";
    return opened({ raw, where: m[2], line: m[3], col: m[4], severity, message: m[5] });
  }
  if ((m = GRADLE_WHERE.exec(raw))) {
    return opened({ raw, where: m[1], line: m[2], severity: "error", message: WHERE_UNTOLD, expect: "where" });
  }
  return null;
}

/** The problem a matched line describes, or null when what it names is not a source file after all. */
function opened({ raw, where, line, col = null, severity, message, expect = null }) {
  const file = /^file:/i.test(where) ? pathFromFileUrl(where) : where;
  if (!looksLikeSourceFile(file)) return null;
  const problem = { file, line: Number(line), col: col === null ? null : Number(col), severity, message, raw };
  return { problem, expect };
}

// ---------------------------------------------------------------- reading

/**
 * The line-at-a-time reader behind both `parseProblems` and the collector.
 *
 * A javac error is not one line but up to five - the error, the source line it is about, the caret
 * under the column, then `symbol:` and `location:` saying what could not be found - and a build
 * script's failure is spread across a whole section. So the latest problem stays open while lines that
 * belong to it arrive, and closes at the first line that does not. That is what lets the collector
 * hand over lines as the terminal delivers them and still end with what one pass over the whole log
 * would have found.
 */
function createReader() {
  const found = [];
  const keys = new Set();
  let open = null;
  let expect = null;
  let reasons = 0;
  let failed = false;

  // A Kotlin script error is reported twice: once by the compiler's `e:` line, with a column and the
  // actual message, and again by Gradle's `* Where:`, which names the same line and only says that
  // compilation failed. The second row would be the vaguer copy of the first.
  const admissible = (problem, stage) =>
    !keys.has(keyOf(problem)) &&
    !((stage === "where" || stage === "reason") &&
      found.some((p) => p.line === problem.line && fileKey(p.file) === fileKey(problem.file)));

  function close() {
    if (open && admissible(open, expect)) {
      keys.add(keyOf(open));
      found.push(open);
    }
    open = null;
    expect = null;
  }

  // Whether `line` belongs to the open problem, taking it if it does.
  function extend(line) {
    switch (expect) {
      case "source":
      case "caret":
      case "detail":
        // Blank lines and the progress area are what a repaint leaves between one line of an error
        // and the next; they end nothing.
        if (line === "" || PROGRESS.test(line)) return true;
        if (expect !== "detail" && CARET.test(line)) {
          open.col = line.indexOf("^") + 1;
          open.raw += "\n" + line;
          expect = "detail";
          return true;
        }
        if (expect === "source") {
          open.raw += "\n" + line;
          expect = "caret";
          return true;
        }
        // javac indents its detail lines and nothing else it prints, so the first line that is not
        // indented is the end of this error. Two excerpts and no caret is an end too.
        if (expect === "caret" || !/^\s/.test(line)) return false;
        open.message += "\n" + line.trim();
        open.raw += "\n" + line;
        return true;
      case "where":
        if (line === WHAT_WENT_WRONG) {
          open.raw += "\n" + line;
          expect = "reason";
          return true;
        }
        return !line.startsWith("* ");
      case "reason": {
        if (line.startsWith("* ") || FAILED.test(line)) return false;
        if (line === "") return true;
        const said = line.replace(/^> /, "");
        open.message = reasons++ ? `${open.message}\n${said}` : said;
        open.raw += "\n" + line;
        return true;
      }
      default:
        return false;
    }
  }

  return {
    take(line) {
      if (FAILED.test(line)) failed = true;
      const header = headerOf(line);
      if (open && !header && extend(line)) return;
      close();
      if (!header) return;
      open = header.problem;
      expect = header.expect;
      reasons = 0;
      if (!expect) close();
    },
    failed: () => failed,
    /** Copies, so a problem already handed to someone does not change under them as lines arrive. */
    problems() {
      const all = open && admissible(open, expect) ? [...found, open] : found;
      return all.map((problem) => ({ ...problem }));
    },
  };
}

// ---------------------------------------------------------------- the pure API

/**
 * Every problem a build's output names, in the order it first names them, each one once.
 *
 * `raw` is the problem's lines as printed, escapes removed: for javac that is the error, the source
 * excerpt and the caret as well as the detail lines, which is the context worth handing to someone
 * asked to explain it.
 *
 * @param {string} text  terminal output, escape sequences and all
 * @returns {{ file: string, line: number, col: number|null, severity: "error"|"warning", message: string, raw: string }[]}
 */
export function parseProblems(text) {
  const reader = createReader();
  for (const line of plainLines(text)) reader.take(line);
  return reader.problems();
}

/** A number to sort by: errors before warnings, and anything unrecognised after both. */
export function severityRank(severity) {
  if (severity === "error") return 0;
  if (severity === "warning") return 1;
  return 2;
}

/**
 * Errors first, then warnings, and otherwise the order the build printed them in.
 *
 * Printed order is kept on purpose. The first error is usually the cause of the ones after it - one
 * missing import is twenty "cannot find symbol" - so it has to stay at the top of its group.
 */
export function displayOrder(problems) {
  return (problems || [])
    .map((problem, index) => ({ problem, index }))
    .sort((a, b) => severityRank(a.problem.severity) - severityRank(b.problem.severity) || a.index - b.index)
    .map(({ problem }) => problem);
}

const FAILED_WITHOUT_FILE = "The build failed without naming a file — read the Build tab.";

const counted = (n, noun) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/**
 * The pane's one-line answer.
 *
 * `failed` is the caller's to say, because a build can fail without printing anything this module
 * recognises - a vendordep that will not download, a robot that is not on the network - and "No
 * problems" over a failed build is the one summary worse than none. Warnings seldom fail a build on
 * their own, so when warnings are all that was found, the summary still says where the reason is.
 */
export function summarize(problems, { failed = false } = {}) {
  let errors = 0;
  let warnings = 0;
  for (const problem of problems || []) {
    if (problem?.severity === "error") errors += 1;
    else if (problem?.severity === "warning") warnings += 1;
  }
  const parts = [];
  if (errors) parts.push(counted(errors, "error"));
  if (warnings) parts.push(counted(warnings, "warning"));
  if (!parts.length) return failed ? FAILED_WITHOUT_FILE : "No problems";
  if (failed && !errors) return `${parts.join(", ")}, but the build failed without naming a file — read the Build tab.`;
  return parts.join(", ");
}

/**
 * `file` as it reads inside `root`, or `file` untouched when it is not inside it.
 *
 * Compilers pick their own slashes - javac prints backslashes, Kotlin forward slashes - and the root is
 * whatever the folder picker returned, so the comparison ignores which slash and, as Windows does,
 * which case. It must also end on a separator. `C:\dev\Robot` is not where
 * `C:\dev\Robot-offseason\Robot.java` lives, and two such folders side by side is exactly how a team
 * keeps last season's code.
 */
export function relativize(file, root) {
  const path = String(file ?? "");
  const base = String(root ?? "").replace(/[\\/]+$/, "");
  if (!base || !/[\\/]/.test(path.charAt(base.length))) return path;
  if (fileKey(path.slice(0, base.length)) !== fileKey(base)) return path;
  return path.slice(base.length).replace(/^[\\/]+/, "");
}

/** Whether Gradle said the build failed, in the words it ends a failed build with. */
export function buildFailed(text) {
  return plainLines(text).some((line) => FAILED.test(line));
}

/**
 * The problems as text to paste somewhere else: `path:line: message`, one to a line, with any detail
 * lines indented under the problem they belong to, the way javac prints them.
 *
 * The paths are the ones the pane shows. Pasted into a chat or a forum post, the part inside the
 * project is what a mentor needs, and `C:\Users\<name>\` is not something to hand out by accident.
 */
export function copyText(problems, root) {
  return (problems || [])
    .map((problem) => {
      const [first, ...details] = String(problem.message).split("\n");
      const head = `${relativize(problem.file, root)}:${problem.line}: ${first}`;
      return [head, ...details.map((detail) => `  ${detail}`)].join("\n");
    })
    .join("\n");
}

// ---------------------------------------------------------------- chunks

/**
 * Build output as it arrives, one chunk at a time.
 *
 * A chunk is whatever the PTY reader had gathered when it flushed, so it ends wherever it ends: halfway
 * through a path, inside an escape sequence, between the two halves of `\r\n`. Only whole lines are
 * read, and a line break with nothing after it yet is not proof of a whole line. It may be the `\r` of
 * a `\r\n` whose `\n` is in the next chunk, and taken early that is an empty line the build never
 * printed. Or ConPTY may be about to continue the same line past the terminal's edge, and taken early
 * a javac error cut there is two halves, neither of them an error. So the last line waits until what
 * follows its break says which. The cost is that the final line of the output is read when the next
 * chunk arrives.
 *
 * `cap` bounds the text kept for `text()`. The pane lives as long as the workspace does, and a program
 * left running in its terminal prints for as long as it runs, so without a bound it would keep every
 * line it was ever shown. What goes is the oldest text, a whole line at a time. The problems already
 * found are not lost with it: they were read as their lines arrived, and each is a few hundred bytes.
 */
export function createCollector({ cap = 512 * 1024 } = {}) {
  let reader = createReader();
  let tail = "";
  let kept = [];
  let size = 0;

  const read = (lines) => {
    for (const line of lines) {
      reader.take(line);
      kept.push(line);
      size += line.length + 1;
    }
    let drop = 0;
    while (size > cap && drop < kept.length) size -= kept[drop++].length + 1;
    if (drop) kept.splice(0, drop);
  };

  // The last `\r` or `\n` at or before `from`.
  const lastBreak = (from) => (from < 0 ? -1 : Math.max(tail.lastIndexOf("\n", from), tail.lastIndexOf("\r", from)));

  return {
    push(chunk) {
      if (typeof chunk !== "string" || chunk === "") return;
      tail = joinWrapped(tail + chunk);
      let end = lastBreak(tail.length - 1);
      if (end >= 0 && MAYBE_WRAPPED.test(tail.slice(end + 1))) {
        end = lastBreak((tail[end] === "\n" && tail[end - 1] === "\r" ? end - 1 : end) - 1);
      }
      if (end >= 0) {
        const lines = plainLines(tail.slice(0, end + 1));
        lines.pop(); // the empty string after the final line break, which is not a line
        tail = tail.slice(end + 1);
        read(lines);
      }
      // A tail that has gone this long without a line break - a progress bar redrawn in place all
      // afternoon - is not going to get one, so it is read as it stands rather than kept forever.
      if (tail.length > cap) {
        const lines = plainLines(tail);
        tail = "";
        read(lines);
      }
    },
    problems: () => reader.problems(),
    failed: () => reader.failed(),
    text: () => kept.join("\n"),
    reset() {
      reader = createReader();
      tail = "";
      kept = [];
      size = 0;
    },
  };
}

// ---------------------------------------------------------------- the pane

// Output arrives every 16 ms while a build runs and almost none of it changes the list, so a repaint
// waits for the next frame and a burst of chunks costs one. `node --test` imports this file and has
// no frames at all, which is the only reason the timer is here.
const frames =
  typeof requestAnimationFrame === "function"
    ? { request: (fn) => requestAnimationFrame(fn), cancel: (id) => cancelAnimationFrame(id) }
    : { request: (fn) => setTimeout(fn, 16), cancel: (id) => clearTimeout(id) };

const EMPTY_HINT = "After a build, compiler errors and warnings land here. Click one to jump to its line.";
const FAILED_HINT =
  "Gradle stopped on something that is not a line of code — a dependency, a plugin, the connection " +
  "to the robot. Its own account is in the Build tab, under \"What went wrong\".";

// How long "Copied" stays on the button before it goes back to saying what it does.
const COPIED_MS = 1500;

/**
 * Mount the Problems pane.
 *
 * Feed it the same chunks the terminal gets. Call `reset()` when a new run starts: output from a build
 * that has since been fixed is still a list of places that were wrong, and nothing in the text says
 * where one run ends and the next begins.
 *
 * @param {object}   opts
 * @param {Element}  opts.el        the element to fill; its contents are replaced
 * @param {string}   opts.root      the project directory, which paths are shown relative to
 * @param {function} [opts.onOpen]  (file, line, col) when a problem is chosen; col may be null
 * @param {function} [opts.onAsk]   (problem) from a row's Ask Claude button; without it there is none
 * @returns {{ push, reset, destroy, problems }}
 */
export function mountProblems({ el, root, onOpen, onAsk }) {
  const collector = createCollector();
  el.classList.add("prob-pane");
  el.textContent = "";

  const head = document.createElement("div");
  head.className = "prob-head";
  const summary = document.createElement("span");
  summary.className = "prob-summary";
  summary.setAttribute("role", "status");
  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "cat-btn cat-btn--ghost prob-copy";
  copyBtn.textContent = "Copy";
  copyBtn.title = "Copy every problem as text";
  head.append(summary, copyBtn);

  const list = document.createElement("div");
  list.className = "prob-list";
  list.setAttribute("role", "list");

  const empty = document.createElement("div");
  empty.className = "prob-empty";
  const eyebrow = document.createElement("div");
  eyebrow.className = "cat-eyebrow";
  eyebrow.textContent = "PROBLEMS";
  const emptyText = document.createElement("p");
  emptyText.className = "hint prob-empty-text";
  empty.append(eyebrow, emptyText);

  el.append(head, list, empty);

  let heard = false;
  let destroyed = false;
  let frame = null;
  let painted = null;
  let copyTimer = null;

  const rowFor = (problem) => {
    const key = keyOf(problem);
    // Shown forward-slashed, whichever slashes the compiler chose, because that is how the editor's
    // status bar and the Claude mention write the same file - one file named two ways in one window
    // reads as two files.
    const where = relativize(problem.file, root).replace(/\\/g, "/");
    const isError = problem.severity === "error";

    const row = document.createElement("div");
    row.className = "prob-row";
    row.setAttribute("role", "listitem");
    row.dataset.severity = problem.severity;

    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "prob-open";
    openBtn.dataset.key = key;
    openBtn.title = problem.col ? `${problem.file}:${problem.line}:${problem.col}` : `${problem.file}:${problem.line}`;
    openBtn.addEventListener("click", () => onOpen?.(problem.file, problem.line, problem.col));

    // Shape as well as colour, as .cat-dot draws it; the label is for whoever cannot see either.
    const dot = document.createElement("span");
    dot.className = isError ? "cat-dot cat-dot--bad" : "cat-dot cat-dot--warn";
    dot.setAttribute("role", "img");
    dot.setAttribute("aria-label", isError ? "Error" : "Warning");

    const path = document.createElement("span");
    path.className = "prob-where";
    path.textContent = where;
    const lineNo = document.createElement("span");
    lineNo.className = "prob-line";
    lineNo.textContent = `:${problem.line}`;
    path.appendChild(lineNo);

    const message = document.createElement("span");
    message.className = "prob-msg";
    message.textContent = String(problem.message).split("\n", 1)[0];

    openBtn.append(dot, path, message);
    row.appendChild(openBtn);

    if (onAsk) {
      // A sibling of the row's button, not a child of it. A button inside a button is invalid, so
      // assistive technology is free to flatten it into the row's label, and every click on it would
      // be a click on the row as well.
      const askBtn = document.createElement("button");
      askBtn.type = "button";
      askBtn.className = "cat-btn cat-btn--ghost prob-ask";
      askBtn.dataset.key = key;
      askBtn.textContent = "Ask Claude";
      askBtn.setAttribute("aria-label", `Ask Claude about ${where}:${problem.line}`);
      askBtn.addEventListener("click", (event) => {
        // Nothing above this button may read the click as a request to open the file.
        event.stopPropagation();
        onAsk(problem);
      });
      row.appendChild(askBtn);
    }
    return row;
  };

  const paint = () => {
    frame = null;
    if (destroyed) return;
    const failed = collector.failed();
    const shown = displayOrder(collector.problems());
    // Most frames change nothing. Rebuilding the rows anyway would throw away the focus of anyone
    // moving through them with the keyboard, every sixteen milliseconds, for the length of a build.
    const signature = JSON.stringify([heard, failed, shown.map((p) => [p.severity, keyOf(p)])]);
    if (signature === painted) return;
    painted = signature;

    // Before any output, "No problems" would be a verdict on a build nobody has started.
    summary.textContent = heard ? summarize(shown, { failed }) : "Nothing built yet";
    const errors = shown.some((p) => p.severity === "error");
    summary.dataset.tone = errors || failed ? "bad" : shown.length ? "warn" : "dim";
    copyBtn.hidden = shown.length === 0;
    list.hidden = shown.length === 0;
    empty.hidden = shown.length > 0;
    emptyText.textContent = failed ? FAILED_HINT : EMPTY_HINT;

    const focused = list.contains(document.activeElement) ? document.activeElement : null;
    const scroll = list.scrollTop;
    const rows = document.createDocumentFragment();
    for (const problem of shown) rows.appendChild(rowFor(problem));
    list.replaceChildren(rows);
    list.scrollTop = scroll;
    if (focused) {
      const again = [...list.querySelectorAll("button")].find(
        (b) => b.dataset.key === focused.dataset.key && b.className === focused.className,
      );
      again?.focus();
    }
  };

  const schedule = () => {
    if (frame === null && !destroyed) frame = frames.request(paint);
  };

  copyBtn.addEventListener("click", () => {
    const text = copyText(displayOrder(collector.problems()), root);
    const say = (label) => {
      if (destroyed) return;
      copyBtn.textContent = label;
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => { copyBtn.textContent = "Copy"; }, COPIED_MS);
    };
    const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : null;
    if (!clipboard?.writeText) {
      say("Could not copy");
      return;
    }
    clipboard.writeText(text).then(() => say("Copied"), () => say("Could not copy"));
  });

  paint();

  return {
    push(chunk) {
      if (destroyed || typeof chunk !== "string" || chunk === "") return;
      // A PTY opens by sending escape sequences and nothing else. That is not a build saying anything.
      if (!heard && /\S/.test(stripAnsi(chunk))) heard = true;
      collector.push(chunk);
      schedule();
    },
    reset() {
      if (destroyed) return;
      collector.reset();
      heard = false;
      schedule();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (frame !== null) frames.cancel(frame);
      frame = null;
      clearTimeout(copyTimer);
      el.textContent = "";
      el.classList.remove("prob-pane");
    },
    problems: () => collector.problems(),
  };
}
