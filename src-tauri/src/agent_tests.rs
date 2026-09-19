//! Preparing a project, against the files it is not allowed to damage.
//!
//! `.mcp.json` and `CLAUDE.md` belong to the user. The two failures worth testing with real files on
//! disk are the destructive ones: dropping a server someone else configured, and replacing
//! instructions someone wrote. Neither shows up in a test that only checks the happy path, because
//! on an empty project both versions behave identically.

use super::*;
use std::fs;
use std::path::PathBuf;

struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("catalyst-agent-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        Scratch(dir)
    }

    fn file(self, rel: &str, contents: &str) -> Self {
        fs::write(self.0.join(rel), contents).unwrap();
        self
    }

    fn read(&self, rel: &str) -> String {
        fs::read_to_string(self.0.join(rel)).unwrap()
    }

    fn json(&self, rel: &str) -> serde_json::Value {
        serde_json::from_str(&self.read(rel)).expect("what we wrote should be JSON")
    }

    fn prepare(&self) -> Result<(), String> {
        write_agent_files(&self.0, SERVER)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

const SERVER: &str = r"C:\Program Files\Catalyst\resources\mcp\server.js";

/// A `.mcp.json` a team already had, with a server this app knows nothing about.
const THEIRS: &str = r#"{
  "mcpServers": {
    "playwright": { "command": "npx", "args": ["-y", "@playwright/mcp@latest"] }
  }
}"#;

// --- .mcp.json ---------------------------------------------------------------

#[test]
fn a_project_with_no_mcp_json_gets_one_that_wires_catalyst() {
    let s = Scratch::new("fresh-mcp");
    s.prepare().unwrap();

    assert!(mcp_wired(&s.read(".mcp.json")));
    let doc = s.json(".mcp.json");
    assert_eq!(doc["mcpServers"]["catalyst"]["command"], "node");
    assert_eq!(doc["mcpServers"]["catalyst"]["args"][0], SERVER);
}

#[test]
fn another_teams_server_survives_being_wired_for_catalyst() {
    // The whole reason this merges rather than writes: replacing the file would take their server
    // away, and nothing would say so until the next time they needed it.
    let s = Scratch::new("merge").file(".mcp.json", THEIRS);
    s.prepare().unwrap();

    let doc = s.json(".mcp.json");
    assert_eq!(doc["mcpServers"]["playwright"]["command"], "npx");
    assert_eq!(doc["mcpServers"]["playwright"]["args"][1], "@playwright/mcp@latest");
    assert_eq!(doc["mcpServers"]["catalyst"]["command"], "node");
}

#[test]
fn everything_outside_mcp_servers_is_kept_too() {
    let s = Scratch::new("other-keys").file(
        ".mcp.json",
        r#"{ "note": "keep me", "mcpServers": { "playwright": { "command": "npx" } } }"#,
    );
    s.prepare().unwrap();

    assert_eq!(s.json(".mcp.json")["note"], "keep me");
}

#[test]
fn preparing_twice_leaves_one_catalyst_entry_and_changes_nothing_else() {
    let s = Scratch::new("twice").file(".mcp.json", THEIRS);
    s.prepare().unwrap();
    let once = s.read(".mcp.json");
    s.prepare().unwrap();

    assert_eq!(s.read(".mcp.json"), once, "a second prepare should be a no-op");
    let servers = s.json(".mcp.json")["mcpServers"].as_object().unwrap().len();
    assert_eq!(servers, 2);
}

#[test]
fn an_mcp_json_that_cannot_be_read_is_an_error_not_an_overwrite() {
    // Half-written by an interrupted edit. Replacing it is the one thing that cannot be undone, so
    // the file is left exactly as it is and the user is told to look at it.
    let broken = "{ \"mcpServers\": { ";
    let s = Scratch::new("broken-mcp").file(".mcp.json", broken);

    let err = s.prepare().unwrap_err();
    assert!(err.contains("not valid JSON"), "{err}");
    assert_eq!(s.read(".mcp.json"), broken, "the file must be untouched");
}

#[test]
fn an_mcp_json_that_is_not_an_object_is_refused_by_name() {
    let s = Scratch::new("array-mcp").file(".mcp.json", "[]");
    let err = s.prepare().unwrap_err();
    assert!(err.contains("JSON object"), "{err}");
}

#[test]
fn an_empty_mcp_json_is_treated_as_no_file_at_all() {
    // An empty file is what a failed write leaves behind, and there is nothing in it to preserve.
    let s = Scratch::new("empty-mcp").file(".mcp.json", "\n  \n");
    s.prepare().unwrap();
    assert!(mcp_wired(&s.read(".mcp.json")));
}

#[test]
fn merging_needs_no_file_on_disk_at_all() {
    let merged = merged_mcp(None, SERVER).unwrap();
    assert!(mcp_wired(&merged));
    assert!(merged.ends_with('\n'), "a text file ends in a newline");
}

// --- CLAUDE.md ---------------------------------------------------------------

#[test]
fn a_project_with_no_claude_md_gets_one() {
    let s = Scratch::new("fresh-guide");
    s.prepare().unwrap();

    let guide = s.read("CLAUDE.md");
    assert!(guide.contains("catalyst"), "it should point at the MCP server: {guide}");
    assert!(guide.contains("devtools gradle -- build"), "it should say how to build");
    assert!(guide.contains("Never push"), "it should say what not to do");
}

