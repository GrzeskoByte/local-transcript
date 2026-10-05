//! Local-filesystem storage for the desktop build.
//!
//! The webview still uses OPFS/IndexedDB, but on desktop we also mirror each
//! meeting to a real folder the user can open in their file manager.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Deserialize;
use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, Manager};

const APP_FOLDER: &str = "Local Transcribe";

/// Root folder where recordings and transcripts are mirrored.
pub fn storage_root(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .document_dir()
        .or_else(|_| app.path().home_dir())
        .map_err(|e| format!("Could not resolve a storage location: {e}"))?;
    let dir = base.join(APP_FOLDER);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    Ok(dir)
}

/// Reject absolute paths and `..` so the renderer cannot escape the root.
fn safe_relative(path: &str) -> Result<PathBuf, String> {
    if path.trim().is_empty() {
        return Err("Empty file path".into());
    }
    let mut out = PathBuf::new();
    for component in Path::new(path).components() {
        match component {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            _ => return Err(format!("Refusing unsafe path: {path}")),
        }
    }
    if out.as_os_str().is_empty() {
        return Err(format!("Refusing unsafe path: {path}"));
    }
    Ok(out)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveFileRequest {
    pub relative_path: String,
    pub data_base64: String,
    /// Append to the file instead of replacing it (live recording mirror).
    #[serde(default)]
    pub append: bool,
}

/// Absolute path of the storage folder (created on demand).
#[tauri::command]
pub fn native_storage_dir(app: AppHandle) -> Result<String, String> {
    Ok(storage_root(&app)?.to_string_lossy().to_string())
}

/// Write a base64 payload to `<storage>/<relativePath>`, creating folders.
#[tauri::command]
pub fn native_save_file(app: AppHandle, request: SaveFileRequest) -> Result<String, String> {
    let root = storage_root(&app)?;
    let target = root.join(safe_relative(&request.relative_path)?);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Could not create {}: {e}", parent.display()))?;
    }
    let bytes = STANDARD
        .decode(request.data_base64.as_bytes())
        .map_err(|e| format!("Invalid file payload: {e}"))?;
    let written = if request.append {
        use std::io::Write;
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&target)
            .and_then(|mut file| file.write_all(&bytes))
    } else {
        std::fs::write(&target, bytes)
    };
    written.map_err(|e| format!("Could not write {}: {e}", target.display()))?;
    Ok(target.to_string_lossy().to_string())
}

/// Size of `<storage>/<relativePath>` in bytes, or `None` when it is missing.
#[tauri::command]
pub fn native_storage_file_size(app: AppHandle, relative_path: String) -> Result<Option<u64>, String> {
    let target = storage_root(&app)?.join(safe_relative(&relative_path)?);
    Ok(std::fs::metadata(&target).ok().filter(|m| m.is_file()).map(|m| m.len()))
}

/// Reveal the storage folder in the system file manager.
#[tauri::command]
pub fn native_open_storage_dir(app: AppHandle) -> Result<(), String> {
    let dir = storage_root(&app)?;
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(target_os = "windows") {
        "explorer"
    } else {
        "xdg-open"
    };
    crate::proc::command(opener)
        .arg(&dir)
        .spawn()
        .map_err(|e| format!("Could not open {}: {e}", dir.display()))?;
    Ok(())
}

/// Only http(s) links the app itself produced (e.g. GitLab pages).
fn valid_external_url(url: &str) -> bool {
    (url.starts_with("http://") || url.starts_with("https://"))
        && !url.chars().any(|c| c.is_control() || c.is_whitespace())
}

