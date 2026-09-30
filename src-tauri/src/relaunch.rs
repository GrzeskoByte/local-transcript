//! Restarting the app (after an update or a database reset) without two
//! instances sharing one webview profile.
//!
//! `AppHandle::restart()` spawns the new process while the old one — and its
//! WebKit network process, which owns IndexedDB/localStorage — is still
//! shutting down. On Linux the relaunched instance is given the old PID and
//! waits (briefly) for it and its WebKit children to exit before opening the
//! profile; the old instance exits gracefully so WebKit flushes its storage.

/// Env var carrying the PID of the instance that is relaunching us.
const WAIT_ENV: &str = "LT_RELAUNCH_WAIT_PID";

/// Relaunch the app. Returns once the old instance has been asked to exit.
pub fn relaunch(app: &tauri::AppHandle) {
    #[cfg(target_os = "linux")]
    {
        // As an AppImage relaunch the (possibly just replaced) AppImage file;
        // otherwise the executable itself.
        let target = std::env::var_os("APPIMAGE")
            .map(std::path::PathBuf::from)
            .or_else(|| std::env::current_exe().ok());
        if let Some(target) = target {
            let mut cmd = crate::proc::command(&target);
            cmd.env(WAIT_ENV, std::process::id().to_string());
            // The new AppImage runtime sets these for its own mount.
            for k in ["APPDIR", "APPIMAGE", "ARGV0", "OWD"] {
                cmd.env_remove(k);
            }
            if cmd.spawn().is_ok() {
                app.exit(0);
                return;
            }
        }
    }
    app.restart();
}

/// Called first thing on startup: when relaunched, wait for the previous
/// instance (and the WebKit processes it spawned) to exit, up to 15 s.
pub fn wait_for_previous_instance() {
    let Some(pid) = std::env::var(WAIT_ENV).ok().and_then(|v| v.parse::<u32>().ok()) else {
        return;
    };
    std::env::remove_var(WAIT_ENV);
    #[cfg(target_os = "linux")]
    {
        let mut pids = children_of(pid);
        pids.push(pid);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        while pids.iter().any(|p| alive(*p)) && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    }
    #[cfg(not(target_os = "linux"))]
    let _ = pid;
}

#[cfg(target_os = "linux")]
fn alive(pid: u32) -> bool {
    std::path::Path::new(&format!("/proc/{pid}")).exists()
}

/// Direct children of `parent` (the WebKit web/network processes).
#[cfg(target_os = "linux")]
fn children_of(parent: u32) -> Vec<u32> {
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|e| e.file_name().to_str()?.parse::<u32>().ok())
        .filter(|pid| {
            std::fs::read_to_string(format!("/proc/{pid}/stat"))
                .ok()
                .and_then(|s| parent_pid(&s))
                == Some(parent)
        })
        .collect()
}

/// PPID from `/proc/<pid>/stat` (the field after the `)`-terminated name).
#[cfg(target_os = "linux")]
fn parent_pid(stat: &str) -> Option<u32> {
    let rest = &stat[stat.rfind(')')? + 1..];
    rest.split_whitespace().nth(1)?.parse().ok()
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[test]
    fn parses_ppid_even_with_spaces_in_name() {
        assert_eq!(parent_pid("123 (Web Kit) proc) S 77 123 123 0"), Some(77));
        assert_eq!(parent_pid("garbage"), None);
    }

    #[test]
    fn finds_own_children() {
        let mut child = std::process::Command::new("sleep").arg("5").spawn().unwrap();
        let kids = children_of(std::process::id());
        let _ = child.kill();
        let _ = child.wait();
        assert!(kids.contains(&child.id()));
    }
}
