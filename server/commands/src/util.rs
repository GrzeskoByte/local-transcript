//! Shared helpers: argument parsing, locking, temp names, blocking work.
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

/// Arguments of a command: the camelCase JSON object Tauri would receive.
pub struct Args(pub Map<String, Value>);

impl Args {
    pub fn from_value(value: Value) -> Result<Self, String> {
        match value {
            Value::Object(map) => Ok(Self(map)),
            Value::Null => Ok(Self(Map::new())),
            _ => Err("Expected the command arguments as a JSON object.".into()),
        }
    }

    /// A required argument.
    pub fn get<T: DeserializeOwned>(&self, name: &str) -> Result<T, String> {
        let value = self.0.get(name).ok_or_else(|| format!("Missing argument: {name}"))?;
        serde_json::from_value(value.clone()).map_err(|e| format!("Invalid argument {name}: {e}"))
    }

    /// An optional argument (`null` and missing both give `None`).
    pub fn opt<T: DeserializeOwned>(&self, name: &str) -> Result<Option<T>, String> {
        match self.0.get(name) {
            None | Some(Value::Null) => Ok(None),
            Some(v) => serde_json::from_value(v.clone())
                .map(Some)
                .map_err(|e| format!("Invalid argument {name}: {e}")),
        }
    }

    /// The raw value (any JSON, including `null`).
    pub fn raw(&self, name: &str) -> Result<Value, String> {
        self.0.get(name).cloned().ok_or_else(|| format!("Missing argument: {name}"))
    }
}

pub fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// A unique scratch path `<dir>/<prefix>-<nanos>-<n>` (nothing is created).
pub fn unique_path(dir: &Path, prefix: &str) -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    dir.join(format!("{prefix}-{}-{nanos}-{n}", std::process::id()))
}

/// Total size of the regular files under `dir` (symlinks are not followed).
pub fn dir_size(dir: &Path) -> u64 {
    let mut total = 0u64;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&d) else { continue };
        for entry in entries.flatten() {
            let Ok(meta) = std::fs::symlink_metadata(entry.path()) else { continue };
            if meta.is_dir() {
                stack.push(entry.path());
            } else if meta.is_file() {
                total += meta.len();
            }
        }
    }
    total
}

/// Write via a temp file + rename so a crash never leaves a torn file.
pub fn write_atomic(path: &Path, bytes: &[u8], mode: Option<u32>) -> Result<(), String> {
    use std::io::Write;
    let dir = path.parent().ok_or("Invalid path")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    let tmp = path.with_extension("part");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    if let Some(mode) = mode {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(mode);
    }
    #[cfg(not(unix))]
    let _ = mode;
    let mut f = options.open(&tmp).map_err(|e| format!("Could not write {}: {e}", tmp.display()))?;
    f.write_all(bytes)
        .and_then(|_| f.sync_data())
        .map_err(|e| format!("Could not write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("Could not save {}: {e}", path.display()))
}
