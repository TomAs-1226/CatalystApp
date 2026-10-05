//! The other Catalyst apps on this machine, and starting them.
//!
//! Catalyst is the one a team opens first, so it is the natural place to reach the rest from: the
//! driver dashboard, the pit companion, the practice simulator, the Tab5 link. Each is its own
//! program with its own installer and release cadence. Nothing here installs or updates them - that
//! is Catalyst Setup's job - it only finds what is already installed and starts it.
//!
//! An app is found through the per-user uninstall key its installer writes, which is where Windows
//! itself looks. The frontend names an app by id and never passes a path: what can be started from
//! here is this table and nothing else.

use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::Manager;

pub(crate) struct Entry {
    pub id: &'static str,
    pub name: &'static str,
    /// Subkey of `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall`.
    pub key: &'static str,
    pub exe: &'static str,
}

/// The same ids, keys and binaries as Catalyst Setup's `suite.json`.
pub(crate) const SUITE: &[Entry] = &[
    Entry { id: "console", name: "Catalyst Console", key: "Catalyst Console", exe: "catalyst-console.exe" },
    Entry { id: "pit", name: "Catalyst Pit", key: "Catalyst Pit", exe: "catalyst-pit.exe" },
    Entry { id: "sim", name: "Catalyst Sim (MO)", key: "CatalystSimMO", exe: "CatalystSim.exe" },
    Entry { id: "link", name: "Catalyst Link", key: "Catalyst Link", exe: "catalyst-link-desktop.exe" },
];

#[derive(Serialize, Debug, PartialEq)]
pub struct SuiteApp {
    id: String,
    name: String,
    /// Installed version, when the installer recorded one. The bundled console has none to report.
    version: Option<String>,
}

/// What an installer left in its uninstall key.
#[derive(Default, Debug, Clone)]
pub(crate) struct Installed {
    pub location: Option<String>,
    pub version: Option<String>,
}

/// The app's binary, if the recorded install folder still holds it.
///
/// Tauri's NSIS installer writes `InstallLocation` wrapped in double quotes and the simulator's
/// writes it bare, so the quotes come off first. The file is checked rather than trusted: an app
/// deleted by hand leaves its key behind, and a card that fails when pressed is worse than no card.
pub(crate) fn installed_exe(location: Option<&str>, exe: &str) -> Option<PathBuf> {
    let folder = location?.trim().trim_matches('"').trim();
    if folder.is_empty() {
        return None;
    }
    let path = Path::new(folder).join(exe);
    path.is_file().then_some(path)
}

#[cfg(windows)]
fn read_installed(key: &str) -> Installed {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let path = format!(r"Software\Microsoft\Windows\CurrentVersion\Uninstall\{key}");
    match RegKey::predef(HKEY_CURRENT_USER).open_subkey(path) {
        Ok(k) => Installed {
            location: k.get_value::<String, _>("InstallLocation").ok(),
            version: k.get_value::<String, _>("DisplayVersion").ok(),
        },
        Err(_) => Installed::default(),
    }
}

#[cfg(not(windows))]
fn read_installed(_key: &str) -> Installed {
    Installed::default()
}

/// The console copy bundled into this build, for a machine that has Catalyst and nothing else.
fn bundled_console(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .resolve("resources/console/catalyst-console.exe", tauri::path::BaseDirectory::Resource)
        .ok()
        .filter(|p| p.is_file())
}

/// Where an app would be started from, and the version to show for it.
///
/// An installed app wins over the bundled console: it is the one its own updater keeps current,
/// while the bundled copy is as old as this build of Catalyst.
pub(crate) fn locate(
    entry: &Entry,
    installed: &Installed,
    bundled: Option<PathBuf>,
) -> Option<(PathBuf, Option<String>)> {
    if let Some(path) = installed_exe(installed.location.as_deref(), entry.exe) {
        return Some((path, installed.version.clone()));
    }
    if entry.id == "console" {
        return bundled.map(|p| (p, None));
    }
    None
}

fn find(app: &tauri::AppHandle, entry: &Entry) -> Option<(PathBuf, Option<String>)> {
    locate(entry, &read_installed(entry.key), bundled_console(app))
}

/// The Catalyst apps that can be started on this machine right now.
///
/// Apps that are not installed are left out rather than listed as missing: this is a launcher, and
/// Catalyst Setup is where a team sees what it does not have yet.
#[tauri::command]
pub fn suite_apps(app: tauri::AppHandle) -> Vec<SuiteApp> {
    SUITE
        .iter()
        .filter_map(|entry| {
            find(&app, entry).map(|(_, version)| SuiteApp {
                id: entry.id.into(),
                name: entry.name.into(),
                version,
            })
        })
        .collect()
}

/// Start one of the suite's apps.
///
/// Spawned detached rather than run and awaited: these are long-lived programs that outlive
/// whatever the user is doing in here. The Tauri apps enforce their own single instance, so asking
/// twice raises the window already open instead of starting a second.
#[tauri::command]
pub fn launch_suite_app(app: tauri::AppHandle, id: String) -> Result<String, String> {
    let entry = SUITE
        .iter()
        .find(|e| e.id == id)
        .ok_or_else(|| format!("{id} is not a Catalyst app"))?;
    let (path, _) = find(&app, entry).ok_or_else(|| format!("{} is not installed", entry.name))?;

    let mut command = std::process::Command::new(&path);
    // The simulator reads its data folder relative to where it was started.
    if let Some(folder) = path.parent() {
        command.current_dir(folder);
    }
    command
        .spawn()
        .map_err(|e| format!("could not start {}: {e}", entry.name))?;
    Ok(path.to_string_lossy().to_string())
}

#[cfg(test)]
#[path = "suite_tests.rs"]
mod tests;
