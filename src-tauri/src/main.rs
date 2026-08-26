// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod doctor;
mod vendordeps;

use serde::Serialize;
use std::fs;
use std::path::Path;
use tauri::Manager;

#[derive(Serialize)]
struct ProjectInfo {
    is_wpilib: bool,
    has_catalyst: bool,
    catalyst_version: Option<String>,
    project_name: String,
    reasons: Vec<String>,
    /// Season the project was created for, from `.wpilib/wpilib_preferences.json`.
    ///
    /// Catalyst 2.x targets 2027. Installing it into a 2026 project produces something that looks
    /// correctly configured and fails at build with an error naming none of this, so the year is
    /// surfaced rather than assumed.
    project_year: Option<String>,
}

/// Inspect a folder and report whether it looks like a WPILib / GradleRIO robot project,
/// and whether FrcCatalyst is already installed (and at what version).
#[tauri::command]
fn detect_project(dir: String) -> ProjectInfo {
    let p = Path::new(&dir);
    let build_gradle = p.join("build.gradle").exists();
    let wpilib_marker = p.join(".wpilib").join("wpilib_preferences.json").exists();
    let vendordeps = p.join("vendordeps").exists();
    let is_wpilib = build_gradle && (wpilib_marker || vendordeps);

    let catalyst_path = p.join("vendordeps").join("FrcCatalyst.json");
    let (has_catalyst, catalyst_version) = if catalyst_path.exists() {
        let v = fs::read_to_string(&catalyst_path)
            .ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
            .and_then(|j| j.get("version").and_then(|x| x.as_str().map(str::to_string)));
        (true, v)
    } else {
        (false, None)
    };

    // Read through the vendordeps module, which is where the season is compared to something. The
    // installer and that list disagreeing about which year a project is would be its own bug.
    let project_year = vendordeps::project_year(p);

    let project_name = p
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    let mut reasons = Vec::new();
    if !build_gradle {
        reasons.push("no build.gradle in this folder".into());
    }
    if !wpilib_marker && !vendordeps {
        reasons.push("no .wpilib or vendordeps folder".into());
    }

    ProjectInfo {
        is_wpilib,
        has_catalyst,
        catalyst_version,
        project_name,
        reasons,
        project_year,
    }
}

/// Return the FrcCatalyst vendordep JSON that ships inside the app (offline, version-locked).
#[tauri::command]
fn read_bundled_vendordep(app: tauri::AppHandle) -> Result<String, String> {
    let path = app
        .path()
        .resolve(
            "resources/FrcCatalyst.json",
            tauri::path::BaseDirectory::Resource,
        )
        .map_err(|e| e.to_string())?;
    fs::read_to_string(&path).map_err(|e| format!("bundled vendordep not found: {e}"))
}

/// Absolute path to the bundled MCP server (`resources/mcp/server.js`), for the agent config snippet.
#[tauri::command]
fn mcp_server_path(app: tauri::AppHandle) -> Result<String, String> {
    let path = app
        .path()
        .resolve(
            "resources/mcp/server.js",
            tauri::path::BaseDirectory::Resource,
        )
        .map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

/// Whether Catalyst Console was bundled into this build.
///
/// It is a separate binary with its own release cadence, so a Catalyst build made before a console
/// release will not have one. The UI asks rather than assuming, and hides the button if the answer is
/// no — an button that reports "not found" when pressed is worse than no button.
#[tauri::command]
fn console_available(app: tauri::AppHandle) -> bool {
    console_path(&app).map(|p| p.exists()).unwrap_or(false)
}

fn console_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .resolve(
            "resources/console/catalyst-console.exe",
            tauri::path::BaseDirectory::Resource,
        )
        .map_err(|e| e.to_string())
}

