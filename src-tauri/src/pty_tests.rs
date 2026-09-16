//! The decisions a terminal makes before there is a terminal.
//!
//! Everything here is a pure function on purpose. Opening a real ConPTY in a test would make the
//! suite depend on a console host, a Python install and a Claude Code build, and would still not
//! answer the questions that actually go wrong: when to flush, and which of three programs called
//! `claude` is the newest one.

use super::*;

// --- coalescing --------------------------------------------------------------

#[test]
fn nothing_buffered_is_never_worth_an_event() {
    // The pump wakes on a timer. Without this it would emit an empty string at every idle prompt,
    // sixty times a second, for as long as the app is open.
    assert!(!should_flush(0, Duration::from_secs(10)));
}

#[test]
fn a_frame_of_waiting_flushes_whatever_there_is() {
    assert!(!should_flush(1, Duration::from_millis(15)));
    assert!(should_flush(1, FLUSH_INTERVAL));
    assert!(should_flush(1, Duration::from_millis(17)));
}

#[test]
fn eight_kibibytes_does_not_wait_for_the_clock() {
    // A build log arrives faster than 8 KiB per frame. Holding it to the timer would turn one
    // `gradlew build` into a queue of events the window works through after the build has finished.
    assert!(!should_flush(FLUSH_BYTES - 1, Duration::ZERO));
    assert!(should_flush(FLUSH_BYTES, Duration::ZERO));
}

#[test]
fn an_idle_pump_blocks_for_longer_than_a_frame() {
    // Nothing buffered means nothing to flush, so waking at 60 Hz would only be to ask whether the
    // child has exited. A dozen open panes doing that is a core.
    assert_eq!(poll_wait(0, Duration::ZERO), IDLE_POLL);
    assert!(poll_wait(0, Duration::from_secs(1)) > FLUSH_INTERVAL);
}

#[test]
fn a_busy_pump_wakes_in_time_for_the_next_flush() {
    assert_eq!(poll_wait(10, Duration::ZERO), FLUSH_INTERVAL);
    assert_eq!(poll_wait(10, Duration::from_millis(10)), Duration::from_millis(6));
}

#[test]
fn a_late_pump_still_waits_a_moment() {
    // `recv_timeout(ZERO)` returns instantly, which would turn the pump into a spin loop the first
    // time the machine was busy enough to miss a frame.
    assert_eq!(poll_wait(10, Duration::from_secs(1)), Duration::from_millis(1));
}

// --- text out of a byte pipe -------------------------------------------------

#[test]
fn a_chunk_that_ends_mid_character_holds_the_tail_back() {
    // "é" is two bytes. A PTY read that stops between them, emitted lossily, puts a replacement
    // character in the terminal that nothing later can take out again.
    let mut bytes = "ab".as_bytes().to_vec();
    bytes.push(0xC3); // the first half of é
    assert_eq!(utf8_boundary(&bytes, false), 2);
}

#[test]
fn a_complete_chunk_goes_out_whole() {
    let bytes = "ab é ✓".as_bytes().to_vec();
    assert_eq!(utf8_boundary(&bytes, false), bytes.len());
}

#[test]
fn the_last_chunk_takes_the_broken_tail_with_it() {
    // At end of file there is no next chunk to complete it, so holding it back would silently drop
    // the byte instead of showing that something arrived.
    let bytes = vec![b'a', 0xC3];
    assert_eq!(utf8_boundary(&bytes, true), 2);
}

#[test]
fn a_byte_that_can_never_be_valid_is_not_waited_on() {
    // 0xFF starts no sequence at all. Treating it as "incomplete" would stall the pane until the
    // next byte arrived, which for a program that has stopped writing is forever.
    let bytes = vec![b'a', 0xFF, b'b'];
    assert_eq!(utf8_boundary(&bytes, false), bytes.len());
}

// --- the shell ---------------------------------------------------------------

#[test]
fn windows_gets_powershell_without_its_banner() {
    let c = Candidates { windows: true, ..Candidates::default() };
    assert_eq!(
        resolve_shell(&c),
        Program { program: "powershell.exe".into(), args: vec!["-NoLogo".into()] }
    );
}

#[test]
fn elsewhere_the_login_shell_is_whatever_shell_says() {
    let c = Candidates { windows: false, shell: Some("/usr/bin/zsh".into()), ..Candidates::default() };
    assert_eq!(resolve_shell(&c), Program { program: "/usr/bin/zsh".into(), args: vec!["-l".into()] });
}

#[test]
fn an_empty_shell_variable_is_not_a_shell() {
    let c = Candidates { windows: false, shell: Some("   ".into()), ..Candidates::default() };
    assert_eq!(resolve_shell(&c).program, "/bin/sh");
}

// --- devtools ----------------------------------------------------------------

/// The shim as it is actually written on this machine.
const SHIM: &str = concat!(
    "#!/bin/sh\n",
    r#"exec "C:/Users/yu_th/AppData/Local/Programs/Python/Python312/python.exe" "#,
    r#""C:/Users/yu_th/dev/devtools/devtools.py" "$@""#,
    "\n"
);

#[test]
fn the_shim_names_the_python_and_the_script() {
    let (python, script) = shim_paths(SHIM).expect("the exec line should parse");
    assert!(python.ends_with("Python312/python.exe"), "{python}");
    assert_eq!(script, "C:/Users/yu_th/dev/devtools/devtools.py");
}

#[test]
fn a_parsed_shim_runs_python_with_the_script_and_then_the_arguments() {
    let c = Candidates { devtools_shim: Some(SHIM.into()), ..Candidates::default() };
    let p = resolve_devtools(&["gradle".into(), "--".into(), "build".into()], &c).unwrap();

    assert!(p.program.ends_with("python.exe"), "{}", p.program);
    assert_eq!(
        p.args,
        vec![
            "C:/Users/yu_th/dev/devtools/devtools.py".to_string(),
            "gradle".into(),
            "--".into(),
            "build".into()
        ]
    );
}

