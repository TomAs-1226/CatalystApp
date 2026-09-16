//! What a Claude Code session needs before it is useful in a robot project.
//!
//! A session started in a project folder knows nothing about Catalyst. It will happily write 1.x
//! code — `SubsystemBase`, `CommandScheduler.getInstance()`, `ChassisSpeeds` — because that is what
//! most of the FRC code in the world looks like, and none of it compiles against Catalyst 2.x. Two
//! files fix that, and this module writes them.
//!
//! `.mcp.json` points the session at the MCP server this app already carries, so the API can be
//! looked up instead of recalled. `CLAUDE.md` says which season this is, how it builds, and that
//! nothing gets pushed unasked.
//!
//! # Merging, not replacing
//!
//! `.mcp.json` is the user's file. A team may already have servers in it, and a workspace feature
//! that replaced the file to add one would take those away without saying so. So the document is
//! read, the `catalyst` entry is set, and everything else is written back untouched — and a file
//! that cannot be parsed is an error rather than something to overwrite. `CLAUDE.md` is stronger
//! still: if it exists at all, it is left exactly as it is. Instructions someone wrote for their own
//! project are not ours to replace.

use serde::Serialize;
use std::path::Path;

#[derive(Serialize)]
pub struct AgentStatus {
    /// Where the Claude Code CLI is, when it was found.
    pub cli_path: Option<String>,
    pub cli_version: Option<String>,
    /// Whether this project's `.mcp.json` names the catalyst server.
    pub mcp_wired: bool,
    /// Whether this project has a `CLAUDE.md`. Its contents are not inspected — someone else's
    /// instructions are still instructions.
    pub claude_md: bool,
    /// Whether the projects registry lists this folder. It is the boundary for writing into it.
    pub project_registered: bool,
}

/// What `agent_prepare` puts in `.mcp.json`, as the contract writes it.
fn catalyst_server(server_path: &str) -> serde_json::Value {
    serde_json::json!({ "command": "node", "args": [server_path] })
}

// ------------------------------------------------------------------ the pure decisions

/// Whether a `.mcp.json` already names a usable catalyst server.
///
/// An entry with no command, or with no server path in its arguments, is a leftover rather than a
/// wiring: reporting it as wired would leave the user looking at a green tick and a session that
/// cannot see the library.
pub fn mcp_wired(existing: &str) -> bool {
    let Ok(doc) = serde_json::from_str::<serde_json::Value>(existing) else {
        return false;
    };
    let Some(server) = doc.get("mcpServers").and_then(|s| s.get("catalyst")) else {
        return false;
    };
    let has_command = server
        .get("command")
        .and_then(|c| c.as_str())
        .is_some_and(|c| !c.trim().is_empty());
    let has_path = server
        .get("args")
        .and_then(|a| a.as_array())
        .and_then(|a| a.first())
        .and_then(|a| a.as_str())
        .is_some_and(|a| !a.trim().is_empty());
    has_command && has_path
}

/// `existing` with the catalyst server added or refreshed, and everything else left alone.
pub fn merged_mcp(existing: Option<&str>, server_path: &str) -> Result<String, String> {
    let mut doc: serde_json::Value = match existing.map(str::trim).filter(|s| !s.is_empty()) {
        None => serde_json::json!({}),
        Some(text) => serde_json::from_str(text).map_err(|e| {
            // Overwriting here would be the one unrecoverable outcome: whatever servers that file
            // named are gone, and the user finds out the next time they need one.
            format!(
                ".mcp.json is there but is not valid JSON ({e}). Fix or move it - Catalyst will not \
                 overwrite a file it cannot read."
            )
        })?,
    };

    let Some(root) = doc.as_object_mut() else {
        return Err(".mcp.json does not hold a JSON object, so there is nothing to merge into.".into());
    };
    let servers = root
        .entry("mcpServers")
        .or_insert_with(|| serde_json::json!({}));
    let Some(servers) = servers.as_object_mut() else {
        return Err("\"mcpServers\" in .mcp.json is not an object, so it was left alone.".into());
    };
    servers.insert("catalyst".into(), catalyst_server(server_path));

    serde_json::to_string_pretty(&doc)
        .map(|s| s + "\n")
        .map_err(|e| e.to_string())
}

