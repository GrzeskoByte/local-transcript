//! Machine facts and small OS services for Settings and setup:
//! - `native_system_info`: OS, memory, free disk (model recommendation, storage card)
//! - `native_storage_usage`: audio / models / text sizes of this app
//! - `native_pick_folder` + `native_set_storage_dir`: choose (and move to) the local-files folder
//! - `native_keep_awake`: stop the computer sleeping while a recording runs
//! - `native_open_privacy_settings`: the OS microphone privacy page
//! - `native_logs`: the app's recent log lines ("Logs", "Copy diagnostics")
//!
//! Everything spawns OS tools through `crate::proc::command` (AppImage-safe).

use serde::Serialize;
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::{Mutex, OnceLock};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    pub os: String,
    pub os_version: String,
    pub arch: String,
    pub cpus: usize,
    pub memory_bytes: Option<u64>,
    /// Free space where meetings are stored.
    pub free_disk_bytes: Option<u64>,
    pub app_version: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StorageUsage {
    pub audio_bytes: u64,
    pub model_bytes: u64,
    pub text_bytes: u64,
    pub free_bytes: Option<u64>,
    pub folder: String,
}

// ---- log ring --------------------------------------------------------------

fn log_ring() -> &'static Mutex<VecDeque<String>> {
    static L: OnceLock<Mutex<VecDeque<String>>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(VecDeque::with_capacity(500)))
}

/// Keep a log line for "Logs" / "Copy diagnostics" (last 500, no audio or text).
pub fn remember(line: &str) {
    let mut ring = log_ring().lock().unwrap_or_else(|e| e.into_inner());
    if ring.len() >= 500 {
        ring.pop_front();
    }
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    ring.push_back(format!("{secs} {line}"));
}

#[tauri::command]
pub fn native_logs() -> Vec<String> {
    log_ring().lock().unwrap_or_else(|e| e.into_inner()).iter().cloned().collect()
}

// ---- sizes -----------------------------------------------------------------

fn dir_size(dir: &Path, filter: &dyn Fn(&Path) -> bool) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    let mut total = 0;
    for e in entries.flatten() {
        let Ok(meta) = e.metadata() else { continue };
        let path = e.path();
        if meta.is_dir() {
            total += dir_size(&path, filter);
        } else if filter(&path) {
            total += meta.len();
        }
    }
    total
}

fn is_audio(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref(),
        Some("ogg" | "opus" | "webm" | "mp4" | "m4a" | "wav" | "mp3" | "flac" | "aac")
    )
}

/// Free bytes on the volume holding `path` (df / PowerShell).
fn free_space(path: &Path) -> Option<u64> {
    if cfg!(windows) {
        let drive = path.to_string_lossy().chars().next()?;
        let out = crate::proc::command("powershell")
            .args(["-NoProfile", "-Command", &format!("(Get-PSDrive -Name {drive}).Free")])
            .output()
            .ok()?;
        String::from_utf8_lossy(&out.stdout).trim().parse().ok()
    } else {
        let out = crate::proc::command("df").arg("-Pk").arg(path).output().ok()?;
        parse_df(&String::from_utf8_lossy(&out.stdout))
    }
}

/// `df -Pk` → available bytes (4th column of the last line).
fn parse_df(text: &str) -> Option<u64> {
    let line = text.lines().filter(|l| !l.trim().is_empty()).last()?;
    let kb: u64 = line.split_whitespace().nth(3)?.parse().ok()?;
    Some(kb * 1024)
}

fn memory_bytes() -> Option<u64> {
    if cfg!(target_os = "linux") {
        let text = std::fs::read_to_string("/proc/meminfo").ok()?;
        let kb: u64 = text.lines().find(|l| l.starts_with("MemTotal:"))?.split_whitespace().nth(1)?.parse().ok()?;
        Some(kb * 1024)
    } else if cfg!(target_os = "macos") {
        let out = crate::proc::command("sysctl").args(["-n", "hw.memsize"]).output().ok()?;
        String::from_utf8_lossy(&out.stdout).trim().parse().ok()
    } else {
        let out = crate::proc::command("powershell")
            .args(["-NoProfile", "-Command", "(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory"])
            .output()
            .ok()?;
        String::from_utf8_lossy(&out.stdout).trim().parse().ok()
    }
}

