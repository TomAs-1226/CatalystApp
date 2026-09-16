//! The project's files: the tree, the text, the search, and the one place a write is allowed.
//!
//! # Why there is an ignore list and not an option for it
//!
//! A Gradle project is mostly not source. `build/` alone holds tens of thousands of class files,
//! generated sources and unpacked jars, and `.git` holds every version of everything. A file tree
//! that walks either is not slow, it is a hang — the window stops painting and the only way out is
//! the task manager. So the list below is skipped at every level, always, and nothing can turn it
//! off. Nothing in it is a file anyone opens by hand.
//!
//! # Why writing has a boundary
//!
//! The registry in `projects.rs` is already the MCP server's write-permission boundary, decided once
//! and for the same reason: the app is where consent is given and the registry is where it is
//! recorded. An editor that could write anywhere would be a second, quieter answer to the same
//! question. So [`ws_write`] writes only inside a directory the registry lists, a refusal is an
//! error rather than a silent no-op, and the containment check is [`allowed_write`] — pure, and
//! tested against the tricks that make a naive one wrong.

use serde::Serialize;
use std::fs;
use std::path::{Component, Path, PathBuf};

/// Folders that are never worth walking into, at any depth.
pub const IGNORED: [&str; 9] = [
    ".git",
    "build",
    "bin",
    "node_modules",
    ".gradle",
    "target",
    "logs",
    ".idea",
    ".vscode",
];

/// Files bigger than this are not opened. Monaco slows to a crawl well before this, and a 2 MiB
/// source file is a generated one.
pub const MAX_READ: u64 = 2 * 1024 * 1024;

/// Files bigger than this are not searched. Search is for source, and a jar that happens to be
/// valid UTF-8 for its first megabyte is not source.
const MAX_SEARCH: u64 = 1024 * 1024;

/// The longest line fragment a hit carries back, so one minified file cannot fill the pane.
const HIT_WIDTH: usize = 200;

#[derive(Serialize, Debug)]
pub struct Node {
    pub name: String,
    pub path: String,
    pub dir: bool,
    /// `None` means "not read yet", which is what the tree shows as a closed folder. `Some(vec![])`
    /// means the folder really is empty. The frontend needs to tell those apart.
    pub children: Option<Vec<Node>>,
}

#[derive(Serialize, Debug)]
pub struct FileText {
    pub path: String,
    pub text: String,
    /// A Monaco language id, so the editor does not have to repeat this mapping in JS.
    pub language: String,
}

#[derive(Serialize, Debug)]
pub struct Hit {
    pub path: String,
    /// 1-based, because that is what an editor shows and what a person counts.
    pub line: u32,
    pub text: String,
}

// ------------------------------------------------------------------ the pure decisions

/// Whether a directory entry is one of the folders that are never walked.
///
/// Compared without case: on Windows `Build` and `build` are the same folder, and a Gradle project
/// created by a template that capitalised it would otherwise be walked in full.
pub fn ignored(name: &str) -> bool {
    IGNORED.iter().any(|skip| name.eq_ignore_ascii_case(skip))
}

/// The Monaco language id for a file, by extension.
///
/// Kept in Rust rather than in the editor module because `ws_read` already has the path in its hand,
/// and two copies of a mapping like this drift the first time someone adds a file type to one.
pub fn language_for(path: &str) -> &'static str {
    let ext = Path::new(path)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    match ext.as_str() {
        "java" => "java",
        "kt" | "kts" => "kotlin",
        "json" => "json",
        // Gradle build scripts are Groovy, and Monaco has no `gradle`. The Kotlin DSL is caught
        // above by its own extension.
        "gradle" | "groovy" => "groovy",
        "md" | "markdown" => "markdown",
        "xml" => "xml",
        "py" => "python",
        "js" | "mjs" | "cjs" => "javascript",
        "ts" | "mts" | "cts" => "typescript",
        "toml" => "toml",
        "properties" | "ini" | "cfg" => "ini",
        _ => "plaintext",
    }
}

/// Whether `path` may be written: its folder has to be at or below a registered project.
///
/// The check is on components, not on the text of the path, and every trick this has to survive is
/// a reason why. `C:\dev\Robot2` shares a string prefix with `C:\dev\Robot` and is a different
/// project. `C:\dev\Robot\..\..\Windows\System32\x` starts inside one and is not. And on Windows
/// `c:\dev\robot` and `C:\Dev\Robot` are the same folder, so a comparison that says otherwise
/// refuses writes to the project the user actually imported.
///
/// The folder is checked rather than the file so that the project directory itself cannot be the
/// target: a path equal to a registered root is a folder, and writing over it is not a thing to try.
pub fn allowed_write(path: &Path, roots: &[String]) -> bool {
    let Some(parent) = path.parent() else {
        return false;
    };
    // `.`, `..` and bare roots normalise to no more components than their own parent, which means
    // there is no file name here to write.
    if normalised(path).len() <= normalised(parent).len() {
        return false;
    }
    is_registered(parent, roots)
}

