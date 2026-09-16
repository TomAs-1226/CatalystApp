//! The Doctor, against projects in the states it exists to find.
//!
//! Each of these is a project that builds and deploys and then fails on the field. That is the whole
//! category — a check for something the compiler already catches would be redundant.

use super::*;
use std::fs;
use std::path::PathBuf;

struct Project(PathBuf);

impl Project {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("catalyst-doctor-{name}"));
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

    /// A project with everything right, so a test perturbs exactly one thing.
    fn healthy(name: &str) -> Self {
        Project::new(name)
            .file("build.gradle", GOOD_GRADLE)
            .file("gradle/wrapper/gradle-wrapper.properties", GRADLE_9)
            .file("vendordeps/FrcCatalyst.json", "{}")
            .file("vendordeps/Phoenix6.json", "{}")
            .file("vendordeps/PathplannerLib.json", "{}")
    }

    fn diagnose(&self) -> Diagnosis {
        diagnose_project(self.0.to_string_lossy().to_string())
    }

    fn scan(&self) -> Vec<Usage> {
        scan_migration(self.0.to_string_lossy().to_string())
    }
}

impl Drop for Project {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

const GOOD_GRADLE: &str = r#"
plugins { id 'java' }
java {
    sourceCompatibility = JavaVersion.VERSION_25
    targetCompatibility = JavaVersion.VERSION_25
}
frc {
    jvmArgs.addAll([
        "--add-opens", "java.base/jdk.internal.vm=ALL-UNNAMED",
        "--add-opens", "java.base/java.lang=ALL-UNNAMED",
    ])
}
"#;

const GRADLE_9: &str =
    "distributionUrl=https\\://services.gradle.org/distributions/gradle-9.7.1-bin.zip\n";
const GRADLE_8: &str =
    "distributionUrl=https\\://services.gradle.org/distributions/gradle-8.11-bin.zip\n";

fn find<'a>(d: &'a Diagnosis, what: &str) -> &'a Finding {
    d.findings
        .iter()
        .find(|f| f.what.contains(what))
        .unwrap_or_else(|| panic!("no finding about {what}"))
}

// --- the verdict ------------------------------------------------------------

#[test]
fn a_correct_project_is_ready() {
    let d = Project::healthy("ok").diagnose();
    assert!(d.ready, "{}", d.summary);
    assert_eq!(d.summary, "Ready");
}

#[test]
fn the_summary_names_the_first_thing_to_fix() {
    // Not a count. "3 problems" says how bad it is; it does not say what to do.
    let d = Project::healthy("named")
        .file("build.gradle", "plugins { id 'java' }")
        .diagnose();

    assert!(!d.ready);
    assert!(d.summary.starts_with("Not ready: "), "{}", d.summary);
    assert!(d.summary.len() > "Not ready: ".len());
}

#[test]
fn the_worst_finding_is_first() {
    let d = Project::healthy("order")
        .file("build.gradle", "plugins { id 'java' }")
        .diagnose();
    assert!(matches!(d.findings[0].level, Level::Blocker));
}

// --- the flags, which is what this module is worth writing for --------------

#[test]
fn both_flags_missing_is_a_blocker() {
    let d = Project::healthy("noflags")
        .file("build.gradle", "java { sourceCompatibility = JavaVersion.VERSION_25 }")
        .diagnose();

    assert!(matches!(find(&d, "JVM flags").level, Level::Blocker));
}

#[test]
fn one_flag_present_is_still_a_blocker() {
    // The case that catches people. A team that finds the first flag deploys believing they are
    // done and meets the second on the field, so half-done has to read as not done.
    let half = concat!(
        "java { sourceCompatibility = JavaVersion.VERSION_25 }\n",
        "frc { jvmArgs.addAll([\"--add-opens\", \"java.base/jdk.internal.vm=ALL-UNNAMED\"]) }\n"
    );
    let d = Project::healthy("halfflags").file("build.gradle", half).diagnose();

    let f = find(&d, "JVM flags");
    assert!(matches!(f.level, Level::Blocker));
    assert!(
        f.detail.contains("java.lang"),
        "it should name the one that is missing: {}",
        f.detail
    );
}

#[test]
fn the_fix_is_something_you_can_paste() {
    let d = Project::healthy("paste")
        .file("build.gradle", "plugins { id 'java' }")
        .diagnose();
    let f = find(&d, "JVM flags");

    assert!(f.fix.contains("jdk.internal.vm"));
    assert!(
        f.fix.contains("java.lang"),
        "both flags, or pasting the fix leaves it half-fixed"
    );
}

