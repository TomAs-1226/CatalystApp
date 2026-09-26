//! Look at a team's robot project and say what will stop it working on 2027.
//!
//! Every check here is for something that does not fail at build time. The project compiles, the
//! deploy succeeds, and the problem surfaces on the field as something that does not resemble its
//! cause — which is exactly the class of thing worth looking for before anyone drives.
//!
//! The sharpest example is the pair of `--add-opens` flags. Without them a 2027 robot boots
//! normally, the dashboard connects, and the first command a driver schedules throws from inside
//! WPILib naming no class the team wrote. Nothing about that points at a missing JVM argument, and
//! it is one grep of `build.gradle` to find.
//!
//! Nothing here writes. It reads the project and reports.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

/// How much a finding matters.
///
/// `Blocker` means the robot will not work. `Warn` means it will, but something is not as intended.
/// The distinction is the whole value of the report — a list where everything is urgent is a list
/// nobody reads.
#[derive(Serialize, PartialEq, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Blocker,
    Warn,
    Ok,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub level: Level,
    /// What was checked, as a person would say it.
    pub what: String,
    /// What is wrong and why it matters. Empty when the level is Ok.
    pub detail: String,
    /// What to do about it, ready to paste where that makes sense.
    pub fix: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Diagnosis {
    pub findings: Vec<Finding>,
    pub ready: bool,
    /// One line for a header: "Ready", "Ready, 2 warnings", or the first blocker.
    pub summary: String,
}

// Shared with the vendordeps list, which grades the same project against the same vocabulary. Two
// views that call the same fact a blocker and a warning are worse than either of them being wrong.
pub(crate) fn ok(what: &str) -> Finding {
    Finding { level: Level::Ok, what: what.into(), detail: String::new(), fix: String::new() }
}

pub(crate) fn warn(what: &str, detail: &str, fix: &str) -> Finding {
    Finding { level: Level::Warn, what: what.into(), detail: detail.into(), fix: fix.into() }
}

pub(crate) fn blocker(what: &str, detail: &str, fix: &str) -> Finding {
    Finding { level: Level::Blocker, what: what.into(), detail: detail.into(), fix: fix.into() }
}

/// Read a file, or an empty string. A check on a file that is not there reports its own absence.
fn read(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_default()
}

/// Gradle source with its comments removed, because a commented-out setting is not a setting.
///
/// This is not fussiness. The flags in particular are usually met commented out - the example
/// project ships them that way with an explanation, and a team that copies it and forgets to
/// uncomment has a `build.gradle` that contains both flag strings and applies neither. Matching the
/// raw text there reports a green check on the exact project the check exists to catch.
///
/// Quote tracking is here for one reason: `maven { url "https://..." }` has a `//` in it, and
/// truncating that line would be a different wrong answer.
fn without_comments(src: &str) -> String {
    let b = src.as_bytes();
    let mut out = String::with_capacity(src.len());
    let mut i = 0;
    let mut quote: Option<u8> = None;

    while i < b.len() {
        let c = b[i];
        match quote {
            Some(q) => {
                out.push(c as char);
                if c == b'\\' && i + 1 < b.len() {
                    out.push(b[i + 1] as char);   // an escaped quote does not close the string
                    i += 2;
                    continue;
                }
                if c == q {
                    quote = None;
                }
                i += 1;
            }
            None if c == b'"' || c == b'\'' => {
                quote = Some(c);
                out.push(c as char);
                i += 1;
            }
            None if c == b'/' && i + 1 < b.len() && b[i + 1] == b'/' => {
                while i < b.len() && b[i] != b'\n' {
                    i += 1;
                }
            }
            None if c == b'/' && i + 1 < b.len() && b[i + 1] == b'*' => {
                i += 2;
                while i + 1 < b.len() && !(b[i] == b'*' && b[i + 1] == b'/') {
                    i += 1;
                }
                i = (i + 2).min(b.len());
                out.push(' ');   // so `a/*x*/b` does not become the identifier `ab`
            }
            None => {
                out.push(c as char);
                i += 1;
            }
        }
    }
    out
}

/// Everything wrong with a project, worst first.
#[tauri::command]
pub fn diagnose_project(dir: String) -> Diagnosis {
    let root = Path::new(&dir);
    // Comments stripped before any of this is searched - see `without_comments`.
    let gradle = without_comments(&read(&root.join("build.gradle")));

    let mut findings = Vec::new();

    check_jvm_flags(&gradle, &mut findings);
    check_java_version(&gradle, &mut findings);
    check_gradle_version(root, &mut findings);
    check_vendordeps(root, &mut findings);

    // Worst first. Somebody reading three lines should read the three that matter.
    findings.sort_by_key(|f| match f.level {
        Level::Blocker => 0,
        Level::Warn => 1,
        Level::Ok => 2,
    });

    let blockers = findings.iter().filter(|f| f.level == Level::Blocker).count();
    let warnings = findings.iter().filter(|f| f.level == Level::Warn).count();

    let summary = if blockers > 0 {
        // The first thing to fix, named. Not a count - a count is not an instruction.
        let first = findings.iter().find(|f| f.level == Level::Blocker).unwrap();
        format!("Not ready: {}", first.what)
    } else if warnings > 0 {
        format!("Ready, {} warning{}", warnings, if warnings == 1 { "" } else { "s" })
    } else {
        "Ready".to_string()
    };

    Diagnosis { ready: blockers == 0, summary, findings }
}

