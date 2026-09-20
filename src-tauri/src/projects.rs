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
    /// What this project actually is, recomputed on every import and refresh.
    #[serde(default)]
    pub analysis: Analysis,
}

/// What a project turned out to be when Catalyst looked at it.
///
/// The point is the difference between "has Catalyst installed" and "is running a Catalyst you
/// would recognise". A team on a locally-built beta with a hand-edited vendordep is the normal case
/// during an offseason, and an agent that assumes the released API will write code that does not
/// compile. So this reports where the library resolves from and whether the vendordep still matches
/// the one the app ships, rather than only its version string.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Analysis {
    /// "robot project", "the FrcCatalyst library itself", or "unrecognised".
    pub kind: String,
    /// Where the Catalyst artifact comes from: JitPack, a local maven, or unknown.
    pub resolves_from: String,
    /// True when the project's FrcCatalyst.json is byte-identical to the one this app bundles.
    pub matches_bundled: bool,
    /// The version this app would install, for comparison with `catalyst_version`.
    pub bundled_version: Option<String>,
    /// Other vendordeps present, by filename.
    pub vendordeps: Vec<String>,
    /// Plain sentences an agent or a person can act on.
    pub notes: Vec<String>,
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

/// The last registry that parsed, kept beside the live one.
///
/// The live file went missing once during development - the directory was there and empty, with no
/// `.tmp` left behind, so it was not a failed write. Whatever the cause, losing it silently loses
/// every project the user imported and every write permission they granted, and the first they hear
/// of it is an agent saying it cannot find their code. A copy costs a few kilobytes.
fn backup_path() -> Option<PathBuf> {
    data_dir().map(|d| d.join("projects.backup.json"))
}

pub fn load() -> Registry {
    let live = registry_path()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<Registry>(&s).ok());
    if let Some(reg) = live {
        return reg;
    }
    // Missing or unparseable. Fall back to the last copy that parsed, and put it back in place so
    // the MCP server - which reads the live file directly and knows nothing about this - recovers
    // too. A registry restored from yesterday beats an empty one.
    let restored = backup_path()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<Registry>(&s).ok());
    match restored {
        Some(reg) => {
            let _ = write_atomically(&reg, registry_path());
            reg
        }
        None => Registry::default(),
    }
}