#[test]
fn the_argument_placeholder_is_never_mistaken_for_the_script() {
    // A shim that names one path still has two quoted strings on its exec line, because `"$@"` is
    // quoted. Taking it as the script would run Python against a file called `$@`.
    let one_path = "exec \"/usr/bin/python3\" \"$@\"\n";
    assert!(shim_paths(one_path).is_none());
}

#[test]
fn without_a_shim_the_checkout_is_the_fallback() {
    let c = Candidates {
        devtools_shim: None,
        devtools_script: Some(r"C:\Users\yu_th\dev\devtools\devtools.py".into()),
        ..Candidates::default()
    };
    let p = resolve_devtools(&["sync".into()], &c).unwrap();

    assert_eq!(p.program, "python");
    assert_eq!(p.args, vec![r"C:\Users\yu_th\dev\devtools\devtools.py".to_string(), "sync".into()]);
}

#[test]
fn an_unparseable_shim_still_falls_back_rather_than_failing() {
    let c = Candidates {
        devtools_shim: Some("#!/bin/sh\npython3 -m devtools \"$@\"\n".into()),
        devtools_script: Some("/home/t/dev/devtools/devtools.py".into()),
        ..Candidates::default()
    };
    assert_eq!(resolve_devtools(&[], &c).unwrap().program, "python");
}

#[test]
fn with_neither_it_says_so_instead_of_running_something_else() {
    // The commands this would have run change repositories. A near miss is not an acceptable
    // outcome, so there is no third guess.
    let err = resolve_devtools(&[], &Candidates::default()).unwrap_err();
    assert_eq!(err, "devtools is not installed on this machine");
}

// --- claude ------------------------------------------------------------------

fn installs(versions: &[&str]) -> Vec<(String, String)> {
    versions
        .iter()
        .map(|v| (v.to_string(), format!(r"C:\Users\yu_th\AppData\Roaming\Claude\claude-code\{v}\claude.exe")))
        .collect()
}

#[test]
fn the_newest_build_is_the_highest_number_not_the_last_string() {
    // The whole reason this is a function: sorted as text, 2.1.9 comes after 2.1.271, and the app
    // would launch a build several months old with no sign that it had.
    let (version, path) = newest_claude(&installs(&["2.1.9", "2.1.271", "2.1.270"])).unwrap();
    assert_eq!(version, "2.1.271");
    assert!(path.ends_with(r"2.1.271\claude.exe"));
}

#[test]
fn a_major_version_is_compared_as_a_number_too() {
    assert_eq!(newest_claude(&installs(&["9.9.9", "10.0.0"])).unwrap().0, "10.0.0");
}

#[test]
fn a_directory_that_is_not_a_version_loses_to_one_that_is() {
    // The installer's directory sometimes picks up a `.tmp` or a partially removed build.
    assert_eq!(newest_claude(&installs(&["broken", "1.0.0"])).unwrap().0, "1.0.0");
}

#[test]
fn nothing_installed_is_nothing_chosen() {
    assert!(newest_claude(&[]).is_none());
}

#[test]
fn the_override_beats_everything_else() {
    let c = Candidates {
        claude_env: Some(r"D:\builds\claude.exe".into()),
        claude_on_path: Some(r"C:\shims\claude.cmd".into()),
        claude_installed: installs(&["2.1.271"]),
        ..Candidates::default()
    };
    assert_eq!(resolve_claude(&c).unwrap().program, r"D:\builds\claude.exe");
}

#[test]
fn an_empty_override_is_not_an_override() {
    let c = Candidates {
        claude_env: Some("".into()),
        claude_on_path: Some(r"C:\shims\claude.cmd".into()),
        ..Candidates::default()
    };
    assert_eq!(resolve_claude(&c).unwrap().program, r"C:\shims\claude.cmd");
}

#[test]
fn path_beats_the_installed_builds() {
    let c = Candidates {
        claude_on_path: Some(r"C:\shims\claude.cmd".into()),
        claude_installed: installs(&["2.1.271"]),
        ..Candidates::default()
    };
    assert_eq!(resolve_claude(&c).unwrap().program, r"C:\shims\claude.cmd");
}

#[test]
fn the_session_is_interactive_so_it_takes_no_arguments() {
    // `claude -p` reports "Not logged in" here: authentication belongs to the desktop app and print
    // mode does not look for it. Adding a flag later is how that gets rediscovered the hard way.
    let c = Candidates { claude_installed: installs(&["2.1.271"]), ..Candidates::default() };
    assert!(resolve_claude(&c).unwrap().args.is_empty());
}

#[test]
fn no_claude_anywhere_says_where_to_put_one() {
    let err = resolve_claude(&Candidates::default()).unwrap_err();
    assert!(err.contains("CATALYST_CLAUDE_EXE"), "{err}");
}

// --- the dispatcher ----------------------------------------------------------

#[test]
fn an_unknown_kind_is_refused_by_name() {
    let err = resolve("bash", &[], &Candidates::default()).unwrap_err();
    assert_eq!(err, "unknown terminal kind: bash");
}

#[test]
fn the_kind_chooses_the_program() {
    let c = Candidates {
        windows: true,
        devtools_shim: Some(SHIM.into()),
        claude_installed: installs(&["2.1.271"]),
        ..Candidates::default()
    };
    assert_eq!(resolve("shell", &[], &c).unwrap().program, "powershell.exe");
    assert!(resolve("devtools", &[], &c).unwrap().program.ends_with("python.exe"));
    assert!(resolve("claude", &[], &c).unwrap().program.ends_with("claude.exe"));
}