/// Open a link in the system browser. The Tauri webview swallows
/// `target="_blank"` clicks (no new-window handling), so external links
/// must go through here instead of plain anchors.
#[tauri::command]
pub fn native_open_url(url: String) -> Result<(), String> {
    if !valid_external_url(&url) {
        return Err("Refusing to open a non-HTTP(S) URL".to_string());
    }
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(target_os = "windows") {
        "explorer"
    } else {
        "xdg-open"
    };
    crate::proc::command(opener)
        .arg(&url)
        .spawn()
        .map_err(|e| format!("Could not open link: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_nested_relative_paths() {
        let p = safe_relative("Weekly planning-abc123/microphone.webm").unwrap();
        assert_eq!(
            p,
            PathBuf::from("Weekly planning-abc123/microphone.webm")
        );
    }

    #[test]
    fn rejects_traversal_and_absolute_paths() {
        assert!(safe_relative("../escape.txt").is_err());
        assert!(safe_relative("/etc/passwd").is_err());
        assert!(safe_relative("a/../../b").is_err());
        assert!(safe_relative("   ").is_err());
        assert!(safe_relative("/").is_err());
    }

    #[test]
    fn ignores_current_dir_segments() {
        assert_eq!(
            safe_relative("./a/./b.txt").unwrap(),
            PathBuf::from("a/b.txt")
        );
    }

    #[test]
    fn external_url_allows_only_clean_https() {
        assert!(valid_external_url("https://git.example.com/g/p/-/wikis/x"));
        assert!(valid_external_url("http://localhost:8080/api"));
        assert!(!valid_external_url("file:///etc/passwd"));
        assert!(!valid_external_url("javascript:alert(1)"));
        assert!(!valid_external_url("https://example.com/a b"));
        assert!(!valid_external_url(""));
    }
}

/// WebKitGTK's IndexedDB folder name for an origin: `tauri://localhost` →
/// `tauri_localhost_0`, `http://localhost:5173` → `http_localhost_5173`.
fn webkit_origin_dir(origin: &str) -> Option<String> {
    let (scheme, rest) = origin.split_once("://")?;
    let (host, port) = match rest.trim_end_matches('/').rsplit_once(':') {
        Some((h, p)) if p.chars().all(|c| c.is_ascii_digit()) && !p.is_empty() => (h, p),
        _ => (rest.trim_end_matches('/'), "0"),
    };
    let name = format!("{scheme}_{host}_{port}");
    let ok = !scheme.is_empty()
        && !host.is_empty()
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
        && !name.contains("..");
    ok.then_some(name)
}

/// Move this origin's IndexedDB (unreadable, e.g. written by a newer WebKit
/// than the one bundled in the AppImage) into `<data>/idb-backup-<time>/`,
/// then relaunch so WebKit starts a fresh database. Nothing is deleted: the
/// backup can be opened again by the WebKit build that wrote it.
#[tauri::command]
pub fn native_reset_webview_database(app: AppHandle, origin: String) -> Result<String, String> {
    if !cfg!(target_os = "linux") {
        return Err("Resetting the app database is only supported on Linux.".into());
    }
    let name = webkit_origin_dir(&origin).ok_or_else(|| format!("Unexpected origin: {origin}"))?;
    let data = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Could not resolve the app data folder: {e}"))?;
    let source = data.join("databases").join("indexeddb").join("v1").join(&name);
    if !source.exists() {
        return Err(format!("No app database found at {}", source.display()));
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let backup_dir = data.join(format!("idb-backup-{stamp}"));
    std::fs::create_dir_all(&backup_dir)
        .map_err(|e| format!("Could not create {}: {e}", backup_dir.display()))?;
    let target = backup_dir.join(&name);
    std::fs::rename(&source, &target)
        .map_err(|e| format!("Could not move {} aside: {e}", source.display()))?;
    crate::relaunch::relaunch(&app);
    Ok(target.to_string_lossy().to_string())
}

#[cfg(test)]
mod origin_tests {
    use super::webkit_origin_dir;

    #[test]
    fn maps_origins_to_webkit_folder_names() {
        assert_eq!(webkit_origin_dir("tauri://localhost").as_deref(), Some("tauri_localhost_0"));
        assert_eq!(webkit_origin_dir("http://localhost:5173").as_deref(), Some("http_localhost_5173"));
        assert_eq!(webkit_origin_dir("http://../x").as_deref(), None);
        assert_eq!(webkit_origin_dir("tauri://a/b").as_deref(), None);
        assert_eq!(webkit_origin_dir("nonsense").as_deref(), None);
    }
}
