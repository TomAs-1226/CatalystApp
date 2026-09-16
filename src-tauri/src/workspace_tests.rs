//! The workspace, against the folders and paths that make a naive version wrong.
//!
//! Two of these are load-bearing. The ignore list is what keeps a Gradle project's file tree from
//! walking `build/` and hanging the window, and [`allowed_write`] is the boundary that decides
//! whether the editor can write a file at all. Both are cheap to get subtly wrong in a way no manual
//! test would notice, because the wrong version works perfectly on the machine it was written on.

use super::*;
use std::fs;
use std::path::PathBuf;

/// A scratch directory, removed when the test ends.
struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("catalyst-workspace-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        Scratch(dir)
    }

    fn file(self, rel: &str, contents: &str) -> Self {
        let path = self.0.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents).unwrap();
        self
    }

    fn bytes(self, rel: &str, contents: &[u8]) -> Self {
        let path = self.0.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents).unwrap();
        self
    }

    fn dir(self, rel: &str) -> Self {
        fs::create_dir_all(self.0.join(rel)).unwrap();
        self
    }

    fn at(&self, rel: &str) -> String {
        self.0.join(rel).to_string_lossy().to_string()
    }

    fn tree(&self, depth: u32) -> Vec<Node> {
        ws_tree(self.0.to_string_lossy().to_string(), depth).unwrap()
    }

    fn search(&self, query: &str, max: u32) -> Vec<Hit> {
        ws_search(self.0.to_string_lossy().to_string(), query.into(), max).unwrap()
    }

    fn files(&self, max: u32) -> Vec<String> {
        ws_files(self.0.to_string_lossy().to_string(), max).unwrap()
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// A project root written the way this platform writes one, so the same tests exercise real
/// separators on Windows without being unrunnable anywhere else.
fn root(name: &str) -> String {
    if cfg!(windows) {
        format!(r"C:\dev\{name}")
    } else {
        format!("/dev/{name}")
    }
}

fn named<'a>(nodes: &'a [Node], name: &str) -> &'a Node {
    nodes
        .iter()
        .find(|n| n.name == name)
        .unwrap_or_else(|| panic!("no node called {name} in {:?}", nodes.iter().map(|n| &n.name).collect::<Vec<_>>()))
}

// --- what is never walked ----------------------------------------------------

#[test]
fn the_ignore_list_is_every_folder_that_makes_a_tree_hang() {
    for name in IGNORED {
        assert!(ignored(name), "{name} should be skipped");
    }
    assert_eq!(IGNORED.len(), 9);
}

#[test]
fn an_ignored_folder_is_ignored_whatever_its_case() {
    // Windows treats `Build` and `build` as one folder. A case-sensitive check would walk the
    // Gradle output of any project whose template capitalised it.
    assert!(ignored("Build"));
    assert!(ignored(".GIT"));
    assert!(ignored("Node_Modules"));
}

#[test]
fn a_folder_that_only_starts_with_an_ignored_name_is_kept() {
    // `buildSrc` holds hand-written Gradle code. Matching on a prefix would hide it.
    assert!(!ignored("buildSrc"));
    assert!(!ignored("targets"));
    assert!(!ignored("binary"));
}

#[test]
fn the_tree_never_shows_the_folders_it_must_not_walk() {
    let s = Scratch::new("ignored")
        .file("build.gradle", "")
        .file("build/classes/Robot.class", "")
        .file(".git/HEAD", "")
        .file("src/main/java/frc/robot/Robot.java", "");

    let tree = s.tree(4);
    let names: Vec<&str> = tree.iter().map(|n| n.name.as_str()).collect();
    assert!(names.contains(&"src"), "{names:?}");
    assert!(!names.contains(&"build"), "{names:?}");
    assert!(!names.contains(&".git"), "{names:?}");
}

// --- the tree ----------------------------------------------------------------

#[test]
fn one_level_leaves_the_folders_unread() {
    // The tree opens folders as you click them. `None` is how it tells "not read yet" from "empty",
    // and getting that wrong shows every folder in the project as a leaf.
    let s = Scratch::new("lazy").file("src/main/java/Robot.java", "").file("build.gradle", "");
    let level = s.tree(1);

    assert!(named(&level, "src").children.is_none());
    assert!(named(&level, "build.gradle").children.is_none());
}