/// Launch the bundled Catalyst Console.
///
/// Spawned detached rather than run and awaited: the console is a long-lived dashboard that outlives
/// whatever the user is doing in here, and holding it as a child would tie its lifetime to this
/// window. The console enforces its own single instance, so pressing the button twice raises the one
/// already running instead of starting a second.
#[tauri::command]
fn launch_console(app: tauri::AppHandle) -> Result<String, String> {
    let path = console_path(&app)?;
    if !path.exists() {
        return Err("Catalyst Console is not bundled in this build".into());
    }
    std::process::Command::new(&path)
        .spawn()
        .map_err(|e| format!("could not start Catalyst Console: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

/// Write a vendordep JSON into `<dir>/vendordeps/<filename>`, creating the folder if needed.
/// The filename is validated to prevent writing outside the vendordeps folder.
#[tauri::command]
fn write_vendordep(dir: String, filename: String, content: String) -> Result<String, String> {
    if filename.is_empty()
        || filename.contains('/')
        || filename.contains('\\')
        || filename.contains("..")
        || !filename.ends_with(".json")
    {
        return Err(format!("refused unsafe filename: {filename}"));
    }
    let vendordeps = Path::new(&dir).join("vendordeps");
    fs::create_dir_all(&vendordeps).map_err(|e| e.to_string())?;
    fs::write(vendordeps.join(&filename), content).map_err(|e| e.to_string())?;
    Ok(format!("Wrote vendordeps/{filename}"))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            detect_project,
            read_bundled_vendordep,
            write_vendordep,
            mcp_server_path,
            console_available,
            launch_console,
            doctor::diagnose_project,
            doctor::scan_migration,
            vendordeps::inspect_vendordeps
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Catalyst app");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    /// A scratch project directory, removed when the test ends.
    struct Project(PathBuf);

    impl Project {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("catalyst-app-test-{name}"));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Project(dir)
        }

        fn file(self, rel: &str, contents: &str) -> Self {
            let path = self.0.join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, contents).unwrap();
            self
        }

        fn dir(self, rel: &str) -> Self {
            fs::create_dir_all(self.0.join(rel)).unwrap();
            self
        }

        fn detect(&self) -> ProjectInfo {
            detect_project(self.0.to_string_lossy().to_string())
        }
    }

    impl Drop for Project {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn a_real_wpilib_project_is_recognised() {
        let p = Project::new("real")
            .file("build.gradle", "plugins { id 'java' }")
            .file(".wpilib/wpilib_preferences.json", r#"{"projectYear": "2027_alpha1"}"#);

        let info = p.detect();
        assert!(info.is_wpilib);
        assert!(info.reasons.is_empty(), "reasons: {:?}", info.reasons);
        assert_eq!(info.project_year.as_deref(), Some("2027_alpha1"));
    }

    #[test]
    fn project_year_reads_the_same_whether_written_as_text_or_a_number() {
        // WPILib has written it both ways across seasons. Returning `"2027"` for one and `2027` for
        // the other pushes the difference into the UI, which then compares strings and disagrees
        // with itself.
        let text = Project::new("year-text")
            .file("build.gradle", "")
            .file(".wpilib/wpilib_preferences.json", r#"{"projectYear": "2026"}"#);
        let number = Project::new("year-number")
            .file("build.gradle", "")
            .file(".wpilib/wpilib_preferences.json", r#"{"projectYear": 2026}"#);

        assert_eq!(text.detect().project_year.as_deref(), Some("2026"));
        assert_eq!(number.detect().project_year.as_deref(), Some("2026"));
    }

    #[test]
    fn vendordeps_alone_are_enough_to_call_it_a_wpilib_project() {
        // An imported project that has not been opened in VS Code yet has no .wpilib folder.
        let p = Project::new("vendordeps-only")
            .file("build.gradle", "")
            .dir("vendordeps");

        let info = p.detect();
        assert!(info.is_wpilib);
        assert!(info.project_year.is_none(), "no preferences file to read");
    }

    #[test]
    fn a_folder_that_is_not_a_project_says_why() {
        let p = Project::new("empty");
        let info = p.detect();

        assert!(!info.is_wpilib);
        assert_eq!(info.reasons.len(), 2, "both reasons should be given: {:?}", info.reasons);
        assert!(info.reasons.iter().any(|r| r.contains("build.gradle")));
        assert!(info.reasons.iter().any(|r| r.contains(".wpilib")));
    }

    #[test]
    fn build_gradle_alone_is_not_a_wpilib_project() {
        // Any Gradle project has one. Installing a vendordep into a plain Java project writes a file
        // nothing reads, and the team is left looking for a build error that never appears.
        let p = Project::new("plain-gradle").file("build.gradle", "");
        let info = p.detect();

        assert!(!info.is_wpilib);
        assert!(info.reasons.iter().any(|r| r.contains(".wpilib")));
    }

    #[test]
    fn an_installed_catalyst_is_reported_with_its_version() {
        let p = Project::new("installed")
            .file("build.gradle", "")
            .file("vendordeps/FrcCatalyst.json", r#"{"version": "1.12.0", "frcYear": "2026"}"#);

        let info = p.detect();
        assert!(info.has_catalyst);
        assert_eq!(info.catalyst_version.as_deref(), Some("1.12.0"));
    }

    #[test]
    fn a_corrupt_vendordep_is_seen_but_has_no_version() {
        // Half-written by an interrupted install. It must still register as present, or the app
        // offers a clean install and silently leaves the broken file in place.
        let p = Project::new("corrupt")
            .file("build.gradle", "")
            .file("vendordeps/FrcCatalyst.json", "{ this is not json");

        let info = p.detect();
        assert!(info.has_catalyst, "the file is there");
        assert!(info.catalyst_version.is_none(), "but nothing can be read from it");
    }

    #[test]
    fn unreadable_preferences_do_not_stop_detection() {
        let p = Project::new("bad-prefs")
            .file("build.gradle", "")
            .file(".wpilib/wpilib_preferences.json", "not json at all");

        let info = p.detect();
        assert!(info.is_wpilib, "the marker file exists, which is what that test is");
        assert!(info.project_year.is_none());
    }

    #[test]
    fn preferences_without_a_project_year_report_none() {
        let p = Project::new("no-year")
            .file("build.gradle", "")
            .file(".wpilib/wpilib_preferences.json", r#"{"teamNumber": 5805}"#);

        assert!(p.detect().project_year.is_none());
    }
}
