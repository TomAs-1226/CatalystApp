use super::*;
use std::fs;

/// A scratch install folder holding one binary, removed when the test ends.
struct Folder(PathBuf);

impl Folder {
    fn with(name: &str, exe: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("catalyst-suite-test-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(exe), b"").unwrap();
        Folder(dir)
    }

    fn path(&self) -> String {
        self.0.to_string_lossy().to_string()
    }
}

impl Drop for Folder {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn entry(id: &str) -> &'static Entry {
    SUITE.iter().find(|e| e.id == id).unwrap()
}

#[test]
fn a_quoted_install_location_is_read_like_a_bare_one() {
    // Tauri's NSIS installer quotes it, the simulator's does not. Joining onto the quoted form gives
    // a path that exists nowhere, and every Tauri app would look uninstalled.
    let f = Folder::with("quoted", "catalyst-console.exe");
    let bare = installed_exe(Some(&f.path()), "catalyst-console.exe");
    let quoted = installed_exe(Some(&format!("\"{}\"", f.path())), "catalyst-console.exe");

    assert!(bare.is_some());
    assert_eq!(bare, quoted);
}

#[test]
fn a_key_left_behind_by_a_deleted_app_is_not_an_install() {
    let f = Folder::with("deleted", "something-else.exe");
    assert!(installed_exe(Some(&f.path()), "catalyst-pit.exe").is_none());
    assert!(installed_exe(Some(""), "catalyst-pit.exe").is_none());
    assert!(installed_exe(Some("\"\""), "catalyst-pit.exe").is_none());
    assert!(installed_exe(None, "catalyst-pit.exe").is_none());
}

#[test]
fn an_installed_console_wins_over_the_bundled_one() {
    let installed = Folder::with("console-installed", "catalyst-console.exe");
    let bundled = Folder::with("console-bundled", "catalyst-console.exe");
    let found = locate(
        entry("console"),
        &Installed { location: Some(installed.path()), version: Some("2.0.0".into()) },
        Some(bundled.0.join("catalyst-console.exe")),
    );

    let (path, version) = found.unwrap();
    assert!(path.starts_with(&installed.0));
    assert_eq!(version.as_deref(), Some("2.0.0"));
}

#[test]
fn the_bundled_console_is_used_when_none_is_installed() {
    let bundled = Folder::with("console-only-bundled", "catalyst-console.exe");
    let exe = bundled.0.join("catalyst-console.exe");

    let (path, version) = locate(entry("console"), &Installed::default(), Some(exe.clone())).unwrap();
    assert_eq!(path, exe);
    assert!(version.is_none(), "the bundled copy records no version of its own");
}

#[test]
fn only_the_console_falls_back_to_the_bundled_binary() {
    // The bundled file is the console. Offering it under another app's name would start the wrong
    // program.
    let bundled = Folder::with("not-for-pit", "catalyst-console.exe");
    let exe = bundled.0.join("catalyst-console.exe");

    for id in ["pit", "sim", "link"] {
        assert!(locate(entry(id), &Installed::default(), Some(exe.clone())).is_none(), "{id}");
    }
}

#[test]
fn ids_are_unique_and_this_app_is_not_in_its_own_launcher() {
    let mut ids: Vec<_> = SUITE.iter().map(|e| e.id).collect();
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), SUITE.len());
    assert!(SUITE.iter().all(|e| e.exe != "catalyst-app.exe"));
}

#[cfg(windows)]
#[test]
fn a_missing_uninstall_key_reads_as_not_installed() {
    let got = read_installed("Catalyst app that was never written 7f3a");
    assert!(got.location.is_none() && got.version.is_none());
}