/// Whether a string reads as a version number: digits, dots, digits.
pub fn looks_like_version(s: &str) -> bool {
    s.contains('.')
        && s.split('.')
            .all(|part| !part.is_empty() && part.starts_with(|c: char| c.is_ascii_digit()))
}

/// The version out of an installer path like `...\claude-code\2.1.271\claude.exe`.
///
/// Free, where running the CLI to ask costs half a second of a process start on every status read.
pub fn version_from_path(exe: &str) -> Option<String> {
    let name = Path::new(exe).parent()?.file_name()?.to_string_lossy().to_string();
    looks_like_version(&name).then_some(name)
}

/// The version out of whatever `claude --version` printed.
pub fn version_from_output(out: &str) -> Option<String> {
    out.split_whitespace()
        .find(|token| looks_like_version(token))
        .map(str::to_string)
}

/// The `CLAUDE.md` written for a project that has none.
///
/// Short on purpose, and only facts that hold for every Catalyst 2.x project: which season it is,
/// where the API comes from, how it builds, and that nothing is pushed unasked. Nothing here guesses
/// at the robot — a file that describes a swerve drive to a team that built an arm is worse than no
/// file, because the session believes it.
pub fn claude_md(project_name: &str) -> String {
    claude_md_with(project_name, shared_memory_index().as_deref())
}

/// Where this machine keeps the memory Claude writes across sessions.
///
/// That memory lives per project directory, under `~/.claude/projects/<slug>/memory`, and
/// `MEMORY.md` is the index a session loads. A session started inside the robot project gets its own
/// slug and therefore none of it — which is why an agent in this window would know the Catalyst API
/// and nothing about the robot it had been worked on all week.
///
/// `CLAUDE.md` can import another file with `@path`, so this points at the index rather than copying
/// it: one line, in a file the user can read and delete. The most recently written index wins,
/// because that is the project directory actually being worked in.
pub fn shared_memory_index() -> Option<String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()?;
    let projects = Path::new(&home).join(".claude").join("projects");
    let mut best: Option<(std::time::SystemTime, String)> = None;

    for entry in std::fs::read_dir(projects).ok()?.filter_map(|e| e.ok()) {
        let index = entry.path().join("memory").join("MEMORY.md");
        let Ok(meta) = std::fs::metadata(&index) else { continue };
        let Ok(modified) = meta.modified() else { continue };
        if best.as_ref().is_none_or(|(seen, _)| modified > *seen) {
            best = Some((modified, index.to_string_lossy().to_string()));
        }
    }
    best.map(|(_, path)| path)
}

/// The body, with the memory index handed in so a test does not depend on this machine.
pub fn claude_md_with(project_name: &str, memory_index: Option<&str>) -> String {
    let memory = match memory_index {
        Some(path) => format!(
            "\n\
             ## What has already been worked out\n\
             \n\
             @{path}\n\
             \n\
             That is this machine's Catalyst work history: the decisions, the measurements, and the\n\
             things that turned out not to be true. Read it before re-deriving something, and say so\n\
             when you are contradicting it. Delete this section to work without it.\n"
        ),
        None => String::new(),
    };

    format!(
        "# {project_name}\n\
         \n\
         A WPILib 2027 robot project built against FrcCatalyst 2.x.\n\
         \n\
         ## Look the API up, do not recall it\n\
         \n\
         The `catalyst` MCP server is wired into this project in `.mcp.json`. Use it to find\n\
         Catalyst classes, methods and documentation before writing against them. Catalyst 2.x is a\n\
         WPILib 2027 and Commands v3 library, and its API differs from the 1.x code that dominates\n\
         training data: there is no `SubsystemBase`, no `CommandScheduler.getInstance()`,\n\
         `ChassisSpeeds` is `ChassisVelocities`, and `Timer.getFPGATimestamp()` is\n\
         `Timer.getTimestamp()`. Assume nothing; look it up.\n\
         \n\
         ## Building\n\
         \n\
         `devtools gradle -- build` builds this project with the JDK its branch needs.\n\
         \n\
         ## Ask the graph before you read the source\n\
         \n\
         The `catalyst` server can build a structural knowledge graph of THIS project with\n\
         `catalyst_graph_build` — no model calls, no token cost — and then answer where a symbol\n\
         lives (`catalyst_graph_search`), what it connects to (`catalyst_graph_neighbors`), how two\n\
         things relate (`catalyst_graph_path`) and what a file reaches outside itself\n\
         (`catalyst_graph_file`). Build it once per session and ask it first: grepping a robot\n\
         project for a name you half-remember is the slow way to the same answer. The same tools\n\
         already answer for the Catalyst library itself, whose graph ships with the app.\n\
         \n\
         ## Git\n\
         \n\
         Never push, tag or release unless it was asked for in the current session.\n\
         {memory}"
    )
}

