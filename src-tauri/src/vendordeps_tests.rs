//! The vendordep list, against the folders it exists to explain.
//!
//! Every fixture here is a project that installs cleanly. None of these files are rejected by the
//! installer, none of them look wrong opened in an editor, and all but the malformed one produce a
//! build that either fails on a coordinate that names no season or succeeds while running code the
//! team is not reading.

use super::*;
use std::fs;
use std::path::PathBuf;

struct Project(PathBuf);

impl Project {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("catalyst-vendordeps-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        Project(dir)
    }

    /// A 2027 project, which is the situation every one of these checks is about.
    fn season_2027(name: &str) -> Self {
        Project::new(name).file(".wpilib/wpilib_preferences.json", r#"{"projectYear": "2027"}"#)
    }

    fn file(self, rel: &str, contents: &str) -> Self {
        let path = self.0.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents).unwrap();
        self
    }

    /// A vendordep written the way a vendor writes one, so the fixtures differ from the real thing
    /// only in the values.
    fn dep(self, file: &str, name: &str, version: &str, year: &str) -> Self {
        let uuid = format!("uuid-for-{}", name.to_lowercase());
        self.dep_with_uuid(file, name, version, year, &uuid)
    }

    fn dep_with_uuid(
        self,
        file: &str,
        name: &str,
        version: &str,
        year: &str,
        uuid: &str,
    ) -> Self {
        let body = format!(
            r#"{{
  "fileName": "{file}",
  "name": "{name}",
  "version": "{version}",
  "frcYear": "{year}",
  "uuid": "{uuid}",
  "mavenUrls": ["https://jitpack.io"],
  "jsonUrl": "",
  "javaDependencies": [
    {{ "groupId": "com.example", "artifactId": "{name}-java", "version": "{version}" }}
  ],
  "jniDependencies": [],
  "cppDependencies": []
}}"#
        );
        self.file(&format!("vendordeps/{file}"), &body)
    }

    fn inspect(&self) -> VendordepReport {
        inspect_vendordeps(self.0.to_string_lossy().to_string())
    }
}

impl Drop for Project {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn row<'a>(r: &'a VendordepReport, file: &str) -> &'a Vendordep {
    r.deps
        .iter()
        .find(|d| d.file == file)
        .unwrap_or_else(|| panic!("{file} is not in the list at all"))
}

fn problem<'a>(dep: &'a Vendordep, what: &str) -> &'a Finding {
    dep.problems
        .iter()
        .find(|p| p.what.contains(what))
        .unwrap_or_else(|| panic!("no problem about {what} on {}: {:?}", dep.file,
                                 dep.problems.iter().map(|p| &p.what).collect::<Vec<_>>()))
}

// --- last season's vendordep -------------------------------------------------

#[test]
fn a_2026_vendordep_in_a_2027_project_is_a_blocker() {
    // The one this module is worth writing for. The file is valid, the install said it worked, and
    // the build failure when it comes names a Maven coordinate rather than this file.
    let r = Project::season_2027("stale")
        .dep("Phoenix6.json", "CTRE-Phoenix (v6)", "26.3.0", "2026")
        .inspect();

    let dep = row(&r, "Phoenix6.json");
    assert!(matches!(dep.level, Level::Blocker));
    assert_eq!(dep.year_state, YearState::Mismatch);
    assert!(!r.ready);

    let p = problem(dep, "Season mismatch");
    assert!(p.detail.contains("2026") && p.detail.contains("2027"),
            "both seasons should be named: {}", p.detail);
}

#[test]
fn a_2027_vendordep_in_a_2027_project_is_left_alone() {
    let r = Project::season_2027("current")
        .dep("FrcCatalyst.json", "FrcCatalyst", "2.0.0-alpha.1", "2027")
        .inspect();

    let dep = row(&r, "FrcCatalyst.json");
    assert!(matches!(dep.level, Level::Ok), "{:?}", dep.problems.len());
    assert_eq!(dep.year_state, YearState::Match);
    assert!(r.ready);
}