/// The two flags, which is the check this whole module is worth writing for.
fn check_jvm_flags(gradle: &str, out: &mut Vec<Finding>) {
    let has_vm = gradle.contains("jdk.internal.vm");
    let has_lang = gradle.contains("java.base/java.lang");

    if has_vm && has_lang {
        out.push(ok("Commands v3 JVM flags"));
        return;
    }

    // Deliberately one finding rather than two. Both are needed, and a team that fixes the one they
    // were told about will deploy believing they are done and meet the other on the field.
    let detail = if !has_vm && !has_lang {
        "Neither --add-opens flag is in build.gradle. Commands v3 runs on JDK continuations reached \
         by reflection: without both, the robot boots, the dashboard connects, and the first \
         command a driver schedules throws from inside WPILib naming nothing you wrote."
    } else if has_vm {
        "java.base/java.lang is missing. The other flag gets the scheduler constructed; this one \
         gets a command scheduled, so the robot will still die on the first button press."
    } else {
        "java.base/jdk.internal.vm is missing. Without it the command scheduler cannot even be \
         constructed."
    };

    out.push(blocker(
        "Commands v3 JVM flags",
        detail,
        "frc {\n    jvmArgs.addAll([\n        \"--add-opens\", \"java.base/jdk.internal.vm=ALL-UNNAMED\",\n        \"--add-opens\", \"java.base/java.lang=ALL-UNNAMED\",\n    ])\n}",
    ));
}

fn check_java_version(gradle: &str, out: &mut Vec<Finding>) {
    // Any of the spellings a WPILib project uses.
    let modern = gradle.contains("VERSION_25")
        || gradle.contains("JavaLanguageVersion.of(25)")
        || gradle.contains("sourceCompatibility = 25")
        || gradle.contains("release = 25");

    if modern {
        out.push(ok("Java 25"));
        return;
    }

    let old = ["VERSION_17", "VERSION_21", "of(17)", "of(21)"]
        .iter()
        .any(|m| gradle.contains(m));

    if old {
        out.push(blocker(
            "Java 25",
            "This project targets an older Java. WPILib 2027 ships Java 25 bytecode and nothing \
             older can read it - the build fails with 'Unsupported class file major version 69', \
             which names neither the JDK nor the dependency that needs a newer one.",
            "sourceCompatibility = JavaVersion.VERSION_25\ntargetCompatibility = JavaVersion.VERSION_25",
        ));
    } else {
        out.push(warn(
            "Java 25",
            "Could not find a Java version in build.gradle. Catalyst 2.x needs 25.",
            "sourceCompatibility = JavaVersion.VERSION_25",
        ));
    }
}

fn check_gradle_version(root: &Path, out: &mut Vec<Finding>) {
    let props = read(&root.join("gradle").join("wrapper").join("gradle-wrapper.properties"));
    if props.is_empty() {
        out.push(warn(
            "Gradle 9.7+",
            "No Gradle wrapper found, so the version could not be checked.",
            "",
        ));
        return;
    }

    // gradle-9.7.1-bin.zip -> 9
    let major = props
        .split("gradle-")
        .nth(1)
        .and_then(|s| s.split(['.', '-']).next())
        .and_then(|s| s.parse::<u32>().ok());

    match major {
        Some(m) if m >= 9 => out.push(ok("Gradle 9.7+")),
        Some(m) => out.push(blocker(
            "Gradle 9.7+",
            &format!(
                "This project uses Gradle {}. Gradle 8 and earlier cannot parse Java 25 class \
                 files at all, so the build fails before it reaches your code.",
                m
            ),
            "./gradlew wrapper --gradle-version 9.7.1",
        )),
        None => out.push(warn("Gradle 9.7+", "Could not read the wrapper version.", "")),
    }
}