#[test]
fn an_existing_claude_md_is_left_exactly_as_it_was() {
    // Someone's own instructions for their own project. Overwriting them would change how every
    // future session behaves in that project, silently.
    let theirs = "# Robot2027\n\nAsk Cameron before touching the shooter constants.\n";
    let s = Scratch::new("their-guide").file("CLAUDE.md", theirs);

    s.prepare().unwrap();
    assert_eq!(s.read("CLAUDE.md"), theirs);
}

#[test]
fn an_existing_claude_md_does_not_stop_the_mcp_wiring() {
    let s = Scratch::new("guide-but-no-mcp").file("CLAUDE.md", "# mine\n");
    s.prepare().unwrap();
    assert!(mcp_wired(&s.read(".mcp.json")));
}

#[test]
fn the_guide_is_named_after_the_project_folder() {
    let s = Scratch::new("named-project");
    s.prepare().unwrap();
    assert!(s.read("CLAUDE.md").starts_with("# catalyst-agent-named-project"));
}

// --- reading the state back --------------------------------------------------

#[test]
fn a_project_with_no_mcp_json_is_not_wired() {
    assert!(!mcp_wired(""));
}

#[test]
fn a_file_with_other_servers_but_not_ours_is_not_wired() {
    assert!(!mcp_wired(THEIRS));
}

#[test]
fn an_entry_with_no_server_path_is_not_a_wiring() {
    // A `catalyst` key with nothing behind it would otherwise show a green tick above a session
    // that cannot see the library.
    assert!(!mcp_wired(r#"{"mcpServers":{"catalyst":{"command":"node"}}}"#));
    assert!(!mcp_wired(r#"{"mcpServers":{"catalyst":{"command":"","args":["x"]}}}"#));
    assert!(!mcp_wired(r#"{"mcpServers":{"catalyst":{"command":"node","args":[]}}}"#));
}

#[test]
fn unreadable_json_reports_not_wired_rather_than_panicking() {
    assert!(!mcp_wired("{ this is not json"));
}

// --- the CLI version ---------------------------------------------------------

#[test]
fn a_version_is_digits_and_dots() {
    assert!(looks_like_version("2.1.271"));
    assert!(looks_like_version("2.1"));
    assert!(!looks_like_version("latest"));
    assert!(!looks_like_version("2"));
    assert!(!looks_like_version("2..1"));
    assert!(!looks_like_version("v2.1.271"), "the installer's folders carry no v");
}

#[test]
fn the_installer_path_already_says_which_version_it_is() {
    // Cheaper than starting the CLI, and this is read every time the agent pane opens.
    let exe = r"C:\Users\yu_th\AppData\Roaming\Claude\claude-code\2.1.271\claude.exe";
    assert_eq!(version_from_path(exe).as_deref(), Some("2.1.271"));
}

#[test]
fn a_claude_somewhere_else_has_no_version_in_its_path() {
    assert!(version_from_path(r"C:\shims\claude.cmd").is_none());
    assert!(version_from_path("/usr/local/bin/claude").is_none());
}

#[test]
fn the_version_is_picked_out_of_whatever_the_cli_printed() {
    assert_eq!(version_from_output("2.1.271 (Claude Code)\n").as_deref(), Some("2.1.271"));
    assert_eq!(version_from_output("Claude Code 2.1.9\n").as_deref(), Some("2.1.9"));
    assert!(version_from_output("Not logged in\n").is_none());
}

// --- what the session is told ------------------------------------------------

#[test]
fn the_guide_points_at_the_work_history_rather_than_copying_it() {
    let body = claude_md_with("Robot2027", Some("C:/Users/x/.claude/projects/p/memory/MEMORY.md"));
    assert!(
        body.contains("@C:/Users/x/.claude/projects/p/memory/MEMORY.md"),
        "an @ import, so the file stays the one source: {body}"
    );
    assert!(body.contains("Delete this section"), "and the user is told how to opt out");
}

#[test]
fn a_machine_with_no_memory_index_gets_a_guide_without_that_section() {
    let body = claude_md_with("Robot2027", None);
    assert!(!body.contains("work history"), "no dangling section: {body}");
    assert!(!body.contains('@'), "and nothing that looks like a broken import");
    assert!(body.contains("catalyst_graph_build"), "the graph advice is not conditional");
}

#[test]
fn the_guide_names_the_graph_tools_an_agent_should_reach_for_first() {
    let body = claude_md_with("Robot2027", None);
    for tool in ["catalyst_graph_build", "catalyst_graph_search", "catalyst_graph_path"] {
        assert!(body.contains(tool), "{tool} is named: {body}");
    }
}

#[test]
fn on_a_machine_with_a_memory_index_the_guide_actually_points_at_it() {
    // Not a fixture: the point of the import is that it resolves on the machine the app runs on,
    // and a test that only ever sees a temp directory cannot tell whether it does. Where there is no
    // memory yet, there is nothing to assert and the test says so by passing quietly.
    let Some(index) = shared_memory_index() else { return };

    assert!(
        Path::new(&index).is_file(),
        "shared_memory_index returned a path that is not a file: {index}"
    );
    assert!(index.ends_with("MEMORY.md"), "it is the index, not a memory: {index}");

    let guide = claude_md("Robot2027");
    assert!(guide.contains(&format!("@{index}")), "the guide imports it: {guide}");
}
