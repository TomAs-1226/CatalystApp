//! What is actually in a team's `vendordeps/` folder, file by file, and what is wrong with the set.
//!
//! Gradle reads every `*.json` in that folder and takes each one at its word. Nothing in there is
//! validated against the project it sits in, so the folder is where a season transition goes wrong
//! quietly: the file is well-formed, the install said it worked, and the build fails weeks later
//! naming a Maven coordinate instead of the file that asked for it.
//!
//! Four things go wrong, and none of them look wrong in an editor:
//!
//!   - A vendordep for last season. `frcYear` is the only thing that says so, and the online install
//!     flow fetches whatever the vendor publishes at that URL, which through a transition is still
//!     the old one.
//!   - PhotonVision, which has no 2027 build to move to.
//!   - The same library twice under two file names. Gradle resolves one of them and the team reads
//!     the other.
//!   - A file that will not parse, which stops the build with a message that names the file and
//!     nothing about what is wrong with it.
//!
//! The Doctor asks "will this project run" and answers in one verdict. This asks "what is installed"
//! and answers one row per file, because a team that has to fix a vendordep has to open a specific
//! file — a verdict does not tell them which.
//!
//! Nothing here writes. It reads the folder and reports.

// The Doctor's severity vocabulary, reused rather than restated. Two views of the same project that
// grade the same fact differently is worse than either of them grading it wrong, and the Doctor's
// own vendordep checks (below, through `read_all`) now read the same files this does.
use crate::doctor::{blocker, warn, Finding, Level};
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::Path;

/// Why PhotonVision cannot stay, in one place so the Doctor and this list cannot drift apart.
pub const PHOTONVISION_DETAIL: &str =
    "PhotonVision has no 2027 build, and Catalyst is Limelight-first on Systemcore - the pipeline \
     is in the hardware. Leaving this here will fail the build.";

/// Whether a file's declared season lines up with the project's.
///
/// Kept as a state rather than a bool so the row can say *why* it is not being graded: a project
/// that never declared a season is a different situation from one whose vendordep is a year out,
/// and showing both as "not ok" would invent a problem the team does not have.
#[derive(Serialize, PartialEq, Clone, Copy, Debug)]
#[serde(rename_all = "kebab-case")]
pub enum YearState {
    Match,
    Mismatch,
    /// The file declares no `frcYear` at all.
    Missing,
    /// The project does not say which season it is, so there is nothing to compare against.
    ProjectUnknown,
}

/// One vendordep file, as it declares itself, plus everything wrong with it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Vendordep {
    /// The file on disk — which is the thing somebody has to go and open, so it leads the row even
    /// when the library inside names itself something else entirely (`PhotonVision.json` declares
    /// itself `photonlib`).
    pub file: String,
    pub name: Option<String>,
    pub version: Option<String>,
    pub frc_year: Option<String>,
    pub uuid: Option<String>,
    /// The file is there but nothing could be read out of it.
    pub malformed: bool,
    /// Another file in the folder declares the same library.
    pub duplicate: bool,
    pub year_state: YearState,
    /// The worst of `problems`, so the row is graded in one place rather than re-derived by the UI.
    pub level: Level,
    pub problems: Vec<Finding>,
    /// How this file is matched against the others. Not shown — it is an implementation detail of
    /// duplicate detection, and a uuid on screen helps nobody.
    #[serde(skip)]
    key: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VendordepReport {
    /// From `.wpilib/wpilib_preferences.json`. Everything below is graded against this, so it is
    /// reported rather than assumed.
    pub project_year: Option<String>,
    pub deps: Vec<Vendordep>,
    /// Wrong with the set rather than with any one file, so there is no row to hang them on.
    pub notes: Vec<Finding>,
    pub ready: bool,
    /// One line for a header, in the Doctor's phrasing.
    pub summary: String,
}

// --------------------------------------------------------------------------- reading the folder