// ------------------------------------------------------------------ the files

/// Write the two files into `dir`, merging the first and never replacing the second.
///
/// Split from the command so it can be tested against real files without an app running: the whole
/// point of this function is what it does to a file that is already there.
pub(crate) fn write_agent_files(dir: &Path, server_path: &str) -> Result<(), String> {
    let mcp = dir.join(".mcp.json");
    let existing = std::fs::read_to_string(&mcp).ok();
    let merged = merged_mcp(existing.as_deref(), server_path)?;
    std::fs::write(&mcp, merged).map_err(|e| format!("cannot write {}: {e}", mcp.display()))?;

    let guide = dir.join("CLAUDE.md");
    if !guide.exists() {
        let name = dir
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "Robot project".into());
        std::fs::write(&guide, claude_md(&name))
            .map_err(|e| format!("cannot write {}: {e}", guide.display()))?;
    }
    Ok(())
}

/// Look at a project and at this machine, and report both.
fn status_for(dir: &Path, roots: &[String]) -> AgentStatus {
    let cli_path = crate::pty::resolve_claude(&crate::pty::gather())
        .ok()
        .map(|p| p.program);
    let cli_version = cli_path.as_deref().and_then(cli_version);

    let mcp = std::fs::read_to_string(dir.join(".mcp.json")).unwrap_or_default();

    AgentStatus {
        cli_path,
        cli_version,
        mcp_wired: mcp_wired(&mcp),
        claude_md: dir.join("CLAUDE.md").is_file(),
        project_registered: crate::workspace::is_registered(dir, roots),
    }
}

/// The CLI's version: from its path when the installer's layout gives it away, otherwise by asking.
fn cli_version(exe: &str) -> Option<String> {
    version_from_path(exe).or_else(|| ask_version(exe))
}

fn ask_version(exe: &str) -> Option<String> {
    let mut cmd = std::process::Command::new(exe);
    cmd.arg("--version");
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW. Without it a console window opens and closes on top of the app every
        // time the workspace asks, which looks exactly like something crashing.
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd.output().ok()?;
    let printed = String::from_utf8_lossy(&out.stdout).to_string();
    version_from_output(&printed)
}

fn registered_roots(app: &tauri::AppHandle) -> Vec<String> {
    crate::projects::list_projects(app.clone())
        .into_iter()
        .map(|p| p.path)
        .collect()
}

// ------------------------------------------------------------------ commands

/// Is the CLI here, is this project wired, and which version would run.
#[tauri::command]
pub fn agent_status(app: tauri::AppHandle, dir: String) -> AgentStatus {
    status_for(Path::new(&dir), &registered_roots(&app))
}

/// Write `.mcp.json` and `CLAUDE.md`, then report where that left the project.
#[tauri::command]
pub fn agent_prepare(app: tauri::AppHandle, dir: String) -> Result<AgentStatus, String> {
    let path = Path::new(&dir);
    if !path.is_dir() {
        return Err(format!("not a folder: {dir}"));
    }

    // The same boundary the editor writes behind. Preparing a project is still writing two files
    // into it, and there is no reason for that to have a weaker rule than saving a file does.
    let roots = registered_roots(&app);
    if !crate::workspace::is_registered(path, &roots) {
        return Err(format!(
            "refused to write into {dir}: it is not a project Catalyst knows about. \
             Import the project first."
        ));
    }

    // The path the app already computes for its own resources. Re-deriving it here would be a
    // second answer to where the server lives, and one of them would eventually be wrong.
    let server_path = crate::mcp_server_path(app.clone())?;
    write_agent_files(path, &server_path)?;
    Ok(status_for(path, &roots))
}

#[cfg(test)]
#[path = "agent_tests.rs"]
mod tests;
