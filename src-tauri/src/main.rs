// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

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
            launch_console
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Catalyst app");
}