#[test]
fn a_deeper_walk_reads_the_folders_it_passes() {
    let s = Scratch::new("deep").file("src/main/Robot.java", "");
    let level = s.tree(2);

    let src = named(&level, "src");
    let children = src.children.as_ref().expect("src should be read at depth 2");
    assert_eq!(children.len(), 1);
    assert_eq!(children[0].name, "main");
    assert!(children[0].children.is_none(), "depth 2 stops here");
}

#[test]
fn an_empty_folder_reads_as_empty_not_as_unread() {
    let s = Scratch::new("empty-folder").dir("vendordeps");
    let level = s.tree(2);
    assert_eq!(named(&level, "vendordeps").children.as_ref().map(Vec::len), Some(0));
}

#[test]
fn folders_come_before_files_and_case_does_not_reorder_them() {
    let s = Scratch::new("order")
        .file("README.md", "")
        .file("build.gradle", "")
        .dir("vendordeps")
        .dir("Docs");

    let names: Vec<String> = s.tree(1).into_iter().map(|n| n.name).collect();
    assert_eq!(names, vec!["Docs", "vendordeps", "build.gradle", "README.md"]);
}

#[test]
fn a_tree_of_something_that_is_not_a_folder_says_so() {
    let s = Scratch::new("not-a-folder").file("build.gradle", "");
    let err = ws_tree(s.at("build.gradle"), 1).unwrap_err();
    assert!(err.contains("not a folder"), "{err}");
}

// --- reading -----------------------------------------------------------------

#[test]
fn the_language_is_the_monaco_id_for_the_extension() {
    assert_eq!(language_for("Robot.java"), "java");
    assert_eq!(language_for("Robot.kt"), "kotlin");
    assert_eq!(language_for("FrcCatalyst.json"), "json");
    assert_eq!(language_for("README.md"), "markdown");
    assert_eq!(language_for("pom.xml"), "xml");
    assert_eq!(language_for("tool.py"), "python");
    assert_eq!(language_for("app.js"), "javascript");
    assert_eq!(language_for("app.ts"), "typescript");
    assert_eq!(language_for("Cargo.toml"), "toml");
    assert_eq!(language_for("gradle.properties"), "ini");
}

#[test]
fn a_gradle_script_is_groovy_and_its_kotlin_dsl_is_kotlin() {
    // Monaco has no `gradle`. Asking for one leaves the build script with no highlighting at all,
    // which is the file a robot project is edited in most often.
    assert_eq!(language_for(r"C:\dev\Robot\build.gradle"), "groovy");
    assert_eq!(language_for(r"C:\dev\Robot\build.gradle.kts"), "kotlin");
}

#[test]
fn an_extension_in_capitals_is_the_same_extension() {
    assert_eq!(language_for("Robot.JAVA"), "java");
    assert_eq!(language_for("BUILD.GRADLE"), "groovy");
}

#[test]
fn anything_unrecognised_opens_as_plain_text() {
    assert_eq!(language_for("LICENSE"), "plaintext");
    assert_eq!(language_for("robot.wpilog"), "plaintext");
    assert_eq!(language_for(r"C:\dev\Robot\.gitignore"), "plaintext");
}

#[test]
fn reading_a_file_returns_its_text_and_its_language() {
    let s = Scratch::new("read").file("src/Robot.java", "class Robot {}\n");
    let f = ws_read(s.at("src/Robot.java")).unwrap();

    assert_eq!(f.text, "class Robot {}\n");
    assert_eq!(f.language, "java");
}

#[test]
fn a_file_that_is_not_text_is_refused_rather_than_mangled() {
    // Opening a class file lossily would fill the editor with replacement characters, and saving it
    // back would write those characters over the real bytes.
    let s = Scratch::new("binary").bytes("Robot.class", &[0xCA, 0xFE, 0xBA, 0xBE, 0xFF]);
    let err = ws_read(s.at("Robot.class")).unwrap_err();
    assert!(err.contains("not UTF-8"), "{err}");
}

