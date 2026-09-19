//! Terminals: a pseudo-terminal per pane, the programs they run, and the output that reaches the
//! window.
//!
//! Three kinds of terminal, and each one exists because the alternative was worse. A shell, because
//! a robot project is still a folder someone wants a prompt in. `devtools`, because the build rules
//! for this machine live in that script and re-deriving them in Rust would make a second source of
//! truth for which JDK a branch needs. And `claude`, because the whole point of the workspace is a
//! Claude Code session already pointed at the project with Catalyst's MCP server wired in.
//!
//! # Why a PTY and not `Command`
//!
//! All three are interactive. Claude Code draws a full-screen UI, `devtools` prints progress, and a
//! shell is a shell. A piped `Command` gives them no terminal, so they turn colour off, stop
//! redrawing, and in Claude Code's case refuse to run at all. ConPTY on Windows is what makes them
//! behave as they do in a real terminal, and `portable-pty` is the thin wrapper over it.
//!
//! # Why the output is coalesced
//!
//! A PTY hands back whatever the child wrote, which for a redrawing UI is a few bytes at a time,
//! thousands of times a second. One Tauri event per read crosses the IPC boundary each time, and
//! Catalyst Console already learned what that costs: at 20 Hz of NetworkTables updates the window
//! stopped responding. So the reader buffers and emits at most every 16 ms, or at 8 KiB, whichever
//! comes first. The decision itself is [`should_flush`], which is pure so it can be tested without a
//! terminal in the room.

use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tauri::Emitter;

/// Emit no later than this after the first byte of a chunk.
///
/// 16 ms is one frame at 60 Hz. Anything longer is visible as lag while you type; anything shorter
/// buys nothing, because the window cannot paint faster than it refreshes.
const FLUSH_INTERVAL: Duration = Duration::from_millis(16);

/// Emit early once this much has piled up, so a `gradlew build` dumping its whole log does not wait
/// on the clock and then send one enormous event.
const FLUSH_BYTES: usize = 8 * 1024;

/// How long to wait for the reader to go quiet after the child has exited, before giving up on more
/// output and emitting `pty://exit`.
///
/// ConPTY does not always close the output pipe the moment the child does, so the exit is noticed by
/// polling rather than by end-of-file. This is the grace period that keeps the last few lines of a
/// failed build from being cut off.
const EXIT_GRACE: Duration = Duration::from_millis(120);

/// How long to block on the channel when there is nothing buffered.
///
/// With an empty buffer there is nothing to flush, so the only thing this bounds is how quickly a
/// child that exited without closing its pipe is noticed. Polling at the flush interval instead
/// would wake every idle terminal 60 times a second to ask a question whose answer is almost always
/// no.
const IDLE_POLL: Duration = Duration::from_millis(100);

// ------------------------------------------------------------------ the pure decisions

/// Whether the buffered output should go out now.
///
/// Empty is never worth an event: the pump wakes on a timer, and without this it would emit an empty
/// string sixty times a second at an idle prompt.
pub fn should_flush(buffered: usize, since_last: Duration) -> bool {
    buffered != 0 && (buffered >= FLUSH_BYTES || since_last >= FLUSH_INTERVAL)
}

/// How long the pump may block before it has to look at the buffer again.
///
/// Split out from the loop because getting it wrong is invisible in a test that only checks the
/// output: too long and typing feels sticky, too short and a dozen idle terminals burn a core.
pub fn poll_wait(buffered: usize, since_last: Duration) -> Duration {
    if buffered == 0 {
        return IDLE_POLL;
    }
    // At least a millisecond, or a `recv_timeout(0)` becomes a spin loop.
    FLUSH_INTERVAL.saturating_sub(since_last).max(Duration::from_millis(1))
}

/// How much of `buf` can be turned into text without inventing a replacement character.
///
/// A PTY read ends wherever the pipe happened to be, which for anything that draws box characters or
/// emoji — Claude Code's whole UI — is regularly halfway through a multi-byte sequence. Emitting that
/// prefix lossily puts a permanent `U+FFFD` in the terminal, so the partial tail is held back for the
/// next chunk instead. `final_flush` is the exception: at end of file there is no next chunk, and
/// showing the mangled byte beats swallowing it.
pub fn utf8_boundary(buf: &[u8], final_flush: bool) -> usize {
    if final_flush {
        return buf.len();
    }
    match std::str::from_utf8(buf) {
        Ok(_) => buf.len(),
        // `error_len() == None` means the input simply stopped mid-sequence, which is the case worth
        // waiting on. A `Some` is genuinely invalid data and waiting would never fix it.
        Err(e) if e.error_len().is_none() => e.valid_up_to(),
        Err(_) => buf.len(),
    }
}