/// Every `*.json` in `<root>/vendordeps`, parsed as far as each one will go.
///
/// This is also what the Doctor's vendordep checks run on, so "installed" means the same thing in
/// both views: a file Gradle would actually load, matched on what it declares rather than only on
/// what it is called.
pub fn read_all(root: &Path) -> Vec<Vendordep> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(root.join("vendordeps")) else {
        return out;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        // Gradle loads `*.json` from this folder and nothing else. A `Phoenix6.json.bak` left behind
        // by a hand edit is invisible to the build, so it is invisible here too — listing it would
        // send somebody to deal with a file that is already doing nothing.
        if !path.is_file() || !path.extension().is_some_and(|e| e.eq_ignore_ascii_case("json")) {
            continue;
        }
        out.push(parse(&path, entry.file_name().to_string_lossy().to_string()));
    }
    out.sort_by(|a, b| a.file.to_lowercase().cmp(&b.file.to_lowercase()));
    out
}

impl Vendordep {
    /// Whether this file is the named library, matched on both the file name and the name declared
    /// inside it.
    ///
    /// Both, because either one alone misses a real case: a team that renames `photonlib.json` to
    /// `vision.json` still has PhotonVision in the build, and a freshly hand-made file may declare
    /// no name at all while being called exactly what it is.
    pub fn mentions(&self, needle: &str) -> bool {
        let needle = needle.to_lowercase();
        self.file.to_lowercase().contains(&needle)
            || self
                .name
                .as_deref()
                .is_some_and(|n| n.to_lowercase().contains(&needle))
    }
}

fn parse(path: &Path, file: String) -> Vendordep {
    let text = fs::read_to_string(path).unwrap_or_default();

    let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else {
        // Half-written by an interrupted install, or edited by hand and left with a trailing comma.
        // It has to be reported rather than skipped: Gradle stops on it, and silently omitting the
        // file from this list would leave a team staring at an inventory that says nothing is wrong
        // next to a build that will not configure.
        let mut dep = blank(file.clone());
        dep.malformed = true;
        dep.problems.push(blocker(
            "Not valid JSON",
            "Nothing could be read out of this file. Gradle parses every JSON in vendordeps before \
             it configures the project, so the build stops here — and the message it gives names \
             the file without saying what about it is wrong.",
            &format!("Open vendordeps/{file}, or delete it and install the library again."),
        ));
        return dep;
    };

    let name = field(&json, "name");
    let uuid = field(&json, "uuid");
    let key = library_key(uuid.as_deref(), name.as_deref(), &file);

    Vendordep {
        version: field(&json, "version"),
        frc_year: field(&json, "frcYear"),
        name,
        uuid,
        key,
        ..blank(file)
    }
}

fn blank(file: String) -> Vendordep {
    Vendordep {
        key: normalise_stem(&file),
        file,
        name: None,
        version: None,
        frc_year: None,
        uuid: None,
        malformed: false,
        duplicate: false,
        year_state: YearState::Missing,
        level: Level::Ok,
        problems: Vec::new(),
    }
}

/// A field read as text whether the vendor wrote it quoted or not.
///
/// Every vendordep checked writes `frcYear` and `version` as strings, but WPILib's own preferences
/// file has been written both ways across seasons and these are hand-edited often enough that
/// nothing here depends on the type. An empty string is treated as absent — `WPILibNewCommands.json`
/// ships `"jsonUrl": ""`, and a blank is not a value.
fn field(json: &serde_json::Value, key: &str) -> Option<String> {
    json.get(key)
        .and_then(|v| match v {
            serde_json::Value::String(s) => Some(s.trim().to_string()),
            serde_json::Value::Number(n) => Some(n.to_string()),
            _ => None,
        })
        .filter(|s| !s.is_empty())
}