#[test]
fn a_preseason_project_does_not_report_every_file_as_a_year_out() {
    // WPILib writes `2027_alpha1` through preseason while vendors write a plain `2027`. Comparing
    // those as text calls a correctly configured project broken, on every alpha project there is.
    let r = Project::new("alpha")
        .file(".wpilib/wpilib_preferences.json", r#"{"projectYear": "2027_alpha1"}"#)
        .dep("FrcCatalyst.json", "FrcCatalyst", "2.0.0-alpha.1", "2027")
        .inspect();

    assert_eq!(row(&r, "FrcCatalyst.json").year_state, YearState::Match);
    assert!(r.ready, "{}", r.summary);
}

#[test]
fn a_project_year_written_as_a_number_still_compares() {
    let r = Project::new("numberyear")
        .file(".wpilib/wpilib_preferences.json", r#"{"projectYear": 2027}"#)
        .dep("FrcCatalyst.json", "FrcCatalyst", "2.0.0", "2027")
        .inspect();

    assert_eq!(r.project_year.as_deref(), Some("2027"));
    assert_eq!(row(&r, "FrcCatalyst.json").year_state, YearState::Match);
}

#[test]
fn a_file_with_no_season_is_reported_rather_than_assumed_current() {
    let r = Project::season_2027("noyear")
        .file("vendordeps/Homemade.json", r#"{"name": "Homemade", "version": "1.0.0"}"#)
        .inspect();

    let dep = row(&r, "Homemade.json");
    assert_eq!(dep.year_state, YearState::Missing);
    assert!(matches!(dep.level, Level::Warn), "unknown is not the same as wrong");
    problem(dep, "No season declared");
}

#[test]
fn a_project_that_declares_no_season_grades_nothing_and_says_so() {
    // Guessing here would be the worst outcome: a 2026 project would light up red for being exactly
    // what it is meant to be.
    let r = Project::new("noprojectyear")
        .dep("Phoenix6.json", "CTRE-Phoenix (v6)", "26.3.0", "2026")
        .inspect();

    let dep = row(&r, "Phoenix6.json");
    assert_eq!(dep.year_state, YearState::ProjectUnknown);
    assert!(matches!(dep.level, Level::Ok), "nothing to compare against is not a problem with the file");
    assert!(r.notes.iter().any(|n| n.what.contains("season")), "but the list has to say why");
    assert_eq!(dep.frc_year.as_deref(), Some("2026"), "the season is still shown");
}

// --- the same library twice --------------------------------------------------

#[test]
fn two_copies_of_one_library_at_different_versions_are_a_blocker() {
    // Both files are valid and the build succeeds. Gradle resolves one of them, and the team debugs
    // the other.
    let r = Project::season_2027("dupe")
        .dep_with_uuid("Phoenix6.json", "CTRE-Phoenix (v6)", "27.1.0", "2027", "e995de00")
        .dep_with_uuid("Phoenix6-2026.json", "CTRE-Phoenix (v6)", "26.3.0", "2027", "e995de00")
        .inspect();

    for file in ["Phoenix6.json", "Phoenix6-2026.json"] {
        let dep = row(&r, file);
        assert!(dep.duplicate, "{file} should be marked as a duplicate");
        assert!(matches!(dep.level, Level::Blocker), "{file}");
        // Each row has to name the other file, or the reader is told there is a duplicate and left
        // to find it.
        let p = problem(dep, "Installed twice");
        assert!(p.detail.contains("Phoenix6"), "{}", p.detail);
    }
    assert!(!r.ready);
}

#[test]
fn a_duplicate_is_matched_by_uuid_not_by_file_name() {
    // The pair a team actually ends up with: installed once from the online list, once from a
    // downloaded file, under two names that look unrelated.
    let r = Project::season_2027("uuiddupe")
        .dep_with_uuid("PathplannerLib.json", "PathplannerLib", "2027.1.0", "2027", "1b42324f")
        .dep_with_uuid("pathplanner-old.json", "PathPlannerLib", "2026.1.2", "2027", "1b42324f")
        .inspect();

    assert!(row(&r, "PathplannerLib.json").duplicate);
    assert!(row(&r, "pathplanner-old.json").duplicate);
}

#[test]
fn a_duplicate_with_no_uuid_is_still_caught_by_the_file_name() {
    // Hand-made files carry no uuid. Matching on nothing would mean never reporting these at all.
    let r = Project::season_2027("stemdupe")
        .file("vendordeps/Phoenix6.json", "{}")
        .file("vendordeps/Phoenix6-frc2026-latest.json", "{}")
        .inspect();

    assert!(row(&r, "Phoenix6.json").duplicate);
    assert!(row(&r, "Phoenix6-frc2026-latest.json").duplicate);
}

#[test]
fn the_identical_same_file_twice_warns_rather_than_blocks() {
    // Nothing is resolved wrongly today. It is still worth saying, because the next version bump
    // updates one and leaves the other.
    let r = Project::season_2027("samedupe")
        .dep_with_uuid("Phoenix6.json", "CTRE-Phoenix (v6)", "27.1.0", "2027", "e995de00")
        .dep_with_uuid("Phoenix6-copy.json", "CTRE-Phoenix (v6)", "27.1.0", "2027", "e995de00")
        .inspect();

    assert!(matches!(row(&r, "Phoenix6.json").level, Level::Warn));
    assert!(r.ready, "identical copies do not stop the build");
}

#[test]
fn different_libraries_are_not_duplicates_of_each_other() {
    let r = Project::season_2027("distinct")
        .dep("FrcCatalyst.json", "FrcCatalyst", "2.0.0", "2027")
        .dep("PathplannerLib.json", "PathplannerLib", "2027.1.0", "2027")
        .dep("WPILibNewCommands.json", "WPILib-New-Commands", "1.0.0", "2027")
        .inspect();

    assert!(r.deps.iter().all(|d| !d.duplicate), "{}", r.summary);
    assert!(r.ready);
}

// --- files that will not parse ----------------------------------------------

#[test]
fn a_malformed_vendordep_is_reported_not_swallowed() {
    // Skipping it would leave a team looking at a list that says nothing is wrong, beside a build
    // that will not configure.
    let r = Project::season_2027("broken")
        .file("vendordeps/FrcCatalyst.json", "{ \"name\": \"FrcCatalyst\", ")
        .inspect();

    let dep = row(&r, "FrcCatalyst.json");
    assert!(dep.malformed);
    assert!(matches!(dep.level, Level::Blocker));
    assert!(dep.name.is_none(), "nothing could be read out of it");
    problem(dep, "Not valid JSON");
    assert!(!r.ready);
}

#[test]
fn one_broken_file_does_not_hide_the_rest_of_the_folder() {
    let r = Project::season_2027("brokenplus")
        .file("vendordeps/Broken.json", "not json at all")
        .dep("Phoenix6.json", "CTRE-Phoenix (v6)", "26.3.0", "2026")
        .dep("FrcCatalyst.json", "FrcCatalyst", "2.0.0", "2027")
        .inspect();

    assert_eq!(r.deps.len(), 3);
    assert_eq!(row(&r, "Phoenix6.json").year_state, YearState::Mismatch);
    assert_eq!(row(&r, "FrcCatalyst.json").year_state, YearState::Match);
}

#[test]
fn a_malformed_file_is_not_matched_as_a_duplicate_of_anything() {
    // There is nothing readable to match on, and telling somebody a file they cannot open duplicates
    // one they can sends them to delete the wrong one.
    let r = Project::season_2027("brokendupe")
        .file("vendordeps/Phoenix6.json", "{ broken")
        .file("vendordeps/Phoenix6-2026.json", "{ broken too")
        .inspect();

    assert!(r.deps.iter().all(|d| !d.duplicate));
    assert!(r.deps.iter().all(|d| d.malformed));
}

// --- what is and is not in the folder ---------------------------------------

#[test]
fn only_files_gradle_would_load_are_listed() {
    // Gradle reads `*.json` and nothing else, so a `.bak` left by a hand edit is already doing
    // nothing. Listing it would send somebody to deal with a file that has no effect.
    let r = Project::season_2027("bak")
        .dep("FrcCatalyst.json", "FrcCatalyst", "2.0.0", "2027")
        .file("vendordeps/Phoenix6.json.bak", "{}")
        .file("vendordeps/notes.txt", "reminder")
        .inspect();

    assert_eq!(r.deps.len(), 1);
    assert_eq!(r.deps[0].file, "FrcCatalyst.json");
}

#[test]
fn a_folder_with_no_vendordeps_directory_says_so_instead_of_looking_clean() {
    let r = Project::season_2027("nofolder").inspect();

    assert!(r.deps.is_empty());
    assert!(r.notes.iter().any(|n| n.what.contains("No vendordeps folder")), "{}", r.summary);
    assert!(!r.summary.is_empty());
}

// --- PhotonVision ------------------------------------------------------------

#[test]
fn photonvision_is_flagged_in_a_2027_project() {
    // Not a version problem. There is no 2027 build to move to.
    let r = Project::season_2027("photon")
        .dep("PhotonVision.json", "photonlib", "v2026.3.1", "2027")
        .inspect();

    problem(row(&r, "PhotonVision.json"), "PhotonVision");
}

#[test]
fn photonvision_is_matched_on_what_it_declares_not_only_on_its_file_name() {
    // `PhotonVision.json` declares itself `photonlib`; a team that renames the file still has it in
    // the build.
    let r = Project::season_2027("photonrenamed")
        .dep("vision.json", "photonlib", "v2026.3.1", "2027")
        .inspect();

    problem(row(&r, "vision.json"), "PhotonVision");
}

#[test]
fn photonvision_is_left_alone_in_a_2026_project() {
    // Where it is simply correct. An inventory that calls a working project broken is just wrong.
    let r = Project::new("photon2026")
        .file(".wpilib/wpilib_preferences.json", r#"{"projectYear": "2026"}"#)
        .dep("PhotonVision.json", "photonlib", "v2026.3.1", "2026")
        .inspect();

    assert!(matches!(row(&r, "PhotonVision.json").level, Level::Ok));
    assert!(r.ready);
}

// --- the verdict -------------------------------------------------------------

#[test]
fn the_summary_names_the_file_to_open() {
    // A count says how bad it is. It does not say which of nine files to open.
    let r = Project::season_2027("summary")
        .dep("FrcCatalyst.json", "FrcCatalyst", "2.0.0", "2027")
        .dep("Phoenix6.json", "CTRE-Phoenix (v6)", "26.3.0", "2026")
        .inspect();

    assert!(r.summary.starts_with("Not ready: "), "{}", r.summary);
    assert!(r.summary.contains("Phoenix6.json"), "{}", r.summary);
}

#[test]
fn the_worst_row_is_first() {
    let r = Project::season_2027("order")
        .dep("AAA.json", "AAA", "1.0.0", "2027")
        .dep("Phoenix6.json", "CTRE-Phoenix (v6)", "26.3.0", "2026")
        .inspect();

    assert_eq!(r.deps[0].file, "Phoenix6.json", "alphabetical order would put AAA first");
}

#[test]
fn a_clean_set_says_which_season_it_is_all_on() {
    let r = Project::season_2027("clean")
        .dep("FrcCatalyst.json", "FrcCatalyst", "2.0.0", "2027")
        .dep("PathplannerLib.json", "PathplannerLib", "2027.1.0", "2027")
        .inspect();

    assert!(r.ready);
    assert_eq!(r.summary, "2 vendor libraries, all on 2027");
}

// --- against real vendor files -----------------------------------------------

#[test]
fn the_field_names_are_read_off_a_real_vendordep() {
    // The whole module is field-name spelling. `frcYear`, `name`, `version` and `uuid` are read from
    // files written by CTRE, PathPlanner and WPILib rather than by this repo, so a fixture agreeing
    // with the parser proves nothing on its own.
    let example = PathBuf::from("C:/Users/yu_th/dev/FrcCatalyst-v1.1.0/example");
    if !example.exists() {
        return; // not checked out beside this repo
    }
    let r = inspect_vendordeps(example.to_string_lossy().to_string());
    assert!(!r.deps.is_empty(), "the example ships vendordeps");

    for dep in &r.deps {
        assert!(!dep.malformed, "{} did not parse", dep.file);
        assert!(dep.name.is_some(), "{} declared no name", dep.file);
        assert!(dep.version.is_some(), "{} declared no version", dep.file);
        assert!(dep.frc_year.is_some(), "{} declared no frcYear", dep.file);
    }

    // The example is a 2026 project and its vendordeps are 2026 files, which is the state a correct
    // project is in — no row should be graded against a season it was never for.
    assert_eq!(r.project_year.as_deref(), Some("2026"));
    assert!(
        r.deps.iter().all(|d| d.year_state == YearState::Match),
        "{:?}",
        r.deps.iter().map(|d| (&d.file, &d.frc_year)).collect::<Vec<_>>()
    );
    assert!(r.deps.iter().all(|d| !d.duplicate), "{}", r.summary);
}
