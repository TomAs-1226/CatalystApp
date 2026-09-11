//! The door the app's tools use into a project refuses what the MCP server refuses. Each test builds
//! a registry in memory around a scratch folder, so nothing here reads or writes the user's real
//! registry.

use super::*;
use std::fs;
use std::path::PathBuf;

struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("catalyst-projects-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        Scratch(dir)
    }

    fn file(&self, rel: &str, body: &str) -> &Self {
        let p = self.0.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, body).unwrap();
        self
    }

    fn dir(&self) -> String {
        self.0.to_string_lossy().to_string()
    }

    fn read(&self, rel: &str) -> Option<String> {
        fs::read_to_string(self.0.join(rel)).ok()
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn registry(p: &Scratch, write: bool) -> Registry {
    Registry {
        projects: vec![Project {
            path: canonical(&p.dir()),
            name: "Robot".into(),
            catalyst_version: None,
            year: None,
            agent_write: write,
            added: 0,
            last_opened: 0,
            note: String::new(),
            analysis: Analysis::default(),
        }],
    }
}

const REL: &str = "src/main/java/frc/robot/DriverConfig.java";

#[test]
fn a_new_file_is_written_when_the_project_allows_writing() {
    let p = Scratch::new("new-file");
    let report = write_file_in(&registry(&p, true), &p.dir(), REL, "package frc.robot;\n", None, true).unwrap();
    assert!(report.created);
    assert_eq!(report.rel, REL);
    assert_eq!(report.project, "Robot");
    assert_eq!(p.read(REL).as_deref(), Some("package frc.robot;\n"));
}

#[test]
fn nothing_is_written_while_writing_is_off_and_the_error_says_where_to_turn_it_on() {
    let p = Scratch::new("write-off");
    let err = write_file_in(&registry(&p, false), &p.dir(), REL, "x", None, true).unwrap_err();
    assert!(err.contains("Writing is off"), "{err}");
    assert!(err.contains("Let agents write"), "{err}");
    assert!(p.read(REL).is_none());
}

#[test]
fn an_unregistered_folder_is_refused() {
    let registered_one = Scratch::new("registered");
    let other = Scratch::new("stranger");
    let err = write_file_in(&registry(&registered_one, true), &other.dir(), "a.java", "x", None, true).unwrap_err();
    assert!(err.contains("not a registered project"), "{err}");
    assert!(other.read("a.java").is_none());
}

#[test]
fn paths_that_climb_out_or_start_somewhere_else_are_refused() {
    let p = Scratch::new("escape");
    let reg = registry(&p, true);
    for rel in ["../outside.java", "src/../../outside.java", "/outside.java", ""] {
        assert!(write_file_in(&reg, &p.dir(), rel, "x", None, true).is_err(), "{rel:?} should be refused");
    }
    #[cfg(windows)]
    for rel in ["C:/Windows/outside.java", "C:outside.java", r"\\server\share\x.java"] {
        assert!(write_file_in(&reg, &p.dir(), rel, "x", None, true).is_err(), "{rel:?} should be refused");
    }
    assert!(!p.0.parent().unwrap().join("outside.java").exists());
}

#[test]
fn version_control_and_build_output_are_refused_even_when_writing_is_on() {
    let p = Scratch::new("protected");
    let reg = registry(&p, true);
    for rel in [".git/config", "build/Robot.java", "Build/Robot.java", "src/.gradle/x", "node_modules/a.js",
        "graphify-out/graph.json", "target/x.java", "src/main/java/frc/robot/build/X.java"] {
        let err = write_file_in(&reg, &p.dir(), rel, "x", None, true).unwrap_err();
        assert!(err.contains("build output or version control"), "{rel}: {err}");
        assert!(p.read(rel).is_none(), "{rel} was written");
    }
}

#[test]
fn a_file_changed_since_the_preview_is_not_overwritten() {
    let p = Scratch::new("changed");
    p.file(REL, "edited in VS Code");
    let reg = registry(&p, true);
    let err = write_file_in(&reg, &p.dir(), REL, "new", Some("what the preview showed"), false).unwrap_err();
    assert!(err.contains("changed since you previewed"), "{err}");
    assert_eq!(p.read(REL).as_deref(), Some("edited in VS Code"));

    let ok = write_file_in(&reg, &p.dir(), REL, "new", Some("edited in VS Code"), false).unwrap();
    assert!(!ok.created);
    assert_eq!(p.read(REL).as_deref(), Some("new"));
}

#[test]
fn a_file_that_appeared_since_the_preview_is_not_overwritten() {
    let p = Scratch::new("appeared");
    p.file(REL, "someone else's");
    let err = write_file_in(&registry(&p, true), &p.dir(), REL, "new", None, true).unwrap_err();
    assert!(err.contains("appeared since you previewed"), "{err}");
    assert_eq!(p.read(REL).as_deref(), Some("someone else's"));
}

#[test]
fn every_other_file_is_left_byte_for_byte_and_no_temporary_file_is_left_behind() {
    let p = Scratch::new("untouched");
    p.file("build.gradle", "plugins { id 'java' }\r\n");
    p.file("src/main/java/frc/robot/X1.java", "package frc.robot;\nclass X1 {}\n");
    write_file_in(&registry(&p, true), &p.dir(), REL, "generated", None, true).unwrap();
    assert_eq!(p.read("build.gradle").as_deref(), Some("plugins { id 'java' }\r\n"));
    assert_eq!(p.read("src/main/java/frc/robot/X1.java").as_deref(), Some("package frc.robot;\nclass X1 {}\n"));
    let leftovers: Vec<_> = fs::read_dir(p.0.join("src/main/java/frc/robot"))
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| n.contains("catalyst-tmp"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
}

#[test]
fn reading_needs_no_permission_but_obeys_the_same_paths() {
    let p = Scratch::new("read");
    p.file(REL, "hello");
    let reg = registry(&p, false);
    assert_eq!(read_file_in(&reg, &p.dir(), REL).unwrap().as_deref(), Some("hello"));
    assert_eq!(read_file_in(&reg, &p.dir(), "src/main/java/Missing.java").unwrap(), None);
    assert!(read_file_in(&reg, &p.dir(), "../secret.txt").is_err());
    assert!(read_file_in(&reg, &p.dir(), ".git/config").is_err());
}

#[test]
fn java_sources_come_from_src_main_java_only() {
    let p = Scratch::new("sources");
    p.file("src/main/java/frc/robot/A.java", "class A {}");
    p.file("src/main/java/frc/robot/notes.txt", "not java");
    p.file("src/main/java/frc/robot/build/B.java", "class B {}");
    p.file("src/test/java/frc/robot/C.java", "class C {}");
    let files = java_sources_in(&registry(&p, false), &p.dir()).unwrap();
    let paths: Vec<_> = files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(paths, vec!["src/main/java/frc/robot/A.java"]);
    assert_eq!(files[0].text, "class A {}");
}

#[cfg(unix)]
#[test]
fn a_link_that_points_out_of_the_project_is_refused() {
    let p = Scratch::new("link");
    let outside = Scratch::new("link-target");
    fs::create_dir_all(p.0.join("src")).unwrap();
    std::os::unix::fs::symlink(&outside.0, p.0.join("src/escape")).unwrap();
    let err = write_file_in(&registry(&p, true), &p.dir(), "src/escape/x.java", "x", None, true).unwrap_err();
    assert!(err.contains("outside the project"), "{err}");
    assert!(outside.read("x.java").is_none());
}
