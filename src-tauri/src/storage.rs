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
    std::fs::write(&target, bytes)
        .map_err(|e| format!("Could not write {}: {e}", target.display()))?;
    Ok(target.to_string_lossy().to_string())
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
    crate::process::command(opener)
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
    crate::process::command(opener)
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