fn os_version() -> String {
    if cfg!(target_os = "linux") {
        std::fs::read_to_string("/etc/os-release")
            .ok()
            .and_then(|t| {
                t.lines()
                    .find(|l| l.starts_with("PRETTY_NAME="))
                    .map(|l| l.trim_start_matches("PRETTY_NAME=").trim_matches('"').to_string())
            })
            .unwrap_or_default()
    } else if cfg!(target_os = "macos") {
        crate::proc::command("sw_vers")
            .arg("-productVersion")
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default()
    } else {
        crate::proc::command("cmd")
            .args(["/C", "ver"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default()
    }
}

#[tauri::command]
pub async fn native_system_info(app: AppHandle) -> Result<SystemInfo, String> {
    let folder = crate::storage::storage_root(&app).ok();
    let version = app.package_info().version.to_string();
    crate::recordings::off_main(move || {
        Ok(SystemInfo {
            os: std::env::consts::OS.to_string(),
            os_version: os_version(),
            arch: std::env::consts::ARCH.to_string(),
            cpus: std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1),
            memory_bytes: memory_bytes(),
            free_disk_bytes: folder.as_deref().and_then(free_space),
            app_version: version,
        })
    })
    .await
}

#[tauri::command]
pub async fn native_storage_usage(app: AppHandle) -> Result<StorageUsage, String> {
    let folder = crate::storage::storage_root(&app)?;
    let recordings = crate::recordings::root(&app)?;
    crate::recordings::off_main(move || {
        let model_dirs: Vec<PathBuf> = crate::models::model_dirs();
        let model_bytes = model_dirs.iter().map(|d| dir_size(d, &|p| p.extension().is_some_and(|e| e == "bin" || e == "onnx"))).sum();
        Ok(StorageUsage {
            // The app's own audio store; the local-files copy is counted under "text" only for non-audio files.
            audio_bytes: dir_size(&recordings, &|_| true),
            model_bytes,
            text_bytes: dir_size(&folder, &|p| !is_audio(p)),
            free_bytes: free_space(&folder),
            folder: folder.to_string_lossy().to_string(),
        })
    })
    .await
}

// ---- folder ----------------------------------------------------------------

/// The OS folder dialog; None when cancelled.
#[tauri::command]
pub async fn native_pick_folder(app: AppHandle, title: Option<String>) -> Result<Option<String>, String> {
    let start = crate::storage::storage_root(&app).ok();
    crate::recordings::off_main(move || {
        let mut dialog = app.dialog().file();
        if let Some(t) = title {
            dialog = dialog.set_title(t);
        }
        if let Some(dir) = start {
            dialog = dialog.set_directory(dir);
        }
        Ok(dialog.blocking_pick_folder().and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().to_string()))
    })
    .await
}

/// Use `path` as the local-files folder (empty = back to the default). With
/// `move_files`, every meeting folder moves there first (copy + delete when
/// the folders are on different disks). Returns the folder now in use.
#[tauri::command]
pub async fn native_set_storage_dir(app: AppHandle, path: String, move_files: bool) -> Result<String, String> {
    let old = crate::storage::storage_root(&app)?;
    let new = if path.trim().is_empty() { crate::storage::default_root(&app)? } else { PathBuf::from(path.trim()) };
    if !new.is_absolute() {
        return Err("Pick a full folder path.".into());
    }
    if new.starts_with(&old) && new != old {
        return Err("The new folder cannot be inside the current one.".into());
    }
    let app2 = app.clone();
    crate::recordings::off_main(move || {
        std::fs::create_dir_all(&new).map_err(|e| format!("Could not create {}: {e}", new.display()))?;
        if move_files && new != old {
            move_children(&old, &new)?;
        }
        let value = if path.trim().is_empty() { String::new() } else { new.to_string_lossy().to_string() };
        crate::settings::set_string(&app2, "storage-dir", &value)?;
        Ok(new.to_string_lossy().to_string())
    })
    .await
}

fn move_children(from: &Path, to: &Path) -> Result<(), String> {
    let Ok(entries) = std::fs::read_dir(from) else { return Ok(()) };
    for e in entries.flatten() {
        let target = to.join(e.file_name());
        if target.exists() {
            continue; // never overwrite
        }
        if std::fs::rename(e.path(), &target).is_err() {
            copy_tree(&e.path(), &target)?;
            let _ = if e.path().is_dir() { std::fs::remove_dir_all(e.path()) } else { std::fs::remove_file(e.path()) };
        }
    }
    Ok(())
}