/// Whether a folder is a registered project, or sits inside one.
///
/// The same component comparison [`allowed_write`] rests on, shared so there is one answer to
/// "is this ours" rather than two that can disagree.
pub fn is_registered(dir: &Path, roots: &[String]) -> bool {
    let dir = normalised(dir);
    roots.iter().any(|root| {
        let root = normalised(Path::new(root));
        !root.is_empty() && dir.len() >= root.len() && dir[..root.len()] == root[..]
    })
}

/// A path as comparable components: `.` dropped, `..` resolved, case folded where case does not
/// distinguish two files.
fn normalised(p: &Path) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    // Where `..` stops climbing. Without it, `C:\..\Windows` would pop the drive letter and compare
    // equal to a relative path.
    let mut floor = 0usize;

    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                if out.len() > floor {
                    out.pop();
                }
            }
            Component::Prefix(prefix) => {
                out.push(fold(&prefix.as_os_str().to_string_lossy()));
                floor = out.len();
            }
            Component::RootDir => {
                out.push("/".into());
                floor = out.len();
            }
            Component::Normal(part) => out.push(fold(&part.to_string_lossy())),
        }
    }
    out
}

fn fold(s: &str) -> String {
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s.to_string()
    }
}

/// Every line of `text` containing `query`, ignoring case, up to `max` of them.
///
/// Literal, not a pattern: people searching a robot project type `setDefaultCommand`, and a query
/// with a `(` in it should find the call rather than fail to compile as a regex.
pub fn hits_in_text(text: &str, query: &str, max: usize) -> Vec<(u32, String)> {
    let needle = query.to_lowercase();
    if needle.is_empty() || max == 0 {
        return Vec::new();
    }
    let mut out = Vec::new();
    for (i, line) in text.lines().enumerate() {
        if line.to_lowercase().contains(&needle) {
            out.push((i as u32 + 1, clip(line)));
            if out.len() >= max {
                break;
            }
        }
    }
    out
}

/// One line, trimmed and cut to something a list can show.
fn clip(line: &str) -> String {
    let trimmed = line.trim();
    if trimmed.chars().count() <= HIT_WIDTH {
        return trimmed.to_string();
    }
    // By characters, not bytes: cutting a Java file with a `°` in a comment at a byte offset panics.
    trimmed.chars().take(HIT_WIDTH).collect::<String>() + "…"
}

/// A file size as a person would say it, for the message that refuses to open it.
pub fn size_words(bytes: u64) -> String {
    const MIB: f64 = 1024.0 * 1024.0;
    if bytes >= 1024 * 1024 {
        format!("{:.1} MiB", bytes as f64 / MIB)
    } else {
        format!("{} KiB", bytes / 1024)
    }
}

// ------------------------------------------------------------------ commands

/// The file tree under `dir`, `depth` levels deep.
///
/// `depth == 1` is one level with folders left unread, which is what the tree asks for as you open
/// them. Anything deeper is the same walk repeated, still skipping [`IGNORED`].
#[tauri::command]
pub fn ws_tree(dir: String, depth: u32) -> Result<Vec<Node>, String> {
    let root = Path::new(&dir);
    if !root.is_dir() {
        return Err(format!("not a folder: {dir}"));
    }
    read_level(root, depth.max(1))
}