// ------------------------------------------------------------------ which program to run

/// A program and its arguments, as resolved from this machine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Program {
    pub program: String,
    pub args: Vec<String>,
}

/// Everything about the machine that program resolution depends on, read once and passed in.
///
/// The resolution rules are the part worth testing — a fallback that silently runs the wrong
/// `devtools`, or a `claude` picker that thinks 2.1.9 is newer than 2.1.271, is exactly the kind of
/// bug that only shows up on someone else's laptop. Gathering the facts is separated from deciding
/// on them so the deciding can be tested against machines nobody has.
#[derive(Debug, Clone, Default)]
pub struct Candidates {
    /// Whether the shell rule should be the Windows one.
    pub windows: bool,
    /// `$SHELL`, where there is one.
    pub shell: Option<String>,
    /// The text of `~/bin/devtools`, the `sh` shim, when it is there.
    pub devtools_shim: Option<String>,
    /// `~/dev/devtools/devtools.py`, only when the file exists.
    pub devtools_script: Option<String>,
    /// `CATALYST_CLAUDE_EXE`.
    pub claude_env: Option<String>,
    /// `claude` / `claude.exe` found on `PATH`.
    pub claude_on_path: Option<String>,
    /// Installed Claude Code builds as (version directory name, path to the executable).
    pub claude_installed: Vec<(String, String)>,
}

/// The program for a terminal kind, or why there isn't one.
pub fn resolve(kind: &str, args: &[String], c: &Candidates) -> Result<Program, String> {
    match kind {
        "shell" => Ok(resolve_shell(c)),
        "devtools" => resolve_devtools(args, c),
        "claude" => resolve_claude(c),
        other => Err(format!("unknown terminal kind: {other}")),
    }
}

/// PowerShell on Windows, the login shell elsewhere.
///
/// `-NoLogo` because the copyright banner is the first thing in a pane that is three lines tall.
pub fn resolve_shell(c: &Candidates) -> Program {
    if c.windows {
        Program { program: "powershell.exe".into(), args: vec!["-NoLogo".into()] }
    } else {
        let shell = c.shell.clone().filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "/bin/sh".into());
        Program { program: shell, args: vec!["-l".into()] }
    }
}

/// The two quoted paths out of a shim's `exec` line: the interpreter, then the script.
///
/// `devtools` on PATH is a `sh` script, and `sh` is not a thing a Tauri app can count on having on
/// Windows. The shim already names the exact Python and the exact script, so reading it is both
/// simpler and more accurate than guessing where either lives.
pub fn shim_paths(shim: &str) -> Option<(String, String)> {
    let line = shim.lines().map(str::trim).find(|l| l.starts_with("exec"))?;

    let mut quoted: Vec<String> = Vec::new();
    let mut rest = line;
    while let Some(at) = rest.find(['"', '\'']) {
        let q = rest[at..].chars().next()?;
        let after = &rest[at + q.len_utf8()..];
        match after.find(q) {
            Some(end) => {
                quoted.push(after[..end].to_string());
                rest = &after[end + q.len_utf8()..];
            }
            None => break,
        }
    }

    let (python, script) = (quoted.first()?, quoted.get(1)?);
    // `"$@"` is quoted too, so a shim that named only one path would otherwise hand back the
    // argument placeholder as if it were the script.
    if python.contains('$') || script.contains('$') {
        return None;
    }
    Some((python.clone(), script.clone()))
}

/// `devtools`, through its Python rather than through `sh`.
pub fn resolve_devtools(args: &[String], c: &Candidates) -> Result<Program, String> {
    let with_script = |program: String, script: String| {
        let mut a = vec![script];
        a.extend(args.iter().cloned());
        Program { program, args: a }
    };

    if let Some((python, script)) = c.devtools_shim.as_deref().and_then(shim_paths) {
        return Ok(with_script(python, script));
    }
    if let Some(script) = c.devtools_script.clone() {
        // No shim, but the checkout is there. `python` off PATH is a guess, and a wrong one is a
        // clear error from Python rather than a silent success, which is the right way round.
        return Ok(with_script("python".into(), script));
    }
    // Never fall through to something else that happens to be called devtools. The command it would
    // have run modifies repositories.
    Err("devtools is not installed on this machine".into())
}