/// How two files are decided to be the same library.
///
/// `uuid` first, because it is what the vendor stamps and it survives a rename — `Phoenix6.json` and
/// `Phoenix6-2026.json` carry the same one, and that pair is the whole reason this check exists. The
/// declared name and then the file name are fallbacks for hand-made files that have no uuid, where
/// matching on nothing would mean never reporting the duplicate at all.
fn library_key(uuid: Option<&str>, name: Option<&str>, file: &str) -> String {
    match (uuid, name) {
        (Some(u), _) => format!("uuid:{}", u.to_lowercase()),
        (None, Some(n)) => format!("name:{}", n.to_lowercase()),
        (None, None) => normalise_stem(file),
    }
}

/// The file name with the season and release-channel noise taken out of it.
///
/// `Phoenix6-frc2026-latest.json` and `Phoenix6.json` are the same library under two names, and a
/// literal comparison of the two says they are unrelated — which is the exact pair a team ends up
/// with after installing once from the online list and once from a downloaded file.
fn normalise_stem(file: &str) -> String {
    let lower = file.to_lowercase();
    let stem = lower.strip_suffix(".json").unwrap_or(&lower);
    let kept: Vec<&str> = stem
        .split(['-', '_', '.'])
        .filter(|t| !t.is_empty() && !is_noise(t))
        .collect();
    format!("file:{}", kept.join(""))
}

fn is_noise(token: &str) -> bool {
    let year = |t: &str| t.len() == 4 && t.chars().all(|c| c.is_ascii_digit());
    matches!(token, "latest" | "beta" | "alpha" | "dev" | "release" | "frc")
        || year(token)
        || token.strip_prefix("frc").is_some_and(year)
}

/// The season a project was created for, from `.wpilib/wpilib_preferences.json`.
///
/// Lives here rather than in the installer because this is where it is compared to something.
/// WPILib writes it as a number in some seasons and a string in others; returning `"2027"` for one
/// and `2027` for the other pushes the difference out to every caller, which then compares strings
/// and disagrees with itself.
pub fn project_year(root: &Path) -> Option<String> {
    fs::read_to_string(root.join(".wpilib").join("wpilib_preferences.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|j| {
            j.get("projectYear").map(|x| match x.as_str() {
                Some(text) => text.to_string(),
                None => x.to_string().trim_matches('"').to_string(),
            })
        })
        .filter(|s| !s.trim().is_empty())
}

/// The leading four digits of a season string.
///
/// WPILib writes `2027_alpha1` through preseason while vendors write a plain `2027`, and comparing
/// those two as text reports a mismatch on a project that is correctly configured — a false blocker
/// on every alpha project, which is most of them right now.
fn season(text: &str) -> Option<u32> {
    let digits: String = text.chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok().filter(|y| (2000..=2100).contains(y))
}

// --------------------------------------------------------------------------- the report

/// Read a project's `vendordeps/` and say what is wrong with what is in it.
#[tauri::command]
pub fn inspect_vendordeps(dir: String) -> VendordepReport {
    let root = Path::new(&dir);
    let project_year = project_year(root);
    let mut deps = read_all(root);
    let mut notes = Vec::new();

    if !root.join("vendordeps").is_dir() {
        notes.push(warn(
            "No vendordeps folder",
            "This folder has no vendordeps directory, so either no vendor library has ever been \
             installed here or this is not the project root.",
            "",
        ));
    } else if deps.is_empty() {
        notes.push(warn(
            "Nothing installed",
            "The vendordeps folder is empty. A Catalyst robot needs at least FrcCatalyst, and \
             almost always Phoenix 6 alongside it. PathPlanner is optional: Catalyst depends on it \
             compileOnly, so it never reaches a robot's classpath.",
            "Use Install into project, on the left.",
        ));
    }

    if project_year.is_none() && !deps.is_empty() {
        notes.push(warn(
            "Project season not declared",
            "There is no projectYear in .wpilib/wpilib_preferences.json, so nothing below can be \
             checked against the season this project is for. Each file is still listed with the \
             season it declares; whether that is the right one is a judgement only you can make.",
            "",
        ));
    }

    check_years(&mut deps, project_year.as_deref());
    check_duplicates(&mut deps);
    check_unsupported(&mut deps, project_year.as_deref());

    for dep in &mut deps {
        dep.level = worst(&dep.problems);
    }

    // Worst first, then by file name. Same reasoning as the Doctor — somebody reading three rows
    // should read the three that matter — and it has the side effect that two copies of one library,
    // which carry the same problem and usually the same name, land next to each other.
    deps.sort_by(|a, b| rank(a.level).cmp(&rank(b.level)).then(a.file.cmp(&b.file)));

    let problems = || deps.iter().flat_map(|d| d.problems.iter()).chain(notes.iter());
    let blockers = problems().filter(|p| p.level == Level::Blocker).count();
    let warnings = problems().filter(|p| p.level == Level::Warn).count();

    let summary = summarise(&deps, &notes, blockers, warnings, project_year.as_deref());

    VendordepReport { project_year, deps, notes, ready: blockers == 0, summary }
}

