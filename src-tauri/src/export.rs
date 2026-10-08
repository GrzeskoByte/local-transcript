//! Exports (transcript, agenda, audio) on the desktop.
//!
//! The webviews Tauri embeds (WebKitGTK, WebView2, WKWebView) do not save
//! `<a download>` blob links, so Export buttons did nothing in the app. The
//! frontend sends the file here instead (raw request body), and it is written
//! to the user's Downloads folder under a name that never overwrites an
//! existing file.

use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// A file name we write: no separators or control characters, not hidden,
/// not `.`/`..`, at most 200 characters.
fn clean_file_name(name: &str) -> Option<String> {
    let cleaned: String = name
        .trim()
        .chars()
        .map(|c| if c.is_control() || "/\\:*?\"<>|".contains(c) { '-' } else { c })
        .collect();
    let cleaned = cleaned.trim_start_matches('.').trim().to_string();
    (!cleaned.is_empty() && cleaned.chars().count() <= 200).then_some(cleaned)
}

/// `name`, or `name (1).ext`, `name (2).ext`… — the first that does not exist.
fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s, format!(".{e}")),
        _ => (name, String::new()),
    };
    (1..10_000)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|p| !p.exists())
        .unwrap_or(first)
}

fn export_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .download_dir()
        .or_else(|_| app.path().home_dir().map(|h| h.join("Downloads")))
        .map_err(|e| format!("Could not find the Downloads folder: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    Ok(dir)
}

fn write_export(dir: &Path, name: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    let name = clean_file_name(name).ok_or_else(|| format!("Invalid file name: {name}"))?;
    let path = unique_path(dir, &name);
    std::fs::write(&path, bytes).map_err(|e| format!("Could not save {}: {e}", path.display()))?;
    Ok(path)
}

/// Save the raw request body as `<Downloads>/<x-file-name>` (URI-encoded
/// header). Returns the absolute path written.
#[tauri::command]
pub async fn native_export_file(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else {
        return Err("Expected the file as raw bytes.".into());
    };
    let data = data.clone();
    let name = request
        .headers()
        .get("x-file-name")
        .and_then(|v| v.to_str().ok())
        .map(percent_decode)
        .ok_or("Missing file name")?;
    let dir = export_dir(&app)?;
    crate::recordings::off_main(move || write_export(&dir, &name, &data).map(|p| p.to_string_lossy().to_string()))
        .await
}

/// Show an exported file in the file manager (its folder). Only files in the
/// export folder.
#[tauri::command]
pub async fn native_reveal_export(app: AppHandle, path: String) -> Result<(), String> {
    let dir = export_dir(&app)?;
    let target = PathBuf::from(&path);
    let parent = target.parent().ok_or("Invalid path")?;
    if parent != dir || !target.is_file() {
        return Err("Not an exported file".into());
    }
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(target_os = "windows") {
        "explorer"
    } else {
        "xdg-open"
    };
    let mut cmd = crate::proc::command(opener);
    // macOS / Windows can select the file; xdg-open opens the folder.
    if cfg!(target_os = "macos") {
        cmd.arg("-R").arg(&target);
    } else if cfg!(target_os = "windows") {
        cmd.arg(format!("/select,{}", target.display()));
    } else {
        cmd.arg(parent);
    }
    cmd.spawn().map_err(|e| format!("Could not open the folder: {e}"))?;
    Ok(())
}

/// Decode `%XX` escapes (the webview sends the name with encodeURIComponent).
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() && s.is_char_boundary(i + 1) && s.is_char_boundary(i + 3) {
            if let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_names_stay_in_the_folder() {
        assert_eq!(clean_file_name("Weekly sync.md").as_deref(), Some("Weekly sync.md"));
        assert_eq!(clean_file_name("../../etc/passwd").as_deref(), Some("-..-etc-passwd"));
        assert_eq!(clean_file_name("a/b\\c.txt").as_deref(), Some("a-b-c.txt"));
        assert_eq!(clean_file_name(".hidden").as_deref(), Some("hidden"));
        assert_eq!(clean_file_name("  ").as_deref(), None);
        assert_eq!(clean_file_name("..").as_deref(), None);
    }

    #[test]
    fn never_overwrites_an_existing_export() {
        let dir = std::env::temp_dir().join(format!("lt-export-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let a = write_export(&dir, "Meeting.txt", b"one").unwrap();
        let b = write_export(&dir, "Meeting.txt", b"two").unwrap();
        assert_eq!(a.file_name().unwrap(), "Meeting.txt");
        assert_eq!(b.file_name().unwrap(), "Meeting (1).txt");
        assert_eq!(std::fs::read(&a).unwrap(), b"one");
        assert_eq!(std::fs::read(&b).unwrap(), b"two");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn decodes_uri_encoded_names() {
        assert_eq!(percent_decode("Spotkanie%20zespo%C5%82u.md"), "Spotkanie zespołu.md");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("a%2"), "a%2");
    }
}