/// Whether the libraries a 2027 robot needs are present, and whether anything is there that cannot
/// be.
///
/// This is a yes/no on the set. What is in each file - the version, the season it declares, whether
/// two files are the same library - is the vendordeps list's job, and it reads the same folder
/// through `vendordeps::read_all` so the two views cannot disagree about what is installed.
fn check_vendordeps(root: &Path, out: &mut Vec<Finding>) {
    let installed = crate::vendordeps::read_all(root);
    let has = |needle: &str| installed.iter().any(|dep| dep.mentions(needle));

    if has("photon") {
        out.push(warn(
            "PhotonVision",
            crate::vendordeps::PHOTONVISION_DETAIL,
            "Delete vendordeps/photonlib.json",
        ));
    }

    if !has("frccatalyst") {
        out.push(warn(
            "Catalyst vendordep",
            "FrcCatalyst is not installed in this project yet.",
            "Use Install into project, on the left.",
        ));
    }

    // Phoenix is needed but cannot be fetched: CTRE publishes no 2027 vendordep JSON at a
    // discoverable URL, so the usual online install quietly fetches a 2026 one.
    //
    // PathPlanner is deliberately NOT checked for. Catalyst depends on it `compileOnly`, so it never
    // reaches a robot's classpath and a robot project needs neither its vendordep nor 3015's maven
    // repository - which its vendordep is what adds. Warning about it told teams to install a
    // library they do not need and a repository they do not need with it.
    if !has("phoenix") {
        out.push(warn(
            "CTRE Phoenix 6",
            "Not installed. Catalyst needs 26.70.0-alpha-2 or later - the first Phoenix built for \
             WPILib alpha-7 - and it has to be added by hand: the usual online install fetches a \
             2026 vendordep, which installs cleanly and fails at build with an error naming none of \
             this. Note that 26.70.x also requires 26.70.x firmware on every TalonFX, CANcoder and \
             Pigeon.",
            "Add it from CTRE's own 2027 instructions.",
        ));
    }
}

// --------------------------------------------------------------------------- migration

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    /// Path relative to the project root, so it reads like something to open.
    pub file: String,
    pub line: usize,
    pub old_name: String,
    pub new_name: String,
    pub why: String,
    /// The line as written, trimmed.
    pub text: String,
}

/// Everything Catalyst renamed between 1.x and 2.x, and why.
///
/// The five decorators are the interesting ones: Commands v3 took those names and gave them
/// incompatible return types, so Java will not permit an override. Nothing else in the library's
/// surface moved.
const RENAMES: &[(&str, &str, &str)] = &[
    (".until(", ".untilTrue(", "Commands v3 took `until` and returns a group builder from it"),
    (".andThen(", ".then(", "Commands v3 took `andThen`"),
    (".alongWith(", ".together(", "Commands v3 took `alongWith`"),
    (".raceWith(", ".racing(", "Commands v3 took `raceWith`"),
    (".withTimeout(", ".timeoutAfter(", "Commands v3 took `withTimeout`"),
    (".getChooser(", ".getChooser(", "now returns Selectable, not SendableChooser, which is gone"),
    (".getServo(", ".getPwm(", "servos cannot be driven from Systemcore at 3.3 V"),
    ("positionConversionFactor(", "", "removed - it never did anything, and every mechanism already converts from rotations"),
];

/// Scan a project's Java for anything 2.x renamed.
///
/// Text matching, deliberately. A real parser would be more precise and would also mean shipping
/// one; the false positives here are a `.until(` on some other type, which a person reading the
/// line can dismiss in a second. Missing a real one is the expensive direction.
#[tauri::command]
pub fn scan_migration(dir: String) -> Vec<Usage> {
    let root = PathBuf::from(&dir);
    let src = root.join("src");
    let mut found = Vec::new();
    walk(&src, &root, &mut found, 0);
    found.sort_by(|a, b| a.file.cmp(&b.file).then(a.line.cmp(&b.line)));
    found
}

/// Depth-limited so a symlink loop or a vendored dependency tree cannot hang the request.
fn walk(dir: &Path, root: &Path, out: &mut Vec<Usage>, depth: usize) {
    if depth > 12 || out.len() > 500 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk(&path, root, out, depth + 1);
        } else if path.extension().is_some_and(|e| e == "java") {
            scan_file(&path, root, out);
        }
    }
}

fn scan_file(path: &Path, root: &Path, out: &mut Vec<Usage>) {
    let text = read(path);
    if text.is_empty() {
        return;
    }
    let relative = path
        .strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/");

    for (number, line) in text.lines().enumerate() {
        let trimmed = line.trim();
        // A line that is only a comment is not a call site. Cheap, and it removes most of the noise
        // from javadoc that names the old method while explaining the new one.
        if trimmed.starts_with("//") || trimmed.starts_with('*') {
            continue;
        }
        for (old, new, why) in RENAMES {
            if line.contains(old) {
                out.push(Usage {
                    file: relative.clone(),
                    line: number + 1,
                    old_name: old.trim_start_matches('.').trim_end_matches('(').to_string(),
                    new_name: new.trim_start_matches('.').trim_end_matches('(').to_string(),
                    why: why.to_string(),
                    text: trimmed.chars().take(160).collect(),
                });
            }
        }
    }
}

#[cfg(test)]
#[path = "doctor_tests.rs"]
mod tests;