#[test]
fn a_file_over_two_mebibytes_is_refused_by_size() {
    let s = Scratch::new("huge").file("big.json", &"a".repeat(MAX_READ as usize + 1));
    let err = ws_read(s.at("big.json")).unwrap_err();
    assert!(err.contains("2 MiB"), "{err}");
    assert!(err.contains("2.0 MiB"), "the message should say how big it actually is: {err}");
}

#[test]
fn a_size_is_reported_in_units_a_person_reads() {
    assert_eq!(size_words(4096), "4 KiB");
    assert_eq!(size_words(3 * 1024 * 1024 + 512 * 1024), "3.5 MiB");
}

// --- the write boundary ------------------------------------------------------

#[test]
fn a_file_inside_a_registered_project_may_be_written() {
    let roots = vec![root("Robot")];
    let inside = PathBuf::from(root("Robot")).join("src/main/java/frc/robot/Robot.java");
    assert!(allowed_write(&inside, &roots));
}

#[test]
fn a_file_at_the_top_of_a_registered_project_may_be_written() {
    let roots = vec![root("Robot")];
    assert!(allowed_write(&PathBuf::from(root("Robot")).join("build.gradle"), &roots));
}

#[test]
fn a_sibling_that_merely_shares_a_prefix_is_a_different_project() {
    // `C:\dev\Robot2` starts with `C:\dev\Robot`. A `starts_with` on the text of the path says yes,
    // and the editor writes into a project nobody registered.
    let roots = vec![root("Robot")];
    let sibling = PathBuf::from(root("Robot2")).join("src/Secret.java");
    assert!(!allowed_write(&sibling, &roots));
}

#[test]
fn climbing_out_with_dot_dot_does_not_get_back_in() {
    let roots = vec![root("Robot")];
    let escaped = PathBuf::from(root("Robot")).join("..").join("Robot2").join("Secret.java");
    assert!(!allowed_write(&escaped, &roots));

    let far = PathBuf::from(root("Robot")).join("../../../Windows/System32/drivers/etc/hosts");
    assert!(!allowed_write(&far, &roots));
}

#[test]
fn dot_dot_that_stays_inside_is_still_inside() {
    // Refusing every path containing `..` would be simpler and wrong: the frontend joins paths, and
    // `src/../build.gradle` is a file in the project.
    let roots = vec![root("Robot")];
    let inside = PathBuf::from(root("Robot")).join("src").join("..").join("build.gradle");
    assert!(allowed_write(&inside, &roots));
}

#[test]
fn the_project_folder_itself_is_not_a_file_to_write() {
    let roots = vec![root("Robot")];
    assert!(!allowed_write(Path::new(&root("Robot")), &roots));
}

#[test]
fn nothing_may_be_written_when_nothing_is_registered() {
    let inside = PathBuf::from(root("Robot")).join("build.gradle");
    assert!(!allowed_write(&inside, &[]));
}

#[test]
fn a_relative_path_is_refused_because_it_belongs_to_no_project() {
    // Whatever the process's working directory happens to be is not a permission.
    assert!(!allowed_write(Path::new("build.gradle"), &[root("Robot")]));
    assert!(!allowed_write(Path::new("../../evil.txt"), &[root("Robot")]));
}

#[test]
fn one_of_several_registered_projects_is_enough() {
    let roots = vec![root("Old"), root("Robot"), root("Library")];
    assert!(allowed_write(&PathBuf::from(root("Library")).join("build.gradle"), &roots));
    assert!(!allowed_write(&PathBuf::from(root("Elsewhere")).join("build.gradle"), &roots));
}

#[cfg(windows)]
#[test]
fn on_windows_the_same_folder_spelled_differently_is_the_same_folder() {
    // The registry stores whatever `canonicalize` gave it, and the frontend passes back whatever the
    // tree showed. A case-sensitive comparison refuses writes to the project the user imported.
    let roots = vec![r"C:\dev\Robot".to_string()];
    assert!(allowed_write(Path::new(r"c:\DEV\robot\build.gradle"), &roots));
    assert!(allowed_write(Path::new(r"C:\dev\Robot\SRC\Main.java"), &roots));
}