fn copy_tree(from: &Path, to: &Path) -> Result<(), String> {
    if from.is_dir() {
        std::fs::create_dir_all(to).map_err(|e| e.to_string())?;
        for e in std::fs::read_dir(from).map_err(|e| e.to_string())?.flatten() {
            copy_tree(&e.path(), &to.join(e.file_name()))?;
        }
        Ok(())
    } else {
        std::fs::copy(from, to).map(|_| ()).map_err(|e| format!("Could not copy {}: {e}", from.display()))
    }
}

// ---- keep awake ------------------------------------------------------------

fn awake() -> &'static Mutex<Option<Child>> {
    static A: OnceLock<Mutex<Option<Child>>> = OnceLock::new();
    A.get_or_init(|| Mutex::new(None))
}

/// While on: the OS does not sleep (or suspend on lid close, where it lets
/// apps ask). Off kills the helper process. Best-effort.
#[tauri::command]
pub async fn native_keep_awake(on: bool) -> Result<bool, String> {
    crate::recordings::off_main(move || {
        let mut slot = awake().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(mut child) = slot.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        if !on {
            return Ok(false);
        }
        let child = if cfg!(target_os = "linux") {
            crate::proc::command("systemd-inhibit")
                .args([
                    "--what=idle:sleep:handle-lid-switch",
                    "--who=Local Transcribe",
                    "--why=Recording a meeting",
                    "--mode=block",
                    "sleep",
                    "infinity",
                ])
                .spawn()
        } else if cfg!(target_os = "macos") {
            crate::proc::command("caffeinate").args(["-dims"]).spawn()
        } else {
            crate::proc::command("powershell")
                .args([
                    "-NoProfile",
                    "-WindowStyle",
                    "Hidden",
                    "-Command",
                    "$s='[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);';\
                     $t=Add-Type -MemberDefinition $s -Name P -Namespace W -PassThru;\
                     while($true){ [void]$t::SetThreadExecutionState(0x80000041); Start-Sleep 30 }",
                ])
                .spawn()
        };
        match child {
            Ok(c) => {
                *slot = Some(c);
                Ok(true)
            }
            Err(e) => Err(format!("Could not keep the computer awake: {e}")),
        }
    })
    .await
}

pub fn shutdown() {
    if let Some(mut c) = awake().lock().unwrap_or_else(|e| e.into_inner()).take() {
        let _ = c.kill();
    }
}

// ---- privacy settings ------------------------------------------------------

/// Open the OS page where the microphone is allowed for apps.
#[tauri::command]
pub fn native_open_privacy_settings() -> Result<(), String> {
    let spawned = if cfg!(target_os = "macos") {
        crate::proc::command("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
            .spawn()
    } else if cfg!(windows) {
        crate::proc::command("cmd").args(["/C", "start", "", "ms-settings:privacy-microphone"]).spawn()
    } else {
        // GNOME first, then KDE; other desktops: the error carries the manual hint.
        crate::proc::command("gnome-control-center")
            .arg("privacy")
            .spawn()
            .or_else(|_| crate::proc::command("systemsettings").arg("kcm_pulseaudio").spawn())
            .or_else(|_| crate::proc::command("pavucontrol").arg("--tab=4").spawn())
    };
    spawned.map(|_| ()).map_err(|_| {
        "Open your system's sound settings and allow the microphone for Local Transcribe.".to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_free_space_from_df() {
        let out = "Filesystem     1024-blocks      Used Available Capacity Mounted on\n/dev/nvme0n1p2   488245288 300000000 163000000      65% /\n";
        assert_eq!(parse_df(out), Some(163000000 * 1024));
        assert_eq!(parse_df(""), None);
    }

    #[test]
    fn audio_files_are_told_apart() {
        assert!(is_audio(Path::new("a/audio.ogg")));
        assert!(is_audio(Path::new("a/AUDIO.M4A")));
        assert!(!is_audio(Path::new("a/transcript.md")));
    }

    #[test]
    fn moves_folders_without_overwriting() {
        let base = std::env::temp_dir().join(format!("lt-move-{}", std::process::id()));
        let (a, b) = (base.join("a"), base.join("b"));
        std::fs::create_dir_all(a.join("m1")).unwrap();
        std::fs::write(a.join("m1/transcript.md"), "x").unwrap();
        std::fs::create_dir_all(b.join("m2")).unwrap();
        std::fs::write(a.join("m2"), "keep").unwrap_or(());
        move_children(&a, &b).unwrap();
        assert_eq!(std::fs::read_to_string(b.join("m1/transcript.md")).unwrap(), "x");
        let _ = std::fs::remove_dir_all(&base);
    }
}
