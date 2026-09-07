//! The project registry: what Catalyst knows about the robot projects on this machine.
//!
//! Two processes need this list and only one of them is Tauri. The app writes it when you import a
//! project; the bundled MCP server reads it so an agent can find your code, see what you configured,
//! and - only where you have said so - write to it. localStorage cannot do that job: it belongs to
//! the webview and a separate Node process cannot see it. So the registry is a plain JSON file in
//! the app's data directory, and both sides agree on where that is.
//!
//! # It is also the permission boundary
//!
//! The MCP server will not write outside a registered project, and will not write to a registered
//! project whose `agent_write` flag is false. That flag defaults to **false** and is turned on per
//! project, in the app, by a person. This is the whole security model and it is deliberately small
//! enough to hold in your head: the app is where consent is given, the registry is where it is
//! recorded, and the server refuses anything the registry does not cover.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// One project the user has imported.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    /// Absolute path to the project root.
    pub path: String,
    /// Folder name, or whatever the user renamed it to.
    pub name: String,
    /// FrcCatalyst version found in its vendordeps, when there is one.
    #[serde(default)]
    pub catalyst_version: Option<String>,
    /// WPILib season the project targets, when detectable.
    #[serde(default)]
    pub year: Option<String>,
    /// Whether an AI agent may write files inside this project. Defaults to false.
    #[serde(default)]
    pub agent_write: bool,
    /// Unix seconds when it was first registered.
    #[serde(default)]
    pub added: u64,
    /// Unix seconds when it was last opened in the app.
    #[serde(default)]
    pub last_opened: u64,
    /// Free-text note the user can leave for themselves and for the agent.
    #[serde(default)]
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Registry {
    #[serde(default)]
    pub projects: Vec<Project>,
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// The app's data directory, resolved the same way the MCP server resolves it.
///
/// Deliberately not Tauri's `app_data_dir`: the server has no Tauri, so if this used one rule and
/// the server another, the two would drift apart on exactly the machines where it matters. Both
/// sides compute `<config home>/com.frccatalyst.app`.
pub fn data_dir() -> Option<PathBuf> {
    let base = if cfg!(windows) {
        std::env::var_os("APPDATA").map(PathBuf::from)
    } else if cfg!(target_os = "macos") {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library").join("Application Support"))
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local").join("share")))
    }?;
    Some(base.join("com.frccatalyst.app"))
}

pub fn registry_path() -> Option<PathBuf> {
    data_dir().map(|d| d.join("projects.json"))
}

pub fn load() -> Registry {
    registry_path()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save(reg: &Registry) -> Result<(), String> {
    let path = registry_path().ok_or("could not resolve the app data directory")?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_string_pretty(reg).map_err(|e| e.to_string())?;
    // Through a temporary file: a half-written registry would lock an agent out of every project,
    // and this file is small enough that the rename costs nothing.
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, body).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

/// Canonical form, so the same folder reached two ways is one entry.
fn canonical(dir: &str) -> String {
    let p = Path::new(dir);
    fs::canonicalize(p)
        .map(|c| {
            // Windows canonicalize prefixes \\?\, which is correct and unreadable. The registry is
            // shown to people and read by another process; keep it plain.
            let s = c.to_string_lossy().to_string();
            s.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(s)
        })
        .unwrap_or_else(|_| p.to_string_lossy().to_string())
}

// ------------------------------------------------------------------ commands

#[tauri::command]
pub fn list_projects() -> Vec<Project> {
    let mut reg = load();
    // Most recently opened first: that is the one you came back for.
    reg.projects.sort_by(|a, b| b.last_opened.cmp(&a.last_opened));
    reg.projects
}

/// Where the registry lives, so the UI can tell the user what the agent is reading.
#[tauri::command]
pub fn projects_registry_path() -> String {
    registry_path().map(|p| p.to_string_lossy().to_string()).unwrap_or_else(|| "unavailable".into())
}

/// Add a project, or refresh what is known about one already registered.
///
/// Detection runs through the same code the Doctor uses, so the version and season shown here cannot
/// disagree with the version and season shown there.
#[tauri::command]
pub fn register_project(dir: String, name: Option<String>) -> Result<Project, String> {
    let path = canonical(&dir);
    if !Path::new(&path).is_dir() {
        return Err(format!("not a directory: {path}"));
    }
    let info = crate::detect_project_info(path.clone());
    let mut reg = load();

    let existing = reg.projects.iter().position(|p| p.path == path);
    let project = match existing {
        Some(i) => {
            let p = &mut reg.projects[i];
            p.name = name.unwrap_or_else(|| p.name.clone());
            p.catalyst_version = info.catalyst_version.clone();
            p.year = info.project_year.clone();
            p.last_opened = now();
            p.clone()
        }
        None => {
            let p = Project {
                path: path.clone(),
                name: name.unwrap_or(info.project_name.clone()),
                catalyst_version: info.catalyst_version.clone(),
                year: info.project_year.clone(),
                agent_write: false, // never granted implicitly
                added: now(),
                last_opened: now(),
                note: String::new(),
            };
            reg.projects.push(p.clone());
            p
        }
    };
    save(&reg)?;
    Ok(project)
}

#[tauri::command]
pub fn forget_project(dir: String) -> Result<(), String> {
    let path = canonical(&dir);
    let mut reg = load();
    let before = reg.projects.len();
    reg.projects.retain(|p| p.path != path);
    if reg.projects.len() == before {
        return Err(format!("not registered: {path}"));
    }
    save(&reg)
}

/// Grant or revoke an agent's permission to write inside one project.
///
/// The only way this flag becomes true is a person calling this from the app. Nothing infers it and
/// nothing else sets it.
#[tauri::command]
pub fn set_agent_write(dir: String, allowed: bool) -> Result<(), String> {
    let path = canonical(&dir);
    let mut reg = load();
    match reg.projects.iter_mut().find(|p| p.path == path) {
        Some(p) => {
            p.agent_write = allowed;
            save(&reg)
        }
        None => Err(format!("not registered: {path}")),
    }
}

#[tauri::command]
pub fn set_project_note(dir: String, note: String) -> Result<(), String> {
    let path = canonical(&dir);
    let mut reg = load();
    match reg.projects.iter_mut().find(|p| p.path == path) {
        Some(p) => {
            p.note = note;
            save(&reg)
        }
        None => Err(format!("not registered: {path}")),
    }
}