// --- toolchain --------------------------------------------------------------

#[test]
fn an_old_java_is_a_blocker_and_names_the_error_you_will_see() {
    let d = Project::healthy("java17")
        .file("build.gradle", "java { sourceCompatibility = JavaVersion.VERSION_17 }")
        .diagnose();

    let f = find(&d, "Java 25");
    assert!(matches!(f.level, Level::Blocker));
    assert!(
        f.detail.contains("major version 69"),
        "the error a team actually sees should be in the text: {}",
        f.detail
    );
}

#[test]
fn gradle_8_is_a_blocker() {
    let d = Project::healthy("gradle8")
        .file("gradle/wrapper/gradle-wrapper.properties", GRADLE_8)
        .diagnose();

    assert!(matches!(find(&d, "Gradle").level, Level::Blocker));
}

#[test]
fn gradle_9_is_fine() {
    let d = Project::healthy("gradle9").diagnose();
    assert!(matches!(find(&d, "Gradle").level, Level::Ok));
}

// --- vendordeps -------------------------------------------------------------

#[test]
fn photonvision_is_flagged() {
    let d = Project::healthy("photon")
        .file("vendordeps/photonlib.json", "{}")
        .diagnose();
    assert!(matches!(find(&d, "PhotonVision").level, Level::Warn));
}

#[test]
fn a_missing_vendordep_warns_rather_than_blocks() {
    // The project still builds; it just will not have the library in it. Blocking would make the
    // Doctor call a project broken when it is one click from being right.
    let p = Project::new("nodeps")
        .file("build.gradle", GOOD_GRADLE)
        .file("gradle/wrapper/gradle-wrapper.properties", GRADLE_9);
    let d = p.diagnose();

    assert!(matches!(find(&d, "Catalyst vendordep").level, Level::Warn));
    assert!(d.ready, "a missing vendordep is not a reason to call the project broken");
}

// --- the migration scan -----------------------------------------------------

#[test]
fn renamed_decorators_are_found_with_their_replacement() {
    let p = Project::healthy("migrate").file(
        "src/main/java/frc/robot/Robot.java",
        "public class Robot {\n  void go() {\n    arm.raise().until(this::done).withTimeout(2.0);\n  }\n}\n",
    );
    let usages = p.scan();

    assert_eq!(usages.len(), 2, "both are on the same line");
    assert!(usages.iter().any(|u| u.old_name == "until" && u.new_name == "untilTrue"));
    assert!(usages.iter().any(|u| u.old_name == "withTimeout" && u.new_name == "timeoutAfter"));
    assert_eq!(usages[0].line, 3);
}

#[test]
fn a_comment_mentioning_the_old_name_is_not_a_call_site() {
    // Javadoc explaining the rename would otherwise appear as work to do, in every file that
    // documents it.
    let p = Project::healthy("comments").file(
        "src/main/java/frc/robot/Robot.java",
        "public class Robot {\n  // until( was renamed to untilTrue(\n  * .andThen( is now .then(\n}\n",
    );
    assert!(p.scan().is_empty(), "{:?}", p.scan().len());
}

#[test]
fn the_path_reads_like_something_to_open() {
    let p = Project::healthy("paths").file(
        "src/main/java/frc/robot/Arm.java",
        "class Arm { void f() { c.alongWith(d); } }\n",
    );
    let usages = p.scan();

    assert_eq!(usages.len(), 1);
    assert_eq!(
        usages[0].file, "src/main/java/frc/robot/Arm.java",
        "relative, forward slashes, so it pastes into an editor"
    );
}

#[test]
fn a_removed_api_reports_no_replacement() {
    let p = Project::healthy("removed").file(
        "src/main/java/frc/robot/Arm.java",
        "class Arm { void f() { b.positionConversionFactor(0.5); } }\n",
    );
    let usages = p.scan();

    assert_eq!(usages.len(), 1);
    assert!(usages[0].new_name.is_empty(), "there is nothing to rename it to");
    assert!(usages[0].why.contains("never did anything"));
}

#[test]
fn a_clean_project_scans_clean() {
    let p = Project::healthy("clean").file(
        "src/main/java/frc/robot/Robot.java",
        "class Robot { void f() { arm.raise().untilTrue(this::done).timeoutAfter(2.0); } }\n",
    );
    assert!(p.scan().is_empty());
}

#[test]
fn a_project_with_no_source_does_not_fail() {
    assert!(Project::healthy("empty").scan().is_empty());
}