/// The Claude Code CLI: the override, then PATH, then the newest installed build.
pub fn resolve_claude(c: &Candidates) -> Result<Program, String> {
    let exe = c
        .claude_env
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| c.claude_on_path.clone())
        .or_else(|| newest_claude(&c.claude_installed).map(|(_, path)| path));

    match exe {
        // No arguments on purpose: `claude -p` reports "Not logged in" here, because authentication
        // belongs to the desktop app and print mode does not go looking for it. The session has to be
        // interactive, in the PTY.
        Some(exe) => Ok(Program { program: exe, args: Vec::new() }),
        None => Err("Claude Code was not found. Set CATALYST_CLAUDE_EXE, or put claude on PATH.".into()),
    }
}

/// A version string as numbers, so `2.1.271` sorts above `2.1.9`.
///
/// Sorting these as strings is the bug this exists to prevent: the installer keeps every build it
/// has ever fetched in its own directory, so the list is long and `2.1.9` is alphabetically last.
pub fn version_key(v: &str) -> Vec<u64> {
    v.split('.')
        .map(|part| {
            let digits: String = part.chars().take_while(char::is_ascii_digit).collect();
            digits.parse::<u64>().unwrap_or(0)
        })
        .collect()
}

/// The highest-versioned entry, or `None` when there are none.
pub fn newest_claude(installed: &[(String, String)]) -> Option<(String, String)> {
    installed.iter().max_by_key(|(version, _)| version_key(version)).cloned()
}

/// Read this machine into a [`Candidates`].
pub fn gather() -> Candidates {
    let home = home_dir();
    let exists = |p: PathBuf| p.is_file().then(|| p.to_string_lossy().to_string());

    Candidates {
        windows: cfg!(windows),
        shell: std::env::var("SHELL").ok(),
        devtools_shim: home
            .as_ref()
            .and_then(|h| std::fs::read_to_string(h.join("bin").join("devtools")).ok()),
        devtools_script: home
            .as_ref()
            .and_then(|h| exists(h.join("dev").join("devtools").join("devtools.py"))),
        claude_env: std::env::var("CATALYST_CLAUDE_EXE").ok(),
        claude_on_path: which("claude"),
        claude_installed: installed_claude_builds(),
    }
}

fn home_dir() -> Option<PathBuf> {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var).map(PathBuf::from)
}

/// The first `name` on `PATH`, trying the Windows executable suffixes where they apply.
fn which(name: &str) -> Option<String> {
    let suffixes: &[&str] = if cfg!(windows) { &[".exe", ".cmd", ".bat", ""] } else { &[""] };
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        for suffix in suffixes {
            let candidate = dir.join(format!("{name}{suffix}"));
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().to_string());
            }
        }
    }
    None
}

/// Claude Code builds the desktop installer has put down, newest first is decided later.
fn installed_claude_builds() -> Vec<(String, String)> {
    let Some(appdata) = std::env::var_os("APPDATA") else {
        return Vec::new();
    };
    let root = PathBuf::from(appdata).join("Claude").join("claude-code");
    let Ok(entries) = std::fs::read_dir(&root) else {
        return Vec::new();
    };
    entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let exe = e.path().join("claude.exe");
            exe.is_file()
                .then(|| (e.file_name().to_string_lossy().to_string(), exe.to_string_lossy().to_string()))
        })
        .collect()
}

// ------------------------------------------------------------------ sessions

#[derive(Deserialize)]
pub struct PtyOpen {
    /// `"shell"`, `"devtools"` or `"claude"` — which program this pane runs.
    pub kind: String,
    /// The project directory the program starts in. Must already exist.
    pub cwd: String,
    /// For `"devtools"`, the arguments after the command name, e.g. `["gradle", "--", "build"]`.
    pub args: Vec<String>,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Serialize, Clone)]
pub struct PtyInfo {
    pub id: String,
    pub kind: String,
    pub cwd: String,
    pub alive: bool,
    pub exit_code: Option<i32>,
}

/// What the pump thread has learned about the child, readable from a command.
#[derive(Debug)]
struct Status {
    alive: bool,
    exit_code: Option<i32>,
}

/// One live terminal.
///
/// The child itself is not here: it belongs to the pump thread, which is the only thing that waits
/// on it. What stays behind is a killer — `portable-pty` hands out as many as you like — so closing
/// a pane does not have to take the child away from the thread reporting its exit.
pub struct PtySession {
    seq: usize,
    kind: String,
    cwd: String,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    pump: Option<JoinHandle<()>>,
    status: Arc<Mutex<Status>>,
}

#[derive(Default)]
pub struct PtyRegistry(Mutex<HashMap<String, PtySession>>);