fn read_level(dir: &Path, depth: u32) -> Result<Vec<Node>, String> {
    let entries = fs::read_dir(dir).map_err(|e| format!("cannot read {}: {e}", dir.display()))?;
    let mut nodes: Vec<Node> = Vec::new();

    for entry in entries.filter_map(|e| e.ok()) {
        let name = entry.file_name().to_string_lossy().to_string();
        if ignored(&name) {
            continue;
        }
        // `file_type` does not follow links, so a junction pointing at an ancestor arrives here as a
        // symlink rather than as a directory, and the walk cannot loop through it.
        let Ok(kind) = entry.file_type() else { continue };
        let is_dir = kind.is_dir();
        let path = entry.path();

        let children = if is_dir && depth > 1 {
            // A folder that cannot be read is shown closed rather than failing the whole tree: one
            // locked directory should not take the project's files away.
            Some(read_level(&path, depth - 1).unwrap_or_default())
        } else {
            None
        };

        nodes.push(Node {
            name,
            path: path.to_string_lossy().to_string(),
            dir: is_dir,
            children,
        });
    }

    // Folders first, then by name without case — the order a file tree is read in.
    nodes.sort_by(|a, b| {
        b.dir
            .cmp(&a.dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(nodes)
}

/// A file as text, with the language the editor should colour it as.
#[tauri::command]
pub fn ws_read(path: String) -> Result<FileText, String> {
    let p = Path::new(&path);
    let meta = fs::metadata(p).map_err(|e| format!("cannot open {path}: {e}"))?;
    if meta.is_dir() {
        return Err(format!("{path} is a folder, not a file"));
    }
    if meta.len() > MAX_READ {
        return Err(format!(
            "{path} is {}, and the editor opens files up to 2 MiB",
            size_words(meta.len())
        ));
    }

    let bytes = fs::read(p).map_err(|e| format!("cannot read {path}: {e}"))?;
    // Lossy conversion is the wrong kindness here: it would open a class file as mojibake, and
    // saving it back would write that mojibake to disk.
    let text = String::from_utf8(bytes)
        .map_err(|_| format!("{path} is not UTF-8 text, so the editor cannot open it safely"))?;

    let language = language_for(&path).to_string();
    Ok(FileText { path, text, language })
}

/// Write a file, but only inside a project the registry lists.
#[tauri::command]
pub fn ws_write(app: tauri::AppHandle, path: String, content: String) -> Result<(), String> {
    let roots: Vec<String> = crate::projects::list_projects(app)
        .into_iter()
        .map(|p| p.path)
        .collect();

    if !allowed_write(Path::new(&path), &roots) {
        return Err(format!(
            "refused to write {path}: it is not inside a project Catalyst knows about. \
             Import the project first."
        ));
    }

    let p = Path::new(&path);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
    fs::write(p, content).map_err(|e| format!("cannot write {path}: {e}"))
}

/// Literal, case-insensitive search through a project's source.
/// Every file in a project, for a quick-open list.
///
/// The tree reads one level at a time, which is right for a tree and useless for "open the file
/// called Robot.java" — so this walks the whole project once, skipping the same folders the tree
/// skips, and stops at `max`. Paths only: a name list is small enough to hold in the window and to
/// filter on every keystroke, and anything more is a file read the person has not asked for yet.
#[tauri::command]
pub fn ws_files(dir: String, max: u32) -> Result<Vec<String>, String> {
    let root = Path::new(&dir);
    if !root.is_dir() {
        return Err(format!("not a folder: {dir}"));
    }
    let max = max.max(1) as usize;

    let mut found: Vec<String> = Vec::new();
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];

    while let Some(current) = stack.pop() {
        let Ok(entries) = fs::read_dir(&current) else { continue };
        for entry in entries.filter_map(|e| e.ok()) {
            if found.len() >= max {
                return Ok(found);
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if ignored(&name) {
                continue;
            }
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() {
                stack.push(entry.path());
            } else if kind.is_file() {
                found.push(entry.path().to_string_lossy().to_string());
            }
        }
    }
    Ok(found)
}

#[tauri::command]
pub fn ws_search(dir: String, query: String, max: u32) -> Result<Vec<Hit>, String> {
    let root = Path::new(&dir);
    if !root.is_dir() {
        return Err(format!("not a folder: {dir}"));
    }
    if query.trim().is_empty() {
        return Err("nothing to search for".into());
    }
    let max = max.max(1) as usize;

    let mut hits: Vec<Hit> = Vec::new();
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];

    while let Some(current) = stack.pop() {
        let Ok(entries) = fs::read_dir(&current) else { continue };
        for entry in entries.filter_map(|e| e.ok()) {
            if hits.len() >= max {
                return Ok(hits);
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if ignored(&name) {
                continue;
            }
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() {
                stack.push(entry.path());
                continue;
            }
            if !kind.is_file() {
                continue;
            }
            if entry.metadata().map(|m| m.len() > MAX_SEARCH).unwrap_or(true) {
                continue;
            }
            let path = entry.path();
            // Anything that is not text is not a search result. Reading it as lossy UTF-8 would
            // match a query inside a jar and show a line of binary.
            let Ok(text) = fs::read_to_string(&path) else { continue };

            for (line, snippet) in hits_in_text(&text, &query, max - hits.len()) {
                hits.push(Hit {
                    path: path.to_string_lossy().to_string(),
                    line,
                    text: snippet,
                });
            }
        }
    }
    Ok(hits)
}

#[cfg(test)]
#[path = "workspace_tests.rs"]
mod tests;
