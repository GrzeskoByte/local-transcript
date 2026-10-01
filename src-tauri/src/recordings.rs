//! Durable recording storage for webviews without OPFS.
//!
//! The AppImage's WebKitGTK (2.50, Ubuntu 22.04) exposes no
//! `navigator.storage.getDirectory()`, so recorder chunks cannot go to OPFS
//! there. Before 0.1.7 they silently lived in memory (lost on a crash); now the
//! frontend writes each chunk here instead, as it arrives, into
//! `<app_data_dir>/recordings/meetings/<id>/[<track>/]<chunk>` — the same layout
//! as OPFS, so listing, crash recovery and deletion work unchanged.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const META: &str = "meta.json";

fn root(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not resolve the app data folder: {e}"))?;
    Ok(base.join("recordings").join("meetings"))
}

/// One path segment we accept from the renderer: meeting ids (UUIDs), track
/// names and chunk names (`000001.mp4`). No separators, no leading dot.
fn valid_segment(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && !s.starts_with('.')
        && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

fn meeting_dir(root: &Path, meeting_id: &str) -> Result<PathBuf, String> {
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

/// Write via a temp file + rename so a crash never leaves a torn chunk.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = path.parent().ok_or("Invalid path")?;
    fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    let tmp = path.with_extension("part");
    let mut f = fs::File::create(&tmp).map_err(|e| format!("Could not write {}: {e}", tmp.display()))?;
    f.write_all(bytes).and_then(|_| f.sync_data()).map_err(|e| format!("Could not write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| format!("Could not save {}: {e}", path.display()))
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

fn write_chunk(root: &Path, req: &WriteChunkRequest) -> Result<(), String> {
    if !valid_segment(&req.name) || req.name == META {
        return Err(format!("Invalid chunk name: {}", req.name));
    }
    let bytes = STANDARD
        .decode(req.data_base64.as_bytes())
        .map_err(|e| format!("Invalid chunk data: {e}"))?;
    write_atomic(&track_dir(root, &req.meeting_id, &req.track)?.join(&req.name), &bytes)
}

fn list(root: &Path, meeting_id: &str) -> Result<Vec<TrackChunks>, String> {
    let dir = meeting_dir(root, meeting_id)?;
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

fn read_track(root: &Path, meeting_id: &str, track: &str) -> Result<Vec<u8>, String> {
    let dir = track_dir(root, meeting_id, track)?;
    let mut out = Vec::new();
    for name in chunk_names(&dir) {
        let mut bytes = fs::read(dir.join(&name)).map_err(|e| format!("Could not read {name}: {e}"))?;
        out.append(&mut bytes);
    }
    Ok(out)
}

/// Save one recorder chunk.
#[tauri::command]
pub fn native_recording_write(app: AppHandle, request: WriteChunkRequest) -> Result<(), String> {
    write_chunk(&root(&app)?, &request)
}

#[tauri::command]
pub fn native_recording_write_meta(app: AppHandle, meeting_id: String, meta: String) -> Result<(), String> {
    write_atomic(&meeting_dir(&root(&app)?, &meeting_id)?.join(META), meta.as_bytes())
}

#[tauri::command]
pub fn native_recording_read_meta(app: AppHandle, meeting_id: String) -> Result<Option<String>, String> {
    let path = meeting_dir(&root(&app)?, &meeting_id)?.join(META);
    Ok(fs::read_to_string(path).ok())
}

/// Tracks and their chunk names; [] when nothing is stored.
#[tauri::command]
pub fn native_recording_list(app: AppHandle, meeting_id: String) -> Result<Vec<TrackChunks>, String> {
    list(&root(&app)?, &meeting_id)
}

/// All chunks of a track, concatenated in order, as base64.
#[tauri::command]
pub async fn native_recording_read(app: AppHandle, meeting_id: String, track: String) -> Result<String, String> {
    let root = root(&app)?;
    tauri::async_runtime::spawn_blocking(move || read_track(&root, &meeting_id, &track).map(|b| STANDARD.encode(b)))
        .await
        .map_err(|e| format!("Read task failed: {e}"))?
}

#[tauri::command]
pub fn native_recording_delete(app: AppHandle, meeting_id: String) -> Result<(), String> {
    let dir = meeting_dir(&root(&app)?, &meeting_id)?;
    match fs::remove_dir_all(&dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Could not delete {}: {e}", dir.display())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lt-rec-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn chunk(id: &str, track: &str, name: &str, data: &[u8]) -> WriteChunkRequest {
        WriteChunkRequest {
            meeting_id: id.into(),
            track: track.into(),
            name: name.into(),
            data_base64: STANDARD.encode(data),
        }
    }

    #[test]
    fn writes_lists_and_reads_flat_and_track_chunks() {
        let root = tmp_root("rw");
        write_chunk(&root, &chunk("m1", "", "000001.mp4", b"BB")).unwrap();
        write_chunk(&root, &chunk("m1", "", "000000.mp4", b"AA")).unwrap();
        write_atomic(&root.join("m1").join(META), b"{}").unwrap();
        write_chunk(&root, &chunk("m2", "microphone", "000000.webm", b"mic")).unwrap();
        write_chunk(&root, &chunk("m2", "device", "000000.webm", b"dev")).unwrap();

        assert_eq!(list(&root, "m1").unwrap(), vec![TrackChunks { track: "".into(), chunks: vec!["000000.mp4".into(), "000001.mp4".into()] }]);
        assert_eq!(read_track(&root, "m1", "").unwrap(), b"AABB");
        let m2: Vec<String> = list(&root, "m2").unwrap().into_iter().map(|t| t.track).collect();
        assert_eq!(m2, vec!["device", "microphone"]);
        assert_eq!(read_track(&root, "m2", "microphone").unwrap(), b"mic");
        assert_eq!(list(&root, "missing").unwrap(), vec![]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_paths_that_escape_the_root() {
        let root = tmp_root("esc");
        assert!(write_chunk(&root, &chunk("../x", "", "000000.mp4", b"x")).is_err());
        assert!(write_chunk(&root, &chunk("m1", "../..", "000000.mp4", b"x")).is_err());
        assert!(write_chunk(&root, &chunk("m1", "", "a/b", b"x")).is_err());
        assert!(write_chunk(&root, &chunk("m1", "", ".hidden", b"x")).is_err());
        assert!(write_chunk(&root, &chunk("m1", "", META, b"x")).is_err());
        assert!(!root.exists());
    }

    #[test]
    fn ignores_torn_temp_files() {
        let root = tmp_root("part");
        write_chunk(&root, &chunk("m1", "", "000000.mp4", b"ok")).unwrap();
        fs::write(root.join("m1").join("000001.part"), b"torn").unwrap();
        assert_eq!(read_track(&root, "m1", "").unwrap(), b"ok");
        let _ = fs::remove_dir_all(&root);
    }
}