#[derive(Clone, Serialize)]
struct DataEvent {
    id: String,
    data: String,
}

#[derive(Clone, Serialize)]
struct ExitEvent {
    id: String,
    code: Option<i32>,
}

fn next_id() -> String {
    static NEXT: AtomicUsize = AtomicUsize::new(1);
    format!("pty-{}", NEXT.fetch_add(1, Ordering::Relaxed))
}

/// A poisoned registry means a command panicked while holding it. Nothing here can recover from
/// that, and saying so beats unwrapping into a crash that names a mutex.
fn locked(state: &PtyRegistry) -> Result<std::sync::MutexGuard<'_, HashMap<String, PtySession>>, String> {
    state.0.lock().map_err(|_| "the terminal registry is in a broken state; restart the app".to_string())
}

/// Start a program in a new pseudo-terminal and stream it to the window.
#[tauri::command]
pub fn pty_open(
    app: tauri::AppHandle,
    state: tauri::State<'_, PtyRegistry>,
    req: PtyOpen,
) -> Result<String, String> {
    let cwd = Path::new(&req.cwd);
    if !cwd.is_dir() {
        return Err(format!("not a directory: {}", req.cwd));
    }
    let program = resolve(&req.kind, &req.args, &gather())?;

    // A zero-sized terminal is what a pane that has not been laid out yet reports, and programs that
    // draw react to it by wrapping every line at column zero.
    let size = PtySize {
        rows: req.rows.max(1),
        cols: req.cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = native_pty_system()
        .openpty(size)
        .map_err(|e| format!("could not open a terminal: {e}"))?;
    let portable_pty::PtyPair { slave, master } = pair;

    let mut cmd = CommandBuilder::new(&program.program);
    cmd.args(&program.args);
    cmd.cwd(cwd);
    // The child inherits this process's environment, which is what makes `devtools` and the Claude
    // CLI behave as they do in a real terminal. These two are the exception: a program that is told
    // nothing about its terminal assumes the dumbest one and turns colour off.
    if std::env::var_os("TERM").is_none() {
        cmd.env("TERM", "xterm-256color");
    }
    cmd.env("COLORTERM", "truecolor");

    let child = slave
        .spawn_command(cmd)
        .map_err(|e| format!("could not start {}: {e}", program.program))?;
    // The slave end has to go now. While this process still holds one, the reader never sees end of
    // file, so a child that exits leaves a pane that looks like it is still thinking.
    drop(slave);

    let killer = child.clone_killer();
    let reader = master
        .try_clone_reader()
        .map_err(|e| format!("could not read from the terminal: {e}"))?;
    let writer = master
        .take_writer()
        .map_err(|e| format!("could not write to the terminal: {e}"))?;

    let id = next_id();
    let status = Arc::new(Mutex::new(Status { alive: true, exit_code: None }));

    // Two threads, because a blocking read cannot also keep a 16 ms clock. The reader only moves
    // bytes; the pump owns the coalescing, the child, and both events.
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || read_into(reader, tx));
    let pump = std::thread::spawn({
        let app = app.clone();
        let id = id.clone();
        let status = Arc::clone(&status);
        move || pump_output(app, id, rx, child, status)
    });

    let seq = NEXT_SEQ.fetch_add(1, Ordering::Relaxed);
    locked(&state)?.insert(
        id.clone(),
        PtySession {
            seq,
            kind: req.kind,
            cwd: req.cwd,
            master,
            writer,
            killer,
            pump: Some(pump),
            status,
        },
    );
    Ok(id)
}

/// Insertion order, so the pane list does not reshuffle itself every time it is read.
static NEXT_SEQ: AtomicUsize = AtomicUsize::new(0);

/// Raw bytes to the child's stdin. Keystrokes, and whatever the frontend pastes.
#[tauri::command]
pub fn pty_write(state: tauri::State<'_, PtyRegistry>, id: String, data: String) -> Result<(), String> {
    let mut map = locked(&state)?;
    let session = map.get_mut(&id).ok_or_else(|| format!("no terminal called {id}"))?;
    session
        .writer
        .write_all(data.as_bytes())
        .and_then(|_| session.writer.flush())
        .map_err(|e| format!("could not write to {id}: {e}"))
}

/// Tell the child the window changed shape, so it redraws at the new size.
#[tauri::command]
pub fn pty_resize(
    state: tauri::State<'_, PtyRegistry>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let map = locked(&state)?;
    let session = map.get(&id).ok_or_else(|| format!("no terminal called {id}"))?;
    session
        .master
        .resize(PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("could not resize {id}: {e}"))
}

