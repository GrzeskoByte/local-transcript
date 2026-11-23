//! Command-level tests: every command goes through `dispatch`, like the HTTP layer does.
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};

use super::*;

struct Env {
    root: PathBuf,
    engine: Arc<Engine>,
}

impl Drop for Env {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

const FAKE_WHISPER: &str = r#"#!/bin/sh
if [ "$1" = "--version" ]; then echo "fake-whisper 1.0"; exit 0; fi
lang=""; base=""
while [ $# -gt 0 ]; do
  case "$1" in
    -of) base="$2"; shift;;
    -l) lang="$2"; shift;;
  esac
  shift
done
dir=$(dirname "$0")
echo "start $lang" >> "$dir/log"
if [ -f "$dir/sleep" ]; then sleep "$(cat "$dir/sleep")" >/dev/null 2>&1; fi
printf '{"transcription":[{"offsets":{"from":0,"to":1000},"text":" hello %s"}]}' "$lang" > "$base.json"
echo "end $lang" >> "$dir/log"
"#;

const FAKE_DIARIZER: &str = r#"#!/bin/sh
dir=$(dirname "$0")
echo "progress 50.00%"
if [ -f "$dir/sleep" ]; then sleep "$(cat "$dir/sleep")" >/dev/null 2>&1; fi
echo "0.000 -- 1.500 speaker_00"
echo "1.500 -- 3.000 speaker_01"
echo "progress 100.00%"
"#;

fn script(path: &std::path::Path, body: &str) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, body).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

fn env() -> Env {
    static N: AtomicU32 = AtomicU32::new(0);
    let root = std::env::temp_dir().join(format!("lt-commands-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
    let _ = std::fs::remove_dir_all(&root);
    let data = root.join("data");
    std::fs::create_dir_all(data.join("models")).unwrap();
    std::fs::write(data.join("models/ggml-base.en.bin"), b"model").unwrap();
    script(&root.join("bin/whisper-cli"), FAKE_WHISPER);
    let diarize = root.join("diarize");
    script(&diarize.join("sherpa-onnx-offline-speaker-diarization"), FAKE_DIARIZER);
    std::fs::write(diarize.join("segmentation.onnx"), b"x").unwrap();
    std::fs::write(diarize.join("embedding.onnx"), b"x").unwrap();
    let engine = Engine::new(EngineConfig {
        data_dir: data,
        whisper_cli: Some(root.join("bin/whisper-cli")),
        diarize_dir: Some(diarize),
        calendar_allowed_hosts: Vec::new(),
        secret_key: [7u8; 32],
    });
    Env { root, engine }
}

fn user(env: &Env, id: &str, admin: bool, quota_bytes: u64) -> UserCtx {
    let user_dir = env.root.join("data/users").join(id);
    std::fs::create_dir_all(&user_dir).unwrap();
    UserCtx { user_id: id.to_string(), user_dir, is_admin: admin, quota_bytes }
}

fn msg(e: CommandError) -> String {
    match e {
        CommandError::NotFound(m) | CommandError::Forbidden(m) | CommandError::Failed(m) => m,
    }
}

async fn call(e: &Env, ctx: &UserCtx, cmd: &str, args: Value) -> Result<Value, CommandError> {
    match dispatch(&e.engine, ctx, cmd, Body::Json(args)).await? {
        Reply::Json(v) => Ok(v),
        Reply::Recording(_) => panic!("expected JSON from {cmd}"),
    }
}

async fn call_ok(e: &Env, ctx: &UserCtx, cmd: &str, args: Value) -> Value {
    call(e, ctx, cmd, args).await.unwrap_or_else(|err| panic!("{cmd} failed: {}", msg(err)))
}

async fn write_chunk(e: &Env, ctx: &UserCtx, id: &str, track: &str, name: &str, data: &[u8]) -> Result<Value, CommandError> {
    call(
        e,
        ctx,
        "native_recording_write",
        json!({"request": {"meetingId": id, "track": track, "name": name, "dataBase64": STANDARD.encode(data)}}),
    )
    .await
}

async fn read_track(e: &Env, ctx: &UserCtx, id: &str, track: &str) -> Vec<u8> {
    match dispatch(&e.engine, ctx, "native_recording_read", Body::Json(json!({"meetingId": id, "track": track})))
        .await
        .unwrap_or_else(|err| panic!("read failed: {}", msg(err)))
    {
        Reply::Recording(paths) => paths.into_iter().flat_map(|path| std::fs::read(path).unwrap()).collect(),
        Reply::Json(_) => panic!("expected bytes"),
    }
}

fn wav_payload() -> String {
    let samples = 1600u32;
    let mut out = Vec::new();
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + samples * 2).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&16_000u32.to_le_bytes());
    out.extend_from_slice(&32_000u32.to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(samples * 2).to_le_bytes());
    out.extend_from_slice(&vec![0u8; (samples * 2) as usize]);
    STANDARD.encode(out)
}

fn transcribe_args(tag: &str) -> Value {
    json!({"request": {"samplesBase64": wav_payload(), "sampleRate": 16000, "model": "base.en", "language": tag}})
}

fn live_args(tag: &str) -> Value {
    json!({"request": {"samplesBase64": wav_payload(), "sampleRate": 16000, "model": "base.en", "language": tag}})
}

fn set_sleep(e: &Env, seconds: &str) {
    std::fs::write(e.root.join("bin/sleep"), seconds).unwrap();
}

fn log_lines(e: &Env) -> Vec<String> {
    std::fs::read_to_string(e.root.join("bin/log")).unwrap_or_default().lines().map(str::to_string).collect()
}