fn write_atomically(reg: &Registry, path: Option<PathBuf>) -> Result<(), String> {
    let path = path.ok_or("could not resolve the app data directory")?;
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

fn save(reg: &Registry) -> Result<(), String> {
    write_atomically(reg, registry_path())?;
    // Best effort, and deliberately after the live write: a backup that failed to update is a stale
    // backup, which is still worth having, whereas a failed save the user is not told about is not.
    let _ = write_atomically(reg, backup_path());
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

/// Look at a project and say what it is really running.
fn analyse(root: &Path, bundled: Option<&str>) -> Analysis {
    let mut a = Analysis::default();

    // Is this a robot project, or the library source itself? The distinction matters: an agent
    // asked to "add a mechanism" does something very different in each.
    let has_lib_src = root.join("src/main/java/frc/lib/catalyst").is_dir();
    let has_robot_src = root.join("src/main/java/frc/robot").is_dir();
    a.kind = if has_lib_src {
        "the FrcCatalyst library itself".into()
    } else if has_robot_src || root.join("build.gradle").exists() {
        "robot project".into()
    } else {
        "unrecognised".into()
    };

    let vd_dir = root.join("vendordeps");
    if let Ok(entries) = fs::read_dir(&vd_dir) {
        let mut names: Vec<String> = entries
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.ends_with(".json"))
            .collect();
        names.sort();
        a.vendordeps = names;
    }

    let cat = vd_dir.join("FrcCatalyst.json");
    let installed = fs::read_to_string(&cat).ok();

    a.bundled_version = bundled.and_then(|b| {
        serde_json::from_str::<serde_json::Value>(b)
            .ok()
            .and_then(|j| j.get("version").and_then(|v| v.as_str().map(str::to_string)))
    });

    match installed.as_deref() {
        None => {
            a.resolves_from = String::new();
            if a.kind == "robot project" {
                a.notes.push("No FrcCatalyst vendordep. Install it before writing Catalyst code here.".into());
            }
        }
        Some(body) => {
            // Byte-identical to what we ship, or changed? Whitespace is normalised so a reformat
            // does not read as a modification, but any real difference does.
            let squash = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
            a.matches_bundled = bundled.map(|b| squash(b) == squash(body)).unwrap_or(false);

            // Where the jar comes from is the honest answer to "which build is this", and the
            // coordinate plus the repository list says it more reliably than either alone. A JitPack
            // install carries groupId com.github.<user> and lists jitpack.io; `publishToMavenLocal`
            // carries com.frccatalyst and lists no repository that could serve it, because Gradle
            // finds it in ~/.m2.
            //
            // The URLs are matched on their own, not against the whole document. Searching the
            // document for the groupId always succeeds - the groupId is *in* the document - which
            // made a locally-built project report "the maven serving com.frccatalyst", a sentence
            // that sounds authoritative and names a repository that does not exist.
            let parsed = serde_json::from_str::<serde_json::Value>(body).ok();
            let group = parsed
                .as_ref()
                .and_then(|j| {
                    j.get("javaDependencies")?.as_array()?.iter().find_map(|d| {
                        let g = d.get("groupId")?.as_str()?;
                        g.contains("catalyst").then(|| g.to_string())
                    })
                })
                .unwrap_or_default();
            let urls = parsed
                .as_ref()
                .and_then(|j| j.get("mavenUrls")?.as_array().cloned())
                .unwrap_or_default()
                .iter()
                .filter_map(|u| u.as_str().map(str::to_lowercase))
                .collect::<Vec<_>>()
                .join(" ");

            let local = urls.contains("mavenlocal") || urls.contains("m2/repository");
            let jitpack = group.starts_with("com.github") || urls.contains("jitpack");
            a.resolves_from = if local {
                "mavenLocal - built from source on this machine".into()
            } else if jitpack {
                "JitPack".into()
            } else if group.is_empty() {
                "an unrecognised source".into()
            } else {
                format!("mavenLocal - no repository this vendordep lists publishes {group}")
            };

            // The version this project actually builds against, which is the one an agent must
            // write code for.
            let installed_version = parsed
                .as_ref()
                .and_then(|j| j.get("version").and_then(|v| v.as_str().map(str::to_string)))
                .unwrap_or_default();

            // A pre-release is the single most useful thing to say out loud. Catalyst 2.x is an
            // alpha line through the offseason: the API moves between tags, so an agent writing
            // against the last stable release produces code that does not compile. Saying "this is
            // a pre-release, go and check" is what prevents that.
            let pre = installed_version
                .split_once(['-', '+'])
                .map(|(_, tail)| tail.to_lowercase())
                .filter(|t| {
                    ["alpha", "beta", "rc", "snapshot", "dev", "pre"]
                        .iter()
                        .any(|k| t.contains(k))
                });
            if let Some(tail) = &pre {
                let kind = if tail.contains("alpha") {
                    "an alpha"
                } else if tail.contains("beta") {
                    "a beta"
                } else if tail.contains("rc") {
                    "a release candidate"
                } else {
                    "a pre-release"
                };
                a.notes.push(format!(
                    "This project runs {kind} build: Catalyst {installed_version}. Its API is not \
                     frozen, so verify a signature against this project's own sources or the \
                     bundled documentation before using it - do not assume the last stable release."
                ));
            }

            // Only claim a difference when there is something to have differed from. With no
            // bundled vendordep to read - which happens in a browser preview - matches_bundled is
            // false because nothing was compared, and reporting that as "hand-edited" would be an
            // accusation made from no evidence.
            match a.bundled_version.as_deref() {
                Some(b) if b != installed_version && !installed_version.is_empty() => {
                    a.notes.push(format!(
                        "Version drift: this project is on Catalyst {installed_version}, this app \
                         bundles {b}. The project's version is the one that governs here."
                    ));
                }
                Some(_) if !a.matches_bundled => {
                    a.notes.push(
                        "Same version, different file: this project's FrcCatalyst.json is not the \
                         one this app ships, so it has been hand-edited. Read it before assuming \
                         anything about where the library resolves from."
                            .into(),
                    );
                }
                _ => {}
            }
            if local || (!jitpack && !group.is_empty()) {
                a.notes.push(
                    "It comes from mavenLocal, so the library was built from source on this machine. \
                     Its API can be ahead of any published tag - read the source, not the release \
                     notes, and not this app's bundled version."
                        .into(),
                );
            }
        }
    }

    if a.kind == "the FrcCatalyst library itself" {
        a.notes.push(
            "This is the library source, not a robot project. Changes here affect every robot that \
             builds against it, and the library's own tests are the gate."
                .into(),
        );
    }
    a
}

// ------------------------------------------------------------------ commands

/// The bundled vendordep, read from this app's own resources.
///
/// `register_project` is handed it by the UI; `list_projects` has no such caller, and an analysis
/// that cannot compare against what we ship loses the "modified install" finding entirely. So it is
/// read here too, from the same resource path the command uses.
fn bundled_vendordep(app: &tauri::AppHandle) -> Option<String> {
    use tauri::Manager;
    app.path()
        .resolve("resources/FrcCatalyst.json", tauri::path::BaseDirectory::Resource)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
}

#[tauri::command]
pub fn list_projects(app: tauri::AppHandle) -> Vec<Project> {
    // Re-read every project on every listing rather than trusting what was stored at import. A
    // project moves on - its vendordep is upgraded, its library is rebuilt, this app is updated -
    // and an analysis that was true in August and quietly wrong in September is worse than none at
    // all. Each pass is a handful of small file reads against a list that is a few entries long.
    let bundled = bundled_vendordep(&app);
    let mut reg = load();
    let mut changed = false;
    for p in &mut reg.projects {
        let info = crate::detect_project_info(p.path.clone());
        let fresh = analyse(Path::new(&p.path), bundled.as_deref());
        // Compare before writing: the registry is also the MCP server's input, and rewriting it on
        // every page view would churn a file another process reads.
        let differs = p.catalyst_version != info.catalyst_version
            || p.year != info.project_year
            || serde_json::to_string(&p.analysis).ok() != serde_json::to_string(&fresh).ok();
        if differs {
            p.catalyst_version = info.catalyst_version;
            p.year = info.project_year;
            p.analysis = fresh;
            changed = true;
        }
    }
    if changed {
        let _ = save(&reg);
    }
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
pub fn register_project(
    dir: String,
    name: Option<String>,
    bundled_vendordep: Option<String>,
) -> Result<Project, String> {
    let path = canonical(&dir);
    if !Path::new(&path).is_dir() {
        return Err(format!("not a directory: {path}"));
    }
    let info = crate::detect_project_info(path.clone());
    let analysis = analyse(Path::new(&path), bundled_vendordep.as_deref());
    let mut reg = load();

    let existing = reg.projects.iter().position(|p| p.path == path);
    let project = match existing {
        Some(i) => {
            let p = &mut reg.projects[i];
            p.name = name.unwrap_or_else(|| p.name.clone());
            p.catalyst_version = info.catalyst_version.clone();
            p.year = info.project_year.clone();
            p.analysis = analysis;
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
                analysis,
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

// ------------------------------------------------------------------ files inside a project
//
// The app's own tools reach into a project through this door, and it is the same door the MCP
// server keeps for an agent, with the same rules: the folder must be registered; writing needs that
// project's `agent_write`, which only a person sets, on the Projects page; the path must stay inside
// the project once links are resolved; and version control and build output are refused even then.
// A tool that writes code into a robot project is exactly as capable of damage as an agent that
// does, so it gets no easier way in. Driver Config is the first tool to use it.

/// Paths refused even inside a project that allows writing. Must match `PROTECTED` in
/// `resources/mcp/server.js`: the two doors into a project refuse the same rooms.
pub const PROTECTED: [&str; 6] = [".git", "build", "target", "node_modules", ".gradle", "graphify-out"];

/// A Java source file, for a tool that reads the project (Driver Config's action scan).
#[derive(Debug, Clone, Serialize)]
pub struct SourceFile {
    /// Relative to the project root, with forward slashes.
    pub path: String,
    pub text: String,
}

/// What a write did, in the words the page shows the user.
#[derive(Debug, Clone, Serialize)]
pub struct WriteReport {
    pub project: String,
    /// Absolute path of the file written.
    pub path: String,
    /// The same file relative to the project root.
    pub rel: String,
    pub bytes: usize,
    /// True when the file did not exist before.
    pub created: bool,
}

const MAX_SOURCE_FILES: usize = 4000;
const MAX_SOURCE_BYTES: usize = 32 * 1024 * 1024;

fn plain(p: &Path) -> String {
    let s = p.to_string_lossy().to_string();
    s.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(s)
}

fn registered<'a>(reg: &'a Registry, dir: &str) -> Result<&'a Project, String> {
    let path = canonical(dir);
    reg.projects
        .iter()
        .find(|p| p.path == path || canonical(&p.path) == path)
        .ok_or_else(|| format!("{path} is not a registered project. Import it on the Projects page first."))
}

/// `rel` inside `root`, or the reason it is refused.
///
/// A path must be relative and plain - no `..`, no drive, no leading slash - and name no protected
/// folder. Then the deepest part of it that already exists must resolve inside the project, so a
/// symlink or a junction that points out of the folder is caught by the same test as `..` is.
fn resolve_inside(root: &Path, rel: &str) -> Result<PathBuf, String> {
    use std::path::Component;
    if rel.trim().is_empty() {
        return Err("No file was named.".into());
    }
    let mut clean = PathBuf::new();
    for comp in Path::new(rel).components() {
        match comp {
            Component::Normal(seg) => {
                let s = seg.to_string_lossy();
                if PROTECTED.iter().any(|p| p.eq_ignore_ascii_case(&s)) {
                    return Err(format!(
                        "Refusing \"{rel}\": \"{s}\" is build output or version control, not source."
                    ));
                }
                clean.push(seg);
            }
            Component::CurDir => {}
            _ => {
                return Err(format!(
                    "Refusing \"{rel}\": it must be a path inside the project - no \"..\", drive or leading slash."
                ))
            }
        }
    }
    let root_real = fs::canonicalize(root).map_err(|e| format!("Cannot open the project folder: {e}"))?;
    let target = root_real.join(&clean);
    let mut probe = target.clone();
    while !probe.exists() {
        if !probe.pop() {
            break;
        }
    }
    let probe_real = fs::canonicalize(&probe).map_err(|e| e.to_string())?;
    if !probe_real.starts_with(&root_real) {
        return Err(format!("Refusing \"{rel}\": it leads outside the project."));
    }
    Ok(target)
}

fn read_text(target: &Path, rel: &str) -> Result<Option<String>, String> {
    match fs::read(target) {
        Ok(bytes) => String::from_utf8(bytes)
            .map(Some)
            .map_err(|_| format!("{rel} is not a UTF-8 text file.")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Could not read {rel}: {e}")),
    }
}

/// Read one file of a registered project. `None` when it does not exist yet.
pub(crate) fn read_file_in(reg: &Registry, dir: &str, rel: &str) -> Result<Option<String>, String> {
    let p = registered(reg, dir)?;
    let target = resolve_inside(Path::new(&p.path), rel)?;
    read_text(&target, rel)
}

/// Write one file of a registered project, under every rule above.
///
/// `expected` is the file as the user last saw it in a preview, and `expect_absent` says the preview
/// showed no file at all. If the file has changed since - an editor saved it, a pull landed - the
/// write is refused rather than overwriting something nobody has looked at.
pub(crate) fn write_file_in(
    reg: &Registry,
    dir: &str,
    rel: &str,
    content: &str,
    expected: Option<&str>,
    expect_absent: bool,
) -> Result<WriteReport, String> {
    let p = registered(reg, dir)?;
    if !p.agent_write {
        return Err(format!(
            "Writing is off for \"{}\". Open Projects, find it, and switch on \"Let agents write\" - the same \
             switch an AI agent needs. Nothing was written.",
            p.name
        ));
    }
    let target = resolve_inside(Path::new(&p.path), rel)?;
    if target.is_dir() {
        return Err(format!("{rel} is a folder, not a file."));
    }
    let current = read_text(&target, rel)?;
    if expect_absent && current.is_some() {
        return Err(format!("{rel} appeared since you previewed the change. Nothing was written; review it again."));
    }
    if let Some(want) = expected {
        if current.as_deref() != Some(want) {
            return Err(format!("{rel} changed since you previewed it. Nothing was written; review the change again."));
        }
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Could not create the folder for {rel}: {e}"))?;
    }
    // Through a temporary file beside the target: a crash mid-write must never leave half a Java file
    // in a robot project, because the next build fails on it and nobody knows why.
    let name = target.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let tmp = target.with_file_name(format!(".{name}.catalyst-tmp"));
    fs::write(&tmp, content.as_bytes()).map_err(|e| format!("Could not write {rel}: {e}"))?;
    if let Err(e) = fs::rename(&tmp, &target) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("Could not write {rel}: {e}"));
    }
    Ok(WriteReport {
        project: p.name.clone(),
        path: plain(&target),
        rel: rel.replace('\\', "/"),
        bytes: content.len(),
        created: current.is_none(),
    })
}

/// Every `.java` file under `src/main/java`, skipping protected folders and never following a link.
pub(crate) fn java_sources_in(reg: &Registry, dir: &str) -> Result<Vec<SourceFile>, String> {
    let p = registered(reg, dir)?;
    let root = fs::canonicalize(&p.path).map_err(|e| format!("Cannot open the project folder: {e}"))?;
    let mut out = Vec::new();
    let mut total = 0usize;
    walk_java(&root.join("src").join("main").join("java"), &root, &mut out, &mut total)?;
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

fn walk_java(dir: &Path, root: &Path, out: &mut Vec<SourceFile>, total: &mut usize) -> Result<(), String> {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return Ok(()),
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else { continue };
        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path();
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            if !PROTECTED.iter().any(|p| p.eq_ignore_ascii_case(&name)) {
                walk_java(&path, root, out, total)?;
            }
        } else if name.ends_with(".java") {
            if out.len() >= MAX_SOURCE_FILES || *total >= MAX_SOURCE_BYTES {
                return Err("This project has more Java than a robot project should; stopped reading it.".into());
            }
            let Ok(text) = fs::read_to_string(&path) else { continue };
            *total += text.len();
            let rel = path.strip_prefix(root).map(|r| r.to_string_lossy().replace('\\', "/")).unwrap_or(name);
            out.push(SourceFile { path: rel, text });
        }
    }
    Ok(())
}

#[tauri::command]
pub fn read_project_file(dir: String, rel: String) -> Result<Option<String>, String> {
    read_file_in(&load(), &dir, &rel)
}

/// The registry is re-read on every call, so a switch flipped on the Projects page a second ago is
/// the one that counts.
#[tauri::command]
pub fn write_project_file(
    dir: String,
    rel: String,
    content: String,
    expected: Option<String>,
    expect_absent: bool,
) -> Result<WriteReport, String> {
    write_file_in(&load(), &dir, &rel, &content, expected.as_deref(), expect_absent)
}

#[tauri::command]
pub fn project_java_sources(dir: String) -> Result<Vec<SourceFile>, String> {
    java_sources_in(&load(), &dir)
}

#[cfg(test)]
#[path = "projects_tests.rs"]
mod tests;