/// Kill the child and take the pane down.
#[tauri::command]
pub fn pty_close(state: tauri::State<'_, PtyRegistry>, id: String) -> Result<(), String> {
    // Out of the map first, then everything else outside the lock: joining a thread while holding
    // the registry would stop every other terminal for as long as this one takes to die.
    let mut session = locked(&state)?
        .remove(&id)
        .ok_or_else(|| format!("no terminal called {id}"))?;

    let _ = session.killer.kill();
    let pump = session.pump.take();
    // Dropping the session closes the master, which closes the pty, which is what ends the reader.
    drop(session);
    if let Some(handle) = pump {
        let _ = handle.join();
    }
    Ok(())
}

/// Every terminal this window has opened, and whether it is still running.
#[tauri::command]
pub fn pty_list(state: tauri::State<'_, PtyRegistry>) -> Vec<PtyInfo> {
    let Ok(map) = state.0.lock() else {
        return Vec::new();
    };
    let mut out: Vec<(usize, PtyInfo)> = map
        .iter()
        .map(|(id, s)| {
            let (alive, exit_code) = match s.status.lock() {
                Ok(st) => (st.alive, st.exit_code),
                Err(_) => (false, None),
            };
            (
                s.seq,
                PtyInfo {
                    id: id.clone(),
                    kind: s.kind.clone(),
                    cwd: s.cwd.clone(),
                    alive,
                    exit_code,
                },
            )
        })
        .collect();
    out.sort_by_key(|(seq, _)| *seq);
    out.into_iter().map(|(_, info)| info).collect()
}

/// Move bytes off the pty and onto the channel. Nothing else, so that nothing else blocks on a read.
fn read_into(mut reader: Box<dyn Read + Send>, tx: Sender<Vec<u8>>) {
    let mut buf = [0u8; 4096];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if tx.send(buf[..n].to_vec()).is_err() {
                    break; // the pump is gone, so there is nobody to read this
                }
            }
            Err(_) => break,
        }
    }
}

/// Coalesce, emit, and report the exit. The only thread that touches the window for this session.
fn pump_output(
    app: tauri::AppHandle,
    id: String,
    rx: Receiver<Vec<u8>>,
    mut child: Box<dyn Child + Send + Sync>,
    status: Arc<Mutex<Status>>,
) {
    let mut buf: Vec<u8> = Vec::with_capacity(FLUSH_BYTES);
    let mut last = Instant::now();
    // Set when the child is first seen to have exited, cleared by anything that arrives afterwards.
    let mut gone_since: Option<Instant> = None;

    let code = loop {
        match rx.recv_timeout(poll_wait(buf.len(), last.elapsed())) {
            Ok(chunk) => {
                buf.extend_from_slice(&chunk);
                gone_since = None;
            }
            Err(RecvTimeoutError::Disconnected) => {
                // End of file: the child is done and so is its output. Draining is not needed —
                // `recv_timeout` only disconnects once the channel is empty.
                break child.wait().ok().map(|s| s.exit_code() as i32);
            }
            Err(RecvTimeoutError::Timeout) => {
                if let Ok(Some(st)) = child.try_wait() {
                    let since = *gone_since.get_or_insert_with(Instant::now);
                    if since.elapsed() >= EXIT_GRACE {
                        break Some(st.exit_code() as i32);
                    }
                }
            }
        }
        if should_flush(buf.len(), last.elapsed()) {
            emit_data(&app, &id, &mut buf, false);
            // Restarted whether or not anything went out. A buffer holding nothing but half a
            // character emits nothing, and without this the pump would ask again every millisecond
            // until the rest of it arrived.
            last = Instant::now();
        }
    };

    emit_data(&app, &id, &mut buf, true);
    if let Ok(mut st) = status.lock() {
        st.alive = false;
        st.exit_code = code;
    }
    let _ = app.emit("pty://exit", ExitEvent { id, code });
}

/// Send what is buffered, keeping back a half-finished character unless this is the last chunk.
fn emit_data(app: &tauri::AppHandle, id: &str, buf: &mut Vec<u8>, final_flush: bool) {
    let upto = utf8_boundary(buf, final_flush);
    if upto == 0 {
        return;
    }
    let data = String::from_utf8_lossy(&buf[..upto]).to_string();
    buf.drain(..upto);
    let _ = app.emit("pty://data", DataEvent { id: id.to_string(), data });
}

#[cfg(test)]
#[path = "pty_tests.rs"]
mod tests;