async fn wait_for_log(e: &Env, line: &str) {
    for _ in 0..200 {
        if log_lines(e).iter().any(|l| l == line) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("never saw `{line}` in {:?}", log_lines(e));
}

async fn wait_queued(e: &Env, user: &str, n: usize) {
    for _ in 0..400 {
        if e.engine.asr.queue.queued(user) == n {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("{user} never had {n} queued jobs");
}

// --- dispatch -----------------------------------------------------------------

#[tokio::test]
async fn unknown_and_desktop_only_commands_are_not_found() {
    let e = env();
    let u = user(&e, "u1", true, 0);
    for cmd in ["native_recorder_start", "native_update_check", "does_not_exist", "server_db_nope_x"] {
        let err = call(&e, &u, cmd, json!({})).await.unwrap_err();
        match err {
            CommandError::NotFound(m) => assert!(m.contains("not available in the server edition"), "{m}"),
            other => panic!("{cmd}: {other:?}"),
        }
    }
}

#[tokio::test]
async fn members_cannot_download_models_or_enable_gpu() {
    let e = env();
    let member = user(&e, "m1", false, 0);
    for cmd in ["native_asr_download_model", "native_asr_enable_gpu"] {
        let err = call(&e, &member, cmd, json!({"name": "tiny"})).await.unwrap_err();
        assert!(matches!(err, CommandError::Forbidden(_)), "{cmd}: {err:?}");
    }
    assert!(!capabilities(false).contains(&"native_asr_download_model"));
    assert!(capabilities(true).contains(&"native_asr_download_model"));
    assert!(capabilities(false).contains(&"server_db_commit_transcript"));
}

// --- settings -----------------------------------------------------------------

#[tokio::test]
async fn settings_round_trip_and_are_encrypted_on_disk() {
    let e = env();
    let u = user(&e, "u1", false, 0);
    assert_eq!(call_ok(&e, &u, "native_settings_load", json!({})).await, json!({}));
    call_ok(&e, &u, "native_settings_set", json!({"key": "gitlab-config", "value": {"token": "super-secret-token-123"}})).await;
    call_ok(&e, &u, "native_settings_set", json!({"key": "asr-language-desktop", "value": "pl"})).await;
    call_ok(&e, &u, "native_settings_set", json!({"key": "gone", "value": null})).await;
    let loaded = call_ok(&e, &u, "native_settings_load", json!({})).await;
    assert_eq!(loaded["asr-language-desktop"], "pl");
    assert_eq!(loaded["gitlab-config"]["token"], "super-secret-token-123");
    assert_eq!(loaded["gone"], Value::Null);

    let on_disk = std::fs::read(u.user_dir.join("settings.enc")).unwrap();
    let text = String::from_utf8_lossy(&on_disk);
    assert!(!text.contains("super-secret-token-123") && !text.contains("gitlab-config") && !text.contains("pl\""));
    assert_eq!(&on_disk[..4], b"LTS1");
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(std::fs::metadata(u.user_dir.join("settings.enc")).unwrap().permissions().mode() & 0o777, 0o600);
    // A fresh nonce per write: the same content encrypts differently.
    let mut map = serde_json::Map::new();
    map.insert("a".into(), json!(1));
    assert_ne!(settings::encrypt(&[7u8; 32], &map).unwrap(), settings::encrypt(&[7u8; 32], &map).unwrap());
    // Another key cannot read it.
    assert!(settings::decrypt(&[8u8; 32], &on_disk).is_none());
}

#[tokio::test]
async fn damaged_settings_fall_back_to_the_backup() {
    let e = env();
    let u = user(&e, "u1", false, 0);
    call_ok(&e, &u, "native_settings_set", json!({"key": "k", "value": 1})).await;
    call_ok(&e, &u, "native_settings_set", json!({"key": "k", "value": 2})).await;
    std::fs::write(u.user_dir.join("settings.enc"), b"garbage").unwrap();
    assert_eq!(call_ok(&e, &u, "native_settings_load", json!({})).await, json!({"k": 1}));
    // Writing again keeps the unreadable file aside rather than destroying it.
    call_ok(&e, &u, "native_settings_set", json!({"key": "k", "value": 3})).await;
    assert!(u.user_dir.join("settings.enc.unreadable").is_file());
    assert!(call(&e, &u, "native_settings_set", json!({"key": "", "value": 1})).await.is_err());
}

// --- recordings ---------------------------------------------------------------

#[tokio::test]
async fn recordings_round_trip_flat_and_tracks() {
    let e = env();
    let u = user(&e, "u1", false, 0);
    write_chunk(&e, &u, "m1", "", "000001.ogg", b"BB").await.unwrap();
    write_chunk(&e, &u, "m1", "", "000000.ogg", b"AA").await.unwrap();
    call_ok(&e, &u, "native_recording_write_meta", json!({"meetingId": "m1", "meta": "{\"native\":true}"})).await;
    write_chunk(&e, &u, "m2", "microphone", "000000.webm", b"mic").await.unwrap();
    write_chunk(&e, &u, "m2", "device", "000000.webm", b"dev").await.unwrap();

    assert_eq!(read_track(&e, &u, "m1", "").await, b"AABB");
    assert_eq!(read_track(&e, &u, "m2", "microphone").await, b"mic");
    assert_eq!(
        call_ok(&e, &u, "native_recording_list", json!({"meetingId": "m1"})).await,
        json!([{"track": "", "chunks": ["000000.ogg", "000001.ogg"]}])
    );
    let tracks: Vec<Value> = call_ok(&e, &u, "native_recording_list", json!({"meetingId": "m2"})).await.as_array().unwrap().clone();
    assert_eq!(tracks.iter().map(|t| t["track"].as_str().unwrap()).collect::<Vec<_>>(), ["device", "microphone"]);
    assert_eq!(call_ok(&e, &u, "native_recording_read_meta", json!({"meetingId": "m1"})).await, json!("{\"native\":true}"));
    assert_eq!(call_ok(&e, &u, "native_recording_read_meta", json!({"meetingId": "none"})).await, Value::Null);
    assert_eq!(call_ok(&e, &u, "native_recording_list", json!({"meetingId": "none"})).await, json!([]));
    // Stored under the documented layout.
    assert!(u.user_dir.join("recordings/meetings/m1/000000.ogg").is_file());

    call_ok(&e, &u, "native_recording_delete", json!({"meetingId": "m1"})).await;
    assert!(!u.user_dir.join("recordings/meetings/m1").exists());
    call_ok(&e, &u, "native_recording_delete", json!({"meetingId": "m1"})).await; // idempotent
}

#[tokio::test]
async fn recording_paths_cannot_escape() {
    let e = env();
    let u = user(&e, "u1", false, 0);
    let other = user(&e, "u2", false, 0);
    assert!(write_chunk(&e, &u, "../x", "", "000000.ogg", b"x").await.is_err());
    assert!(write_chunk(&e, &u, "m1", "../..", "000000.ogg", b"x").await.is_err());
    assert!(write_chunk(&e, &u, "m1", "", "a/b", b"x").await.is_err());
    assert!(write_chunk(&e, &u, "m1", "", ".hidden", b"x").await.is_err());
    assert!(write_chunk(&e, &u, "m1", "", "meta.json", b"x").await.is_err());
    let rel = format!("../../{}/recordings/meetings/m", other.user_id);
    assert!(write_chunk(&e, &u, &rel, "", "000000.ogg", b"x").await.is_err());
    for cmd in ["native_recording_read", "native_recording_list", "native_recording_delete", "native_recording_read_meta"] {
        assert!(call(&e, &u, cmd, json!({"meetingId": "../u2", "track": ""})).await.is_err(), "{cmd}");
    }
    assert!(call(&e, &u, "native_recording_write_meta", json!({"meetingId": "..", "meta": "{}"})).await.is_err());
    assert!(!u.user_dir.join("recordings").exists());
    assert!(!other.user_dir.join("recordings").exists());
}

#[tokio::test]
async fn quota_blocks_writes_beyond_the_limit() {
    let e = env();
    let u = user(&e, "u1", false, 2 * 1024 * 1024);
    let big = vec![1u8; 1024 * 1024 + 1024];
    write_chunk(&e, &u, "m1", "", "000000.ogg", &big).await.unwrap();
    let err = msg(write_chunk(&e, &u, "m1", "", "000001.ogg", &big).await.unwrap_err());
    assert!(err.to_lowercase().contains("quota") && err.contains("2 MB"), "{err}");
    assert!(!u.user_dir.join("recordings/meetings/m1/000001.ogg").exists());
    // Overwriting a chunk with a same-sized one is not double-counted; small ones still fit.
    write_chunk(&e, &u, "m1", "", "000000.ogg", &big).await.unwrap();
    write_chunk(&e, &u, "m1", "", "000002.ogg", b"tiny").await.unwrap();
    // Unlimited (0) never blocks.
    let free = user(&e, "u2", false, 0);
    write_chunk(&e, &free, "m1", "", "000000.ogg", &big).await.unwrap();
    assert!(usage_bytes(&u.user_dir) > big.len() as u64);
}

// --- meeting database -----------------------------------------------------------

fn meeting(id: &str) -> Value {
    json!({"id": id, "title": "Standup", "transcriptionStatus": "not_started", "durationMs": 1000})
}

fn segment(id: &str, meeting_id: &str, text: &str) -> Value {
    json!({"id": id, "meetingId": meeting_id, "startMs": 0, "endMs": 10, "text": text})
}

#[tokio::test]
async fn concurrent_recording_writes_respect_quota() {
    let e = std::sync::Arc::new(env());
    let u = user(&e, "u1", false, 128 * 1024);
    let mut jobs = tokio::task::JoinSet::new();
    let start = std::sync::Arc::new(tokio::sync::Barrier::new(8));
    for i in 0..8 {
        let (e, u, start) = (e.clone(), u.clone(), start.clone());
        jobs.spawn(async move {
            start.wait().await;
            write_chunk(&e, &u, "m1", "", &format!("{i}.ogg"), &[1; 65_536]).await
        });
    }
    let mut saved = 0;
    while let Some(result) = jobs.join_next().await {
        match result.unwrap() {
            Ok(_) => saved += 1,
            Err(err) => assert!(msg(err).contains("quota")),
        }
    }
    assert_eq!(saved, 2);
    assert_eq!(usage_bytes(&u.user_dir), u.quota_bytes);
}

#[tokio::test]
async fn meeting_patch_and_compare_and_swap_preserve_concurrent_edits() {
    let e = env();
    let u = user(&e, "u1", false, 0);
    let patch = |key, patch| call(&e, &u, "server_db_patch", json!({"store": "meetings", "key": key, "patch": patch}));
    let replace = |value, expected| call(&e, &u, "server_db_put_if_unchanged", json!({"store": "meetings", "value": value, "expected": expected}));
    let original = json!({"id": "m1", "title": "Old", "nested": {"a": 1, "b": 2}});
    assert_eq!(patch("m1", json!({"title": "New"})).await.unwrap(), Value::Null);
    assert_eq!(replace(original.clone(), Value::Null).await.unwrap(), json!(false));
    call_ok(&e, &u, "server_db_put", json!({"store": "meetings", "value": original})).await;
    let (rename, nested) = tokio::join!(
        patch("m1", json!({"title": "New"})),
        patch("m1", json!({"nested": {"b": 3}})),
    );
    assert!(rename.is_ok() && nested.is_ok());
    assert!(patch("m1", json!({"id": "m2"})).await.is_err());
    let changed = call_ok(&e, &u, "server_db_get", json!({"store": "meetings", "key": "m1"})).await;
    assert_eq!(changed, json!({"id": "m1", "title": "New", "nested": {"b": 3}}));
    assert_eq!(replace(json!({"id": "m1"}), original).await.unwrap(), json!(false));
    let (first, second) = tokio::join!(
        replace(json!({"id": "m1", "title": "First"}), changed.clone()),
        replace(json!({"id": "m1", "title": "Second"}), changed.clone()),
    );
    assert_ne!(first.unwrap(), second.unwrap());
    for command in ["server_db_patch", "server_db_put_if_unchanged"] {
        assert!(capabilities(false).contains(&command));
    }
}

#[tokio::test]
async fn db_basic_store_operations() {
    let e = env();
    let u = user(&e, "u1", false, 0);
    assert_eq!(call_ok(&e, &u, "server_db_get", json!({"store": "meetings", "key": "m1"})).await, Value::Null);
    call_ok(&e, &u, "server_db_put", json!({"store": "meetings", "value": meeting("m1")})).await;
    call_ok(&e, &u, "server_db_put", json!({"store": "meetings", "value": meeting("m2")})).await;
    call_ok(&e, &u, "server_db_put", json!({"store": "kv", "value": {"key": "calendar-cache:x", "value": [1, 2]}})).await;
    assert_eq!(call_ok(&e, &u, "server_db_get", json!({"store": "meetings", "key": "m1"})).await, meeting("m1"));
    assert_eq!(call_ok(&e, &u, "server_db_get_all", json!({"store": "meetings"})).await.as_array().unwrap().len(), 2);
    assert_eq!(
        call_ok(&e, &u, "server_db_get", json!({"store": "kv", "key": "calendar-cache:x"})).await["value"],
        json!([1, 2])
    );
    // Replace, not merge.
    call_ok(&e, &u, "server_db_put", json!({"store": "meetings", "value": {"id": "m1", "title": "Renamed"}})).await;
    assert_eq!(
        call_ok(&e, &u, "server_db_get", json!({"store": "meetings", "key": "m1"})).await,
        json!({"id": "m1", "title": "Renamed"})
    );
    call_ok(&e, &u, "server_db_delete", json!({"store": "meetings", "key": "m2"})).await;
    assert_eq!(call_ok(&e, &u, "server_db_get_all", json!({"store": "meetings"})).await.as_array().unwrap().len(), 1);
    assert!(call(&e, &u, "server_db_get", json!({"store": "nope", "key": "x"})).await.is_err());
    assert!(call(&e, &u, "server_db_put", json!({"store": "meetings", "value": {"title": "no id"}})).await.is_err());
    assert!(call(&e, &u, "server_db_put", json!({"store": "segments", "value": {"id": "s", "text": "no meeting"}})).await.is_err());
}

#[tokio::test]
async fn db_put_if_exists_only_updates_existing_rows() {
    let e = env();
    let u = user(&e, "u1", false, 0);
    let missing = call_ok(&e, &u, "server_db_put_if_exists", json!({"store": "meetings", "value": meeting("m1")})).await;
    assert_eq!(missing, json!(false));
    assert_eq!(call_ok(&e, &u, "server_db_get", json!({"store": "meetings", "key": "m1"})).await, Value::Null);
    call_ok(&e, &u, "server_db_put", json!({"store": "meetings", "value": meeting("m1")})).await;
    let mut updated = meeting("m1");
    updated["title"] = json!("Updated");
    assert_eq!(call_ok(&e, &u, "server_db_put_if_exists", json!({"store": "meetings", "value": updated})).await, json!(true));
    assert_eq!(call_ok(&e, &u, "server_db_get", json!({"store": "meetings", "key": "m1"})).await["title"], "Updated");
}

#[tokio::test]
async fn db_commit_transcript_is_atomic_and_a_noop_for_deleted_meetings() {
    let e = env();
    let u = user(&e, "u1", false, 0);
    call_ok(&e, &u, "server_db_put", json!({"store": "meetings", "value": meeting("m1")})).await;
    call_ok(&e, &u, "server_db_put", json!({"store": "segments", "value": segment("old-1", "m1", "old")})).await;
    call_ok(&e, &u, "server_db_put", json!({"store": "segments", "value": segment("other-1", "m2", "other")})).await;

    let done = call_ok(
        &e,
        &u,
        "server_db_commit_transcript",
        json!({"meetingId": "m1", "segments": [segment("s1", "m1", "one"), segment("s2", "m1", "two")], "patch": {"transcriptSource": {"kind": "file"}, "title": "Patched"}}),
    )
    .await;
    assert_eq!(done, json!(true));
    let segs = call_ok(&e, &u, "server_db_get_by_index", json!({"store": "segments", "index": "by-meeting", "key": "m1"})).await;
    let texts: Vec<&str> = segs.as_array().unwrap().iter().map(|s| s["text"].as_str().unwrap()).collect();
    assert_eq!(texts, ["one", "two"]); // the old line is gone
    let m = call_ok(&e, &u, "server_db_get", json!({"store": "meetings", "key": "m1"})).await;
    assert_eq!(m["transcriptionStatus"], "completed");
    assert_eq!(m["title"], "Patched");
    assert_eq!(m["durationMs"], 1000); // untouched fields stay
    assert_eq!(m["transcriptSource"]["kind"], "file");
    // Another meeting's segments are untouched.
    let other = call_ok(&e, &u, "server_db_get_by_index", json!({"store": "segments", "index": "by-meeting", "key": "m2"})).await;
    assert_eq!(other.as_array().unwrap().len(), 1);

    // All or nothing: a bad segment rolls the whole commit back.
    let err = call(
        &e,
        &u,
        "server_db_commit_transcript",
        json!({"meetingId": "m1", "segments": [segment("s9", "m1", "new"), {"text": "no id"}], "patch": {"title": "Should not stick"}}),
    )
    .await;
    assert!(err.is_err());
    let segs = call_ok(&e, &u, "server_db_get_by_index", json!({"store": "segments", "index": "by-meeting", "key": "m1"})).await;
    assert_eq!(segs.as_array().unwrap().len(), 2);
    assert_eq!(call_ok(&e, &u, "server_db_get", json!({"store": "meetings", "key": "m1"})).await["title"], "Patched");

    // The meeting was deleted mid-run: nothing is written, no orphan segments.
    call_ok(&e, &u, "server_db_delete_meeting", json!({"id": "m1"})).await;
    let done = call_ok(
        &e,
        &u,
        "server_db_commit_transcript",
        json!({"meetingId": "m1", "segments": [segment("z1", "m1", "zombie")], "patch": {}}),
    )
    .await;
    assert_eq!(done, json!(false));
    assert_eq!(call_ok(&e, &u, "server_db_get", json!({"store": "meetings", "key": "m1"})).await, Value::Null);
    assert_eq!(call_ok(&e, &u, "server_db_get_all", json!({"store": "segments"})).await.as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn db_delete_meeting_removes_its_segments_only() {
    let e = env();
    let u = user(&e, "u1", false, 0);
    for id in ["m1", "m2"] {
        call_ok(&e, &u, "server_db_put", json!({"store": "meetings", "value": meeting(id)})).await;
        for n in 0..3 {
            call_ok(&e, &u, "server_db_put", json!({"store": "segments", "value": segment(&format!("{id}-{n}"), id, "t")})).await;
        }
    }
    call_ok(&e, &u, "server_db_delete_meeting", json!({"id": "m1"})).await;
    assert_eq!(call_ok(&e, &u, "server_db_get", json!({"store": "meetings", "key": "m1"})).await, Value::Null);
    let left = call_ok(&e, &u, "server_db_get_all", json!({"store": "segments"})).await;
    assert!(left.as_array().unwrap().iter().all(|s| s["meetingId"] == "m2") && left.as_array().unwrap().len() == 3);
    assert_eq!(call_ok(&e, &u, "server_db_get", json!({"store": "meetings", "key": "m2"})).await["id"], "m2");
}

#[tokio::test]
async fn db_sets_segment_speakers() {
    let e = env();
    let u = user(&e, "u1", false, 0);
    call_ok(&e, &u, "server_db_put", json!({"store": "meetings", "value": meeting("m1")})).await;
    for n in 0..3 {
        call_ok(&e, &u, "server_db_put", json!({"store": "segments", "value": segment(&format!("s{n}"), "m1", "t")})).await;
    }
    call_ok(&e, &u, "server_db_put", json!({"store": "segments", "value": segment("x0", "m2", "t")})).await;
    call_ok(&e, &u, "server_db_set_segment_speakers", json!({"meetingId": "m1", "speakers": {"s0": "Anna", "s2": "Bob", "x0": "Intruder"}})).await;
    let segs = call_ok(&e, &u, "server_db_get_by_index", json!({"store": "segments", "index": "by-meeting", "key": "m1"})).await;
    let speakers: Vec<Value> = segs.as_array().unwrap().iter().map(|s| s["speaker"].clone()).collect();
    assert_eq!(speakers, [json!("Anna"), Value::Null, json!("Bob")]);
    // A segment of another meeting is never touched.
    assert!(call_ok(&e, &u, "server_db_get", json!({"store": "segments", "key": "x0"})).await.get("speaker").is_none());
}

// --- isolation / account ----------------------------------------------------------

#[tokio::test]
async fn two_users_are_fully_isolated() {
    let e = env();
    let a = user(&e, "ua", false, 0);
    let b = user(&e, "ub", false, 0);
    for (u, tag) in [(&a, "A"), (&b, "B")] {
        call_ok(&e, u, "server_db_put", json!({"store": "meetings", "value": {"id": "m1", "title": tag}})).await;
        call_ok(&e, u, "server_db_put", json!({"store": "segments", "value": segment("s1", "m1", tag)})).await;
        call_ok(&e, u, "native_settings_set", json!({"key": "who", "value": tag})).await;
        write_chunk(&e, u, "m1", "", "000000.ogg", tag.as_bytes()).await.unwrap();
    }
    for (u, tag) in [(&a, "A"), (&b, "B")] {
        assert_eq!(call_ok(&e, u, "server_db_get", json!({"store": "meetings", "key": "m1"})).await["title"], tag);
        assert_eq!(call_ok(&e, u, "native_settings_load", json!({})).await["who"], tag);
        assert_eq!(read_track(&e, u, "m1", "").await, tag.as_bytes());
        assert_eq!(call_ok(&e, u, "server_db_get_all", json!({"store": "segments"})).await[0]["text"], tag);
    }
    // Deleting A's data leaves B intact.
    call_ok(&e, &a, "native_recording_delete", json!({"meetingId": "m1"})).await;
    call_ok(&e, &a, "server_db_delete_meeting", json!({"id": "m1"})).await;
    assert_eq!(read_track(&e, &b, "m1", "").await, b"B");
    assert_eq!(call_ok(&e, &b, "server_db_get", json!({"store": "meetings", "key": "m1"})).await["title"], "B");
    // Each user's files live only in their own folder.
    assert!(a.user_dir.join("meetings.db").is_file() && b.user_dir.join("meetings.db").is_file());
    assert_ne!(a.user_dir.join("settings.enc"), b.user_dir.join("settings.enc"));
}

#[tokio::test]
async fn export_zip_contains_the_users_data() {
    let e = env();
    let u = user(&e, "u1", false, 0);
    call_ok(&e, &u, "server_db_put", json!({"store": "meetings", "value": meeting("m1")})).await;
    call_ok(&e, &u, "server_db_put", json!({"store": "segments", "value": segment("s1", "m1", "hello")})).await;
    call_ok(&e, &u, "server_db_put", json!({"store": "kv", "value": {"key": "k", "value": 1}})).await;
    call_ok(&e, &u, "native_settings_set", json!({"key": "gitlab-config", "value": {"url": "https://gl.example"}})).await;
    write_chunk(&e, &u, "m1", "", "000000.ogg", b"OggS-audio").await.unwrap();
    write_chunk(&e, &u, "m1", "mic", "000000.webm", b"mic").await.unwrap();

    let file = export_user(&e.engine, &u).await.unwrap();
    let mut zip = zip::ZipArchive::new(file).unwrap();
    let mut names: Vec<String> = (0..zip.len()).map(|i| zip.by_index(i).unwrap().name().to_string()).collect();
    names.sort();
    assert_eq!(
        names,
        [
            "kv.json",
            "meetings.json",
            "recordings/meetings/m1/000000.ogg",
            "recordings/meetings/m1/mic/000000.webm",
            "segments.json",
            "settings.json"
        ]
    );
    use std::io::Read;
    let mut read = |name: &str| {
        let mut s = Vec::new();
        zip.by_name(name).unwrap().read_to_end(&mut s).unwrap();
        s
    };
    assert_eq!(read("recordings/meetings/m1/000000.ogg"), b"OggS-audio");
    let settings: Value = serde_json::from_slice(&read("settings.json")).unwrap();
    assert_eq!(settings["gitlab-config"]["url"], "https://gl.example"); // decrypted
    let meetings: Value = serde_json::from_slice(&read("meetings.json")).unwrap();
    assert_eq!(meetings[0]["id"], "m1");
    let segments: Value = serde_json::from_slice(&read("segments.json")).unwrap();
    assert_eq!(segments[0]["text"], "hello");
}

#[tokio::test]
async fn export_of_an_empty_user_is_a_valid_zip() {
    let e = env();
    let u = user(&e, "fresh", false, 0);
    let zip = zip::ZipArchive::new(export_user(&e.engine, &u).await.unwrap()).unwrap();
    assert_eq!(zip.len(), 4);
}

#[tokio::test]
async fn delete_user_data_removes_the_folder_and_stops_their_jobs() {
    let e = env();
    set_sleep(&e, "5");
    let u = user(&e, "u1", false, 0);
    let other = user(&e, "u2", false, 0);
    write_chunk(&e, &u, "m1", "", "000000.ogg", b"x").await.unwrap();
    let job = {
        let (engine, ctx) = (e.engine.clone(), u.clone());
        tokio::spawn(async move { dispatch(&engine, &ctx, "native_asr_transcribe", Body::Json(transcribe_args("u1"))).await })
    };
    wait_for_log(&e, "start u1").await;
    delete_user_data(&e.engine, &u).await.unwrap();
    let err = job.await.unwrap().err().map(msg).unwrap();
    assert_eq!(err, "Transcription cancelled");
    assert!(!u.user_dir.exists());
    assert!(other.user_dir.exists());
    delete_user_data(&e.engine, &u).await.unwrap(); // already gone is fine
}

// --- ASR ----------------------------------------------------------------------

#[tokio::test]
async fn asr_status_models_and_transcribe() {
    let e = env();
    let u = user(&e, "u1", false, 0);
    let status = call_ok(&e, &u, "native_asr_status", json!({})).await;
    assert_eq!(status["available"], true);
    assert_eq!(status["backend"], "whisper-cli");
    assert_eq!(status["version"], "fake-whisper 1.0");
    assert_eq!(status["recommendedModel"], "large-v3-turbo-q5_0");
    assert_eq!(status["bundled"], false);
    let models = call_ok(&e, &u, "native_asr_models", json!({})).await;
    let base = models.as_array().unwrap().iter().find(|m| m["name"] == "base.en").unwrap();
    assert_eq!(base["installed"], true);
    assert!(models.as_array().unwrap().iter().any(|m| m["name"] == "large-v3-turbo" && m["installed"] == false));

    let segs = call_ok(&e, &u, "native_asr_transcribe", transcribe_args("en")).await;
    assert_eq!(segs, json!([{"startMs": 0.0, "endMs": 1000.0, "text": "hello en"}]));
    // Scratch files are removed.
    let tmp = e.engine.config.data_dir.join("tmp");
    assert_eq!(std::fs::read_dir(tmp).map(|d| d.count()).unwrap_or(0), 0);
    // Empty audio → no segments; bad model names never reach the CLI.
    let empty = json!({"request": {"samplesBase64": "", "sampleRate": 16000, "model": "base.en"}});
    assert_eq!(call_ok(&e, &u, "native_asr_transcribe", empty).await, json!([]));
    let bad = json!({"request": {"samplesBase64": wav_payload(), "sampleRate": 16000, "model": "../../etc/passwd"}});
    assert!(msg(call(&e, &u, "native_asr_transcribe", bad).await.unwrap_err()).starts_with("Invalid model name"));
    let missing = json!({"request": {"samplesBase64": wav_payload(), "sampleRate": 16000, "model": "large-v3"}});
    assert!(msg(call(&e, &u, "native_asr_transcribe", missing).await.unwrap_err()).contains("not installed"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn asr_jobs_are_taken_round_robin_across_users() {
    let e = Arc::new(env());
    set_sleep(&e, "0.5");
    let a = user(&e, "ua", false, 0);
    let b = user(&e, "ub", false, 0);
    let mut handles = Vec::new();
    // a1 starts; a2, a3 queue; then b1 arrives: b1 must run before a3.
    let mut queued = HashMap::new();
    for (ctx, tag) in [(&a, "a1"), (&a, "a2"), (&a, "a3"), (&b, "b1")] {
        let (env, ctx) = (e.clone(), ctx.clone());
        let user_id = ctx.user_id.clone();
        handles.push(tokio::spawn(async move {
            dispatch(&env.engine, &ctx, "native_asr_transcribe", Body::Json(transcribe_args(tag))).await.map(|_| ())
        }));
        if tag == "a1" {
            wait_for_log(&e, "start a1").await;
        } else {
            let want = queued.entry(user_id.clone()).or_insert(0usize);
            *want += 1;
            wait_queued(&e, &user_id, *want).await;
        }
    }
    for h in handles {
        h.await.unwrap().unwrap_or_else(|err| panic!("job failed: {}", msg(err)));
    }
    let starts: Vec<String> = log_lines(&e).into_iter().filter(|l| l.starts_with("start ")).collect();
    assert_eq!(starts, ["start a1", "start a2", "start b1", "start a3"]);
    // Strictly one child at a time: every start is followed by its own end.
    let log = log_lines(&e);
    for pair in log.chunks(2) {
        assert_eq!(pair[0].replace("start", "end"), pair[1], "{log:?}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancel_only_stops_the_callers_jobs() {
    let e = Arc::new(env());
    set_sleep(&e, "1");
    let a = user(&e, "ua", false, 0);
    let b = user(&e, "ub", false, 0);
    let spawn_job = |ctx: &UserCtx, tag: &'static str| {
        let (env, ctx) = (e.clone(), ctx.clone());
        tokio::spawn(async move { dispatch(&env.engine, &ctx, "native_asr_transcribe", Body::Json(transcribe_args(tag))).await.map(|_| ()) })
    };
    let a1 = spawn_job(&a, "a1");
    wait_for_log(&e, "start a1").await;
    let a2 = spawn_job(&a, "a2");
    wait_queued(&e, "ua", 1).await;
    let b1 = spawn_job(&b, "b1");
    wait_queued(&e, "ub", 1).await;

    // B cancelling never touches A's running or queued job.
    call_ok(&e, &b, "native_asr_cancel", json!({})).await;
    assert_eq!(msg(b1.await.unwrap().unwrap_err()), "Transcription cancelled");
    a1.await.unwrap().unwrap_or_else(|err| panic!("a1: {}", msg(err)));
    a2.await.unwrap().unwrap_or_else(|err| panic!("a2: {}", msg(err)));
    assert!(log_lines(&e).contains(&"end a1".to_string()) && log_lines(&e).contains(&"end a2".to_string()));
    assert!(!log_lines(&e).iter().any(|l| l.contains("b1")));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancelling_kills_the_running_job_and_lets_the_next_user_run() {
    let e = Arc::new(env());
    set_sleep(&e, "30");
    let a = user(&e, "ua", false, 0);
    let b = user(&e, "ub", false, 0);
    let (env_a, ctx_a) = (e.clone(), a.clone());
    let a1 = tokio::spawn(async move { dispatch(&env_a.engine, &ctx_a, "native_asr_transcribe", Body::Json(transcribe_args("a1"))).await.map(|_| ()) });
    wait_for_log(&e, "start a1").await;
    let a2 = {
        let (env, ctx) = (e.clone(), a.clone());
        tokio::spawn(async move { dispatch(&env.engine, &ctx, "native_asr_transcribe", Body::Json(transcribe_args("a2"))).await.map(|_| ()) })
    };
    let b1 = {
        let (env, ctx) = (e.clone(), b.clone());
        tokio::spawn(async move { dispatch(&env.engine, &ctx, "native_asr_transcribe", Body::Json(transcribe_args("b1"))).await.map(|_| ()) })
    };
    wait_queued(&e, "ua", 1).await;
    wait_queued(&e, "ub", 1).await;
    set_sleep(&e, "0"); // b1 will be quick once it gets its turn
    call_ok(&e, &a, "native_asr_cancel", json!({})).await;
    assert_eq!(msg(a1.await.unwrap().unwrap_err()), "Transcription cancelled");
    assert_eq!(msg(a2.await.unwrap().unwrap_err()), "Transcription cancelled");
    b1.await.unwrap().unwrap_or_else(|err| panic!("b1: {}", msg(err)));
    let log = log_lines(&e);
    assert!(log.contains(&"end b1".to_string()), "{log:?}");
    assert!(!log.contains(&"end a1".to_string()) && !log.iter().any(|l| l == "start a2"), "{log:?}");
}

#[tokio::test]
async fn model_download_is_admin_only_and_progress_is_shared() {
    let e = env();
    let admin = user(&e, "root", true, 0);
    let member = user(&e, "m1", false, 0);
    // A local file server stands in for Hugging Face.
    let mirror = e.root.join("mirror");
    std::fs::create_dir_all(&mirror).unwrap();
    std::fs::write(mirror.join("ggml-tiny.bin"), vec![9u8; 4096]).unwrap();
    std::env::set_var("LT_MODEL_BASE_URL", format!("file://{}", mirror.display()));
    assert!(matches!(
        call(&e, &member, "native_asr_download_model", json!({"name": "tiny"})).await.unwrap_err(),
        CommandError::Forbidden(_)
    ));
    assert_eq!(call_ok(&e, &member, "native_asr_download_progress", json!({"name": "tiny"})).await["done"], false);
    call_ok(&e, &admin, "native_asr_download_model", json!({"name": "tiny"})).await;
    std::env::remove_var("LT_MODEL_BASE_URL");
    // Everyone sees the shared result.
    let progress = call_ok(&e, &member, "native_asr_download_progress", json!({"name": "tiny"})).await;
    assert_eq!(progress["done"], true);
    assert_eq!(progress["received"], 4096);
    let models = call_ok(&e, &member, "native_asr_models", json!({})).await;
    assert!(models.as_array().unwrap().iter().any(|m| m["name"] == "tiny" && m["installed"] == true));
    assert!(call(&e, &admin, "native_asr_download_model", json!({"name": "../evil"})).await.is_err());
    assert!(call(&e, &member, "native_asr_download_progress", json!({"name": "../evil"})).await.is_err());
    assert!(!e.engine.config.data_dir.join("models/ggml-tiny.bin.part").exists());
}

// --- live ---------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn live_slots_are_per_user_and_capped_server_wide() {
    let e = Arc::new(env());
    set_sleep(&e, "1");
    let users: Vec<UserCtx> = (0..3).map(|n| user(&e, &format!("u{n}"), false, 0)).collect();
    let spawn_live = |ctx: &UserCtx, tag: &'static str| {
        let (env, ctx) = (e.clone(), ctx.clone());
        tokio::spawn(async move { dispatch(&env.engine, &ctx, "native_live_transcribe", Body::Json(live_args(tag))).await })
    };
    let l0 = spawn_live(&users[0], "l0");
    let l1 = spawn_live(&users[1], "l1");
    wait_for_log(&e, "start l0").await;
    wait_for_log(&e, "start l1").await;
    // A third user, and a second request of the same user, are told it is busy.
    let busy = call(&e, &users[2], "native_live_transcribe", live_args("l2")).await.unwrap_err();
    assert_eq!(msg(busy), "Live transcription is busy on this server");
    let busy = call(&e, &users[0], "native_live_transcribe", live_args("l0b")).await.unwrap_err();
    assert_eq!(msg(busy), "Live transcription is busy on this server");
    assert!(l0.await.unwrap().is_ok() && l1.await.unwrap().is_ok());
    // Slots are free again.
    assert!(call(&e, &users[2], "native_live_transcribe", live_args("l2")).await.is_ok());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn live_cancel_only_reaches_the_callers_slot() {
    let e = Arc::new(env());
    set_sleep(&e, "1");
    let a = user(&e, "ua", false, 0);
    let b = user(&e, "ub", false, 0);
    let spawn_live = |ctx: &UserCtx, tag: &'static str| {
        let (env, ctx) = (e.clone(), ctx.clone());
        tokio::spawn(async move { dispatch(&env.engine, &ctx, "native_live_transcribe", Body::Json(live_args(tag))).await })
    };
    let la = spawn_live(&a, "la");
    let lb = spawn_live(&b, "lb");
    wait_for_log(&e, "start la").await;
    wait_for_log(&e, "start lb").await;
    call_ok(&e, &a, "native_live_cancel", json!({})).await;
    assert!(la.await.unwrap().is_err());
    assert!(lb.await.unwrap().is_ok());
    // A whole-file cancel does not touch live runs either.
    let lb2 = spawn_live(&b, "lb2");
    wait_for_log(&e, "start lb2").await;
    call_ok(&e, &b, "native_asr_cancel", json!({})).await;
    assert!(lb2.await.unwrap().is_ok());
}

// --- diarization -----------------------------------------------------------------

async fn diarize(e: &Env, ctx: &UserCtx, speakers: Option<&str>) -> Result<Value, CommandError> {
    let mut headers = HashMap::new();
    if let Some(n) = speakers {
        headers.insert("x-num-speakers".to_string(), n.to_string());
    }
    let wav = STANDARD.decode(wav_payload()).unwrap();
    match dispatch(&e.engine, ctx, "native_diarize_run", Body::Raw { bytes: wav, headers }).await? {
        Reply::Json(v) => Ok(v),
        Reply::Recording(_) => panic!("expected JSON"),
    }
}

#[tokio::test]
async fn diarize_status_run_and_progress() {
    let e = env();
    let a = user(&e, "ua", false, 0);
    let b = user(&e, "ub", false, 0);
    assert_eq!(call_ok(&e, &a, "native_diarize_status", json!({})).await["available"], true);
    assert_eq!(call_ok(&e, &a, "native_diarize_progress", json!({})).await, json!(0.0));
    let turns = diarize(&e, &a, Some("2")).await.unwrap();
    assert_eq!(turns, "0.000 -- 1.500 speaker_00\n1.500 -- 3.000 speaker_01");
    assert_eq!(call_ok(&e, &a, "native_diarize_progress", json!({})).await, json!(100.0));
    assert_eq!(call_ok(&e, &b, "native_diarize_progress", json!({})).await, json!(0.0)); // per user
    // Not a WAV / not raw.
    let err = dispatch(&e.engine, &a, "native_diarize_run", Body::Raw { bytes: b"nope".to_vec(), headers: HashMap::new() }).await;
    assert_eq!(msg(err.err().unwrap()), "The audio is not a WAV file.");
    assert!(call(&e, &a, "native_diarize_run", json!({})).await.is_err());
    assert!(std::fs::read_dir(e.engine.config.data_dir.join("tmp")).map(|d| d.count()).unwrap_or(0) == 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn diarize_cancel_is_per_user_and_runs_do_not_overlap() {
    let e = Arc::new(env());
    std::fs::write(e.root.join("diarize/sleep"), "30").unwrap();
    let a = user(&e, "ua", false, 0);
    let b = user(&e, "ub", false, 0);
    let (env_a, ctx_a) = (e.clone(), a.clone());
    let run_a = tokio::spawn(async move { diarize(&env_a, &ctx_a, None).await });
    tokio::time::sleep(Duration::from_millis(400)).await;
    // The same user cannot start a second run.
    assert_eq!(msg(diarize(&e, &a, None).await.unwrap_err()), "Speaker detection is already running.");
    // B cancelling does nothing to A's run…
    call_ok(&e, &b, "native_diarize_cancel", json!({})).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!run_a.is_finished());
    // …A's own cancel stops it.
    call_ok(&e, &a, "native_diarize_cancel", json!({})).await;
    assert_eq!(msg(run_a.await.unwrap().unwrap_err()), "Speaker detection stopped.");
}

#[tokio::test]
async fn diarize_without_a_runtime_reports_it() {
    let e = env();
    let engine = Engine::new(EngineConfig { diarize_dir: None, ..e.engine.config.clone() });
    let u = user(&e, "u1", false, 0);
    let status = match dispatch(&engine, &u, "native_diarize_status", Body::Json(json!({}))).await.unwrap() {
        Reply::Json(v) => v,
        _ => panic!(),
    };
    assert_eq!(status["available"], false);
}

// --- calendar ---------------------------------------------------------------------

#[tokio::test]
async fn calendar_commands_validate_requests() {
    let e = env();
    let u = user(&e, "u1", false, 0);
    let send = |endpoint: &str, method: &str| {
        json!({"request": {"provider": "caldav", "endpoint": endpoint, "contentType": "text/calendar", "body": "x", "useNtlm": false, "method": method}})
    };
    for cmd in ["native_calendar_create", "native_calendar_fetch"] {
        assert!(msg(call(&e, &u, cmd, send("file:///etc/passwd", "PUT")).await.unwrap_err()).contains("non-HTTP"));
        assert!(msg(call(&e, &u, cmd, send("https://cal.example/x", "DELETE")).await.unwrap_err()).contains("method"));
    }
    let test = json!({"request": {"provider": "caldav", "endpoint": "ftp://x", "useNtlm": false}});
    assert!(call(&e, &u, "native_calendar_test", test).await.is_err());
    let probe = json!({"request": {"endpoint": "file:///etc/passwd", "method": "GET"}});
    assert!(call(&e, &u, "native_calendar_probe", probe).await.is_err());
    let probe = json!({"request": {"endpoint": "https://a.example", "method": "DELETE"}});
    assert!(call(&e, &u, "native_calendar_probe", probe).await.is_err());
}

#[tokio::test]
async fn bad_arguments_are_reported_not_panicked() {
    let e = env();
    let u = user(&e, "u1", false, 0);
    assert!(msg(call(&e, &u, "native_recording_list", json!({})).await.unwrap_err()).contains("meetingId"));
    assert!(call(&e, &u, "native_recording_list", json!({"meetingId": 5})).await.is_err());
    assert!(call(&e, &u, "native_settings_set", json!(["x"])).await.is_err());
    assert!(dispatch(&e.engine, &u, "native_recording_list", Body::Raw { bytes: vec![], headers: HashMap::new() }).await.is_err());
}