fn summarise(
    deps: &[Vendordep],
    notes: &[Finding],
    blockers: usize,
    warnings: usize,
    project_year: Option<&str>,
) -> String {
    if blockers > 0 {
        // Named, and with the file to open. A count says how bad it is; it does not say what to do.
        let (file, what) = deps
            .iter()
            .flat_map(|d| d.problems.iter().map(move |p| (d.file.as_str(), p)))
            .find(|(_, p)| p.level == Level::Blocker)
            .map(|(f, p)| (f, p.what.as_str()))
            .unwrap_or(("", "see below"));
        return format!("Not ready: {what} in {file}");
    }
    if deps.is_empty() {
        return notes
            .first()
            .map(|n| n.what.clone())
            .unwrap_or_else(|| "No vendor libraries installed".into());
    }

    let count = format!("{} vendor librar{}", deps.len(), if deps.len() == 1 { "y" } else { "ies" });
    if warnings > 0 {
        return format!("{count}, {warnings} warning{}", if warnings == 1 { "" } else { "s" });
    }
    match project_year {
        Some(year) => format!("{count}, all on {year}"),
        None => format!("{count}, nothing wrong with the files themselves"),
    }
}

fn rank(level: Level) -> u8 {
    match level {
        Level::Blocker => 0,
        Level::Warn => 1,
        Level::Ok => 2,
    }
}

fn worst(problems: &[Finding]) -> Level {
    if problems.iter().any(|p| p.level == Level::Blocker) {
        Level::Blocker
    } else if problems.iter().any(|p| p.level == Level::Warn) {
        Level::Warn
    } else {
        Level::Ok
    }
}

// --------------------------------------------------------------------------- the checks

/// The season each file declares, against the season the project is for.
///
/// This is the check the module is worth writing for. Nothing else in a vendordep is wrong in a way
/// that survives an install: the file is valid, the URLs resolve, the artifacts download, and the
/// build fails on a coordinate that names the vendor and the version but never the season.
fn check_years(deps: &mut [Vendordep], project_year: Option<&str>) {
    for dep in deps.iter_mut() {
        if dep.malformed {
            continue; // its own problem is already reported, and there is no year to read
        }
        let file = dep.file.clone();

        let Some(declared) = dep.frc_year.clone() else {
            dep.year_state = YearState::Missing;
            dep.problems.push(warn(
                "No season declared",
                "This file has no frcYear, so nothing — not WPILib, not this list — can tell which \
                 season it was built for. Every vendordep published for 2026 and 2027 carries one, \
                 so a file without it has been hand-made or hand-edited.",
                &format!("Compare vendordeps/{file} against the vendor's published vendordep."),
            ));
            continue;
        };

        let Some(project) = project_year else {
            dep.year_state = YearState::ProjectUnknown;
            continue;
        };

        // Numerically where both parse, so a `2027_alpha1` project does not report every correctly
        // installed 2027 vendordep as a year out.
        let same = match (season(&declared), season(project)) {
            (Some(a), Some(b)) => a == b,
            _ => declared == project,
        };
        if same {
            dep.year_state = YearState::Match;
            continue;
        }

        dep.year_state = YearState::Mismatch;
        dep.problems.push(blocker(
            "Season mismatch",
            &format!(
                "Declares frcYear {declared} in a {project} project. Installing from VS Code's \
                 online list fetches whatever the vendor publishes at that URL, and through a \
                 season change that is still last year's file: it installs without complaint, \
                 resolves {declared} artifacts against a {project} WPILib, and fails at build with \
                 an error naming none of this."
            ),
            &format!(
                "Get the vendor's {project} vendordep, then delete vendordeps/{file}. Phoenix 6 has \
                 to be added by hand for 2027 — CTRE publishes no 2027 vendordep at a discoverable \
                 URL, and the build Catalyst needs is 26.70.0-alpha-2 or later."
            ),
        ));
    }
}

