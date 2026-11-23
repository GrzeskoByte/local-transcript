//! Recording store: `<user_dir>/recordings/meetings/<id>/[<track>/]<chunk>`.
// Ported from src-tauri/src/recordings.rs (same layout, same path guards, atomic
// writes); paths come from the user's directory, and writes are quota-checked.
use std::fs;
use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};

use crate::util::{dir_size, write_atomic};

const META: &str = "meta.json";

pub fn root(user_dir: &Path) -> PathBuf {
    user_dir.join("recordings").join("meetings")
}

/// One path segment we accept from the client: meeting ids (UUIDs), track
/// names and chunk names (`000001.mp4`). No separators, no leading dot.
pub fn valid_segment(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && !s.starts_with('.')
        && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

pub fn meeting_dir(root: &Path, meeting_id: &str) -> Result<PathBuf, String> {
    if !valid_segment(meeting_id) {
        return Err(format!("Invalid meeting id: {meeting_id}"));
    }
    Ok(root.join(meeting_id))
}

fn track_dir(root: &Path, meeting_id: &str, track: &str) -> Result<PathBuf, String> {
    let dir = meeting_dir(root, meeting_id)?;
    if track.is_empty() {
        return Ok(dir);
    }
    if !valid_segment(track) {
        return Err(format!("Invalid track: {track}"));
    }
    Ok(dir.join(track))
}

/// Chunk files of a directory (no meta, no temp files), sorted by name.
fn chunk_names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
                .filter_map(|e| e.file_name().into_string().ok())
                .filter(|n| n != META && !n.ends_with(".part") && valid_segment(n))
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteChunkRequest {
    pub meeting_id: String,
    #[serde(default)]
    pub track: String,
    pub name: String,
    pub data_base64: String,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrackChunks {
    /// '' = flat single-track layout.
    pub track: String,
    pub chunks: Vec<String>,
}

fn quota_message(quota_bytes: u64) -> String {
    format!(
        "Storage quota exceeded: your account is limited to {} MB. Delete old recordings or ask an admin to raise the quota.",
        quota_bytes / (1024 * 1024)
    )
}

/// Save one chunk. `quota_bytes` 0 = unlimited; otherwise the user's whole
/// folder (after this write) must stay within it.
pub fn write_chunk(user_dir: &Path, req: &WriteChunkRequest, quota_bytes: u64) -> Result<(), String> {
    if !valid_segment(&req.name) || req.name == META || req.name.ends_with(".part") {
        return Err(format!("Invalid chunk name: {}", req.name));
    }
    let root = root(user_dir);
    let path = track_dir(&root, &req.meeting_id, &req.track)?.join(&req.name);
    let bytes = STANDARD.decode(req.data_base64.as_bytes()).map_err(|e| format!("Invalid chunk data: {e}"))?;
    if quota_bytes > 0 {
        let replaced = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        let used = dir_size(user_dir).saturating_sub(replaced);
        if used.saturating_add(bytes.len() as u64) > quota_bytes {
            return Err(quota_message(quota_bytes));
        }
    }
    write_atomic(&path, &bytes, None)
}

pub fn write_meta(user_dir: &Path, meeting_id: &str, meta: &str) -> Result<(), String> {
    write_atomic(&meeting_dir(&root(user_dir), meeting_id)?.join(META), meta.as_bytes(), None)
}

pub fn read_meta(user_dir: &Path, meeting_id: &str) -> Result<Option<String>, String> {
    Ok(fs::read_to_string(meeting_dir(&root(user_dir), meeting_id)?.join(META)).ok())
}

/// Tracks and their chunk names; [] when nothing is stored.
pub fn list(user_dir: &Path, meeting_id: &str) -> Result<Vec<TrackChunks>, String> {
    let dir = meeting_dir(&root(user_dir), meeting_id)?;
    let mut tracks: Vec<TrackChunks> = fs::read_dir(&dir)
        .map(|rd| {
            rd.flatten()
                .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
                .filter_map(|e| e.file_name().into_string().ok())
                .filter(|n| valid_segment(n))
                .map(|track| TrackChunks { chunks: chunk_names(&dir.join(&track)), track })
                .collect()
        })
        .unwrap_or_default();
    tracks.sort_by(|a, b| a.track.cmp(&b.track));
    let flat = chunk_names(&dir);
    if !flat.is_empty() {
        tracks.insert(0, TrackChunks { track: String::new(), chunks: flat });
    }
    Ok(tracks)
}

/// Snapshot the chunk paths in concatenation order. The HTTP body opens one at a time.
pub fn track_paths(user_dir: &Path, meeting_id: &str, track: &str) -> Result<Vec<PathBuf>, String> {
    let dir = track_dir(&root(user_dir), meeting_id, track)?;
    Ok(chunk_names(&dir).into_iter().map(|name| dir.join(name)).collect())
}

pub fn delete(user_dir: &Path, meeting_id: &str) -> Result<(), String> {
    let dir = meeting_dir(&root(user_dir), meeting_id)?;
    match fs::remove_dir_all(&dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Could not delete the recording: {e}")),
    }
}
