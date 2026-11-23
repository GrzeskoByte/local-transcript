//! Per-user settings, encrypted at rest.
//!
//! Semantics of `src-tauri/src/settings.rs` (`native_settings_load` /
//! `native_settings_set`: a JSON map, `null` = tombstone, atomic write + `.bak`
//! fallback), but the file is `settings.enc`: `"LTS1" || nonce(12) || ChaCha20-Poly1305(json)`
//! with a fresh random nonce per write, keyed by `EngineConfig.secret_key`.
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use chacha20poly1305::aead::{Aead, AeadCore, KeyInit, OsRng};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use serde_json::{Map, Value};

use crate::util::{lock, write_atomic};

const FILE_NAME: &str = "settings.enc";
const MAGIC: &[u8; 4] = b"LTS1";

/// Serializes writers (the file is tiny; one lock for all users is plenty).
static WRITE_LOCK: Mutex<()> = Mutex::new(());

pub fn path(user_dir: &Path) -> PathBuf {
    user_dir.join(FILE_NAME)
}

fn backup(path: &Path) -> PathBuf {
    path.with_extension("enc.bak")
}

pub fn encrypt(key: &[u8; 32], map: &Map<String, Value>) -> Result<Vec<u8>, String> {
    let plain = serde_json::to_vec(map).map_err(|e| format!("Could not encode settings: {e}"))?;
    let cipher = ChaCha20Poly1305::new(Key::from_slice(key));
    let nonce = ChaCha20Poly1305::generate_nonce(&mut OsRng);
    let sealed = cipher.encrypt(&nonce, plain.as_ref()).map_err(|_| "Could not encrypt settings.".to_string())?;
    let mut out = Vec::with_capacity(4 + 12 + sealed.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&sealed);
    Ok(out)
}

pub fn decrypt(key: &[u8; 32], bytes: &[u8]) -> Option<Map<String, Value>> {
    if bytes.len() < 4 + 12 + 16 || &bytes[..4] != MAGIC {
        return None;
    }
    let cipher = ChaCha20Poly1305::new(Key::from_slice(key));
    let plain = cipher.decrypt(Nonce::from_slice(&bytes[4..16]), &bytes[16..]).ok()?;
    match serde_json::from_slice::<Value>(&plain) {
        Ok(Value::Object(map)) => Some(map),
        _ => None,
    }
}

fn read_file(path: &Path, key: &[u8; 32]) -> Option<Map<String, Value>> {
    decrypt(key, &std::fs::read(path).ok()?)
}

/// Every stored setting. A missing file is empty; a damaged one falls back to
/// the `.bak` written before the last change.
pub fn load(user_dir: &Path, key: &[u8; 32]) -> Map<String, Value> {
    let path = path(user_dir);
    read_file(&path, key).or_else(|| read_file(&backup(&path), key)).unwrap_or_default()
}

fn store(user_dir: &Path, key: &[u8; 32], map: &Map<String, Value>) -> Result<(), String> {
    let path = path(user_dir);
    let bytes = encrypt(key, map)?;
    if path.is_file() {
        if read_file(&path, key).is_some() {
            let _ = std::fs::copy(&path, backup(&path));
        } else {
            // Unreadable (damaged / other key): keep it aside instead of overwriting.
            let _ = std::fs::rename(&path, path.with_extension("enc.unreadable"));
        }
    }
    write_atomic(&path, &bytes, Some(0o600))
}

/// Store one setting (`null` is kept as a tombstone, like the desktop file).
pub fn set(user_dir: &Path, key: &[u8; 32], name: &str, value: Value) -> Result<(), String> {
    if name.is_empty() || name.len() > 256 {
        return Err("Invalid settings key".into());
    }
    let _guard = lock(&WRITE_LOCK);
    let mut map = load(user_dir, key);
    if map.get(name) == Some(&value) {
        return Ok(());
    }
    map.insert(name.to_string(), value);
    store(user_dir, key, &map)
}