#[cfg(windows)]
#[test]
fn on_windows_a_forward_slash_is_still_a_separator() {
    // Monaco and the tree both hand back paths with forward slashes in them.
    let roots = vec![r"C:\dev\Robot".to_string()];
    assert!(allowed_write(Path::new("C:/dev/Robot/src/Robot.java"), &roots));
    assert!(!allowed_write(Path::new("C:/dev/Robot2/src/Robot.java"), &roots));
}

// --- search ------------------------------------------------------------------

#[test]
fn search_ignores_case_and_counts_lines_from_one() {
    let text = "package frc.robot;\nclass Robot {}\n  // ROBOT again\n";
    let hits = hits_in_text(text, "robot", 10);

    assert_eq!(hits.len(), 3);
    assert_eq!(hits[0], (1, "package frc.robot;".to_string()));
    assert_eq!(hits[1].0, 2);
    assert_eq!(hits[2], (3, "// ROBOT again".to_string()));
}

#[test]
fn a_query_is_literal_not_a_pattern() {
    // People search for `setDefaultCommand(` and for `.`. Either would be a different search as a
    // regex, and one of them matches every line in the file.
    let hits = hits_in_text("a.b\naxb\n", ".", 10);
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].0, 1);
}

#[test]
fn search_stops_at_the_limit_it_was_given() {
    let text = "x\n".repeat(100);
    assert_eq!(hits_in_text(&text, "x", 5).len(), 5);
    assert!(hits_in_text(&text, "x", 0).is_empty());
}

#[test]
fn a_very_long_line_comes_back_cut_rather_than_whole() {
    let text = format!("  {}needle{}\n", "a".repeat(500), "b".repeat(500));
    let hits = hits_in_text(&text, "needle", 1);
    assert_eq!(hits[0].1.chars().count(), HIT_WIDTH + 1, "cut, with the ellipsis");
}

#[test]
fn searching_a_project_skips_the_folders_the_tree_skips() {
    let s = Scratch::new("search")
        .file("src/Robot.java", "class Robot {}\n")
        .file("build/generated/Robot.java", "class Robot {}\n")
        .file(".git/COMMIT_EDITMSG", "Robot\n");

    let hits = s.search("robot", 50);
    let found: Vec<&String> = hits.iter().map(|h| &h.path).collect();
    assert_eq!(hits.len(), 1, "{found:?}");
    assert!(hits[0].path.ends_with("Robot.java"));
    assert_eq!(hits[0].line, 1);
}

#[test]
fn an_empty_query_is_refused_rather_than_matching_everything() {
    let s = Scratch::new("empty-query").file("src/Robot.java", "class Robot {}\n");
    assert!(ws_search(s.0.to_string_lossy().to_string(), "   ".into(), 10).is_err());
}

// --- every file, for quick open ----------------------------------------------

#[test]
fn a_quick_open_list_skips_the_folders_the_tree_skips() {
    let s = Scratch::new("files-ignored")
        .file("src/main/java/frc/robot/Robot.java", "class Robot {}")
        .file("build.gradle", "plugins {}")
        .file("build/classes/Robot.class", "compiled")
        .file(".git/HEAD", "ref: refs/heads/main");

    let files = s.files(100);

    assert!(files.iter().any(|p| p.ends_with("Robot.java")), "the source is listed: {files:?}");
    assert!(files.iter().any(|p| p.ends_with("build.gradle")), "so is the build script");
    assert!(!files.iter().any(|p| p.contains("classes")), "build output is not: {files:?}");
    assert!(!files.iter().any(|p| p.contains(".git")), "nor is git's own store: {files:?}");
}

#[test]
fn the_quick_open_list_stops_where_it_is_told_to() {
    let mut s = Scratch::new("files-cap");
    for n in 0..20 {
        s = s.file(&format!("src/File{n}.java"), "x");
    }

    assert_eq!(s.files(5).len(), 5);
    // A cap of zero would be a list nobody can use, so it is read as one rather than as none.
    assert_eq!(s.files(0).len(), 1);
}

#[test]
fn a_quick_open_list_of_something_that_is_not_a_folder_is_an_error() {
    let s = Scratch::new("files-not-a-folder").file("build.gradle", "plugins {}");
    assert!(ws_files(s.at("build.gradle"), 10).is_err());
}