/// The same library installed twice under two file names.
///
/// It builds. That is what makes it worth a check: Gradle is handed both sets of coordinates and
/// resolves one of them, so the team has a file open that describes a version which is not in the
/// build, and every question they ask of it gets a confidently wrong answer.
fn check_duplicates(deps: &mut [Vendordep]) {
    let mut groups: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, dep) in deps.iter().enumerate() {
        if dep.malformed {
            continue; // nothing was readable, so it cannot be matched to anything
        }
        groups.entry(dep.key.clone()).or_default().push(i);
    }

    for indexes in groups.into_values() {
        if indexes.len() < 2 {
            continue;
        }
        let versions: Vec<String> = indexes
            .iter()
            .map(|&i| deps[i].version.clone().unwrap_or_else(|| "an unstated version".into()))
            .collect();
        let identical = versions.iter().all(|v| *v == versions[0]);

        for (slot, &i) in indexes.iter().enumerate() {
            let others: Vec<String> = indexes
                .iter()
                .enumerate()
                .filter(|(other, _)| *other != slot)
                .map(|(other, &j)| format!("{} ({})", deps[j].file, versions[other]))
                .collect();
            let others = others.join(", ");

            deps[i].duplicate = true;
            deps[i].problems.push(if identical {
                warn(
                    "Installed twice",
                    &format!(
                        "The same library at the same version is also in {others}. Nothing breaks \
                         today, but the next version bump updates one of these files and leaves the \
                         other, and that is the state this stops being harmless in."
                    ),
                    "Keep one of them and delete the rest.",
                )
            } else {
                blocker(
                    "Installed twice at different versions",
                    &format!(
                        "The same library is also declared in {others}. Gradle is handed both sets \
                         of coordinates and resolves the newer one, so one of these files describes \
                         a version that is not in the build — and reading it while debugging gives \
                         answers that match nothing running on the robot."
                    ),
                    "Delete the file with the version you are not keeping.",
                )
            });
        }
    }
}

/// Libraries that cannot be in a 2027 project at any version.
///
/// PhotonVision is the only one so far, and it is not a version problem: there is nothing newer to
/// move to. Skipped for a project that says it is 2026 or earlier, where it is simply correct — the
/// Doctor flags it unconditionally because the Doctor's only question is whether a project will run
/// on 2027, but an inventory that calls a working 2026 project broken is just wrong.
fn check_unsupported(deps: &mut [Vendordep], project_year: Option<&str>) {
    let legacy_season = project_year.and_then(season).is_some_and(|y| y < 2027);
    if legacy_season {
        return;
    }
    for dep in deps.iter_mut() {
        if !dep.mentions("photon") {
            continue;
        }
        let file = dep.file.clone();
        dep.problems.push(warn(
            "PhotonVision",
            PHOTONVISION_DETAIL,
            &format!("Delete vendordeps/{file}"),
        ));
    }
}

#[cfg(test)]
#[path = "vendordeps_tests.rs"]
mod tests;