// --- commented-out settings are not settings --------------------------------

#[test]
fn commented_out_flags_are_still_a_blocker() {
    // The case the whole check exists for, and the one it originally got wrong.
    //
    // The flags are most often met commented out: the Catalyst example ships them that way with an
    // explanation, because that project deliberately is not a GradleRIO project. A team that copies
    // it and forgets to uncomment has a build.gradle containing both flag strings and applying
    // neither - and a naive text search calls that green, on exactly the project it was written to
    // catch.
    let commented = concat!(
        "java { sourceCompatibility = JavaVersion.VERSION_25 }
",
        "// frc {
",
        "//     jvmArgs.addAll([
",
        "//         \"--add-opens\", \"java.base/jdk.internal.vm=ALL-UNNAMED\",
",
        "//         \"--add-opens\", \"java.base/java.lang=ALL-UNNAMED\",
",
        "//     ])
",
        "// }
"
    );
    let d = Project::healthy("commentedflags").file("build.gradle", commented).diagnose();

    assert!(
        matches!(find(&d, "JVM flags").level, Level::Blocker),
        "both flag strings are present but only inside comments"
    );
}

#[test]
fn a_block_comment_does_not_count_either() {
    let blocked = concat!(
        "java { sourceCompatibility = JavaVersion.VERSION_25 }
",
        "/* frc { jvmArgs.addAll([\"--add-opens\", \"java.base/jdk.internal.vm=ALL-UNNAMED\",
",
        "   \"--add-opens\", \"java.base/java.lang=ALL-UNNAMED\"]) } */
"
    );
    let d = Project::healthy("blockcomment").file("build.gradle", blocked).diagnose();
    assert!(matches!(find(&d, "JVM flags").level, Level::Blocker));
}

#[test]
fn a_url_containing_a_double_slash_does_not_truncate_the_line() {
    // Comment stripping has to know it is inside a string, or every `maven { url "https://..." }`
    // loses the rest of its line and takes any setting after it with it.
    let with_urls = format!(
        "repositories {{ maven {{ url \"https://frcmaven.wpi.edu/artifactory/development/\" }} }}
{}",
        GOOD_GRADLE
    );
    let d = Project::healthy("urls").file("build.gradle", &with_urls).diagnose();

    assert!(matches!(find(&d, "JVM flags").level, Level::Ok));
    assert!(matches!(find(&d, "Java 25").level, Level::Ok));
    assert!(d.ready, "{}", d.summary);
}

#[test]
fn a_commented_out_old_java_is_not_read_as_the_java_version() {
    let d = Project::healthy("commentedjava")
        .file(
            "build.gradle",
            "// was: sourceCompatibility = JavaVersion.VERSION_17
java { sourceCompatibility = JavaVersion.VERSION_25 }
",
        )
        .diagnose();

    assert!(matches!(find(&d, "Java 25").level, Level::Ok), "the live setting is 25");
}

// --- against the real thing --------------------------------------------------

#[test]
fn the_shipped_example_is_on_the_2027_toolchain() {
    // Not a fixture. This is the project teams copy, so anything the Doctor would tell them about it
    // is something we should have fixed first.
    //
    // The flags are deliberately not asserted here: the example is a plain java project, not a
    // GradleRIO one, because GradleRIO 2027 ships only inside the WPILib installer. Its build.gradle
    // documents that and carries the flags commented out, ready to paste back.
    // Which checkout, though. This app ships the 2.0 line, whose example targets Java 25 and
    // WPILib 2027; the 1.x checkout beside it carries a 2026 example on Java 17. The path used to be
    // hard-coded at the 1.x one, so this test failed while everything was correct — a failure nobody
    // can act on, against a project this app does not ship. Only the 2027 line is checked, and when
    // it is not on the machine the test says nothing rather than something wrong.
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..");
    let example = [
        dev.join("_worktrees/FrcCatalyst-systemcore/example"),
        dev.join("FrcCatalyst/example"),
    ]
    .into_iter()
    .find(|p| p.join("build.gradle").exists());

    let Some(example) = example else {
        return; // the 2027 library is not checked out beside this repo
    };
    let d = diagnose_project(example.to_string_lossy().to_string());

    assert!(
        matches!(find(&d, "Java 25").level, Level::Ok),
        "the example must target Java 25: {}",
        find(&d, "Java 25").detail
    );
    assert!(
        matches!(find(&d, "Gradle").level, Level::Ok),
        "a team copying the example inherits its wrapper: {}",
        find(&d, "Gradle").detail
    );
}
