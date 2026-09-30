//! App settings kept in a plain JSON file outside the webview profile.
//!
//! IndexedDB/localStorage live inside WebKit's data directory, which is tied
//! to the WebKit build that wrote it: a database written by a newer
//! WebKitGTK (host .deb/.rpm or a local build, e.g. 2.52) cannot be opened by
//! the older one bundled in the AppImage (Ubuntu 22.04, 2.50) — WebKit then
//! fails with "Unable to establish IDB database file" and every setting
//! looked lost. Settings (model, language, integrations, prefs) therefore
//! live in `<app config dir>/settings.json` (Linux:
//! `~/.config/io.localtranscribe.app/settings.json`), which no update or
//! WebKit version touches. Meetings/segments stay in IndexedDB (§11).

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{Map, Value};
use tauri::{AppHandle, Manager, State};

const FILE_NAME: &str = "settings.json";

/// Serializes writers inside this process.
#[derive(Default)]
pub struct SettingsLock(Mutex<()>);

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Could not resolve the settings folder: {e}"))?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    Ok(dir.join(FILE_NAME))
}

fn parse(text: &str) -> Option<Map<String, Value>> {
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(map)) => Some(map),
        _ => None,
    }
}

/// Read the settings file; a missing file is empty. A damaged file falls
/// back to the `.bak` written before the last change.
pub fn read_settings(path: &Path) -> Map<String, Value> {
    let read = |p: &Path| std::fs::read_to_string(p).ok().and_then(|t| parse(&t));
    if let Some(map) = read(path) {
        return map;
    }
    read(&path.with_extension("json.bak")).unwrap_or_default()
}

/// Atomically replace the settings file (temp file + rename), keeping the
/// previous version as `.bak`.
pub fn write_settings(path: &Path, map: &Map<String, Value>) -> Result<(), String> {
    let text = serde_json::to_string_pretty(map).map_err(|e| format!("Could not encode settings: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    {
        use std::io::Write;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        // Integration tokens live here: owner-only on Unix.
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut f = options
            .open(&tmp)
            .map_err(|e| format!("Could not write {}: {e}", tmp.display()))?;
        f.write_all(text.as_bytes())
            .and_then(|_| f.sync_all())
            .map_err(|e| format!("Could not write {}: {e}", tmp.display()))?;
    }
    if path.is_file() {
        let _ = std::fs::copy(path, path.with_extension("json.bak"));
    }
    std::fs::rename(&tmp, path).map_err(|e| format!("Could not save {}: {e}", path.display()))
}

/// Every stored setting. `null` values are tombstones (deleted keys).
#[tauri::command]
pub fn native_settings_load(app: AppHandle) -> Result<Map<String, Value>, String> {
    Ok(read_settings(&settings_path(&app)?))
}

/// Store one setting (`null` deletes it). Re-reads the file first so a second
/// app window/instance never clobbers keys it did not change.
#[tauri::command]
pub fn native_settings_set(
    app: AppHandle,
    lock: State<'_, SettingsLock>,
    key: String,
    value: Value,
) -> Result<(), String> {
    if key.is_empty() || key.len() > 256 {
        return Err("Invalid settings key".into());
    }
    let path = settings_path(&app)?;
    let _guard = lock.0.lock().unwrap_or_else(|e| e.into_inner());
    let mut map = read_settings(&path);
    if map.get(&key) == Some(&value) {
        return Ok(());
    }
    map.insert(key, value);
    write_settings(&path, &map)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lt-settings-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn round_trips_and_keeps_backup() {
        let dir = temp_dir("roundtrip");
        let path = dir.join(FILE_NAME);
        assert!(read_settings(&path).is_empty());
        let mut map = Map::new();
        map.insert("asr-language-desktop".into(), Value::String("pl".into()));
        write_settings(&path, &map).unwrap();
        map.insert("gitlab-config".into(), serde_json::json!({ "url": "https://gitlab.example" }));
        write_settings(&path, &map).unwrap();
        assert_eq!(read_settings(&path), map);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let backup = read_settings(&path.with_extension("json.bak"));
        assert_eq!(backup.get("asr-language-desktop"), Some(&Value::String("pl".into())));
        assert!(backup.get("gitlab-config").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn damaged_file_falls_back_to_backup() {
        let dir = temp_dir("damaged");
        let path = dir.join(FILE_NAME);
        let mut map = Map::new();
        map.insert("k".into(), Value::Bool(true));
        write_settings(&path, &map).unwrap();
        write_settings(&path, &map).unwrap();
        std::fs::write(&path, "{ truncated").unwrap();
        assert_eq!(read_settings(&path), map);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
