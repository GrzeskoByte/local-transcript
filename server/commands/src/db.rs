//! Per-user meeting database (`<user_dir>/meetings.db`) behind the `server_db_*`
//! commands. It replaces the webview's IndexedDB in server mode: the values are
//! the frontend's own JSON objects, stored whole.
//!
//! Tables: `meetings(id PK, json)`, `segments(id PK, meeting_id indexed, json)`,
//! `kv(key PK, json)`.
use std::path::Path;
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::{Map, Value};

use crate::util::Args;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS meetings(id TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS segments(id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS segments_by_meeting ON segments(meeting_id);
CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, json TEXT NOT NULL);
";

fn sql(e: rusqlite::Error) -> String {
    format!("Database error: {e}")
}

pub fn db_path(user_dir: &Path) -> std::path::PathBuf {
    user_dir.join("meetings.db")
}

pub fn open(user_dir: &Path) -> Result<Connection, String> {
    std::fs::create_dir_all(user_dir).map_err(|e| format!("Could not create the user folder: {e}"))?;
    let conn = Connection::open(db_path(user_dir)).map_err(sql)?;
    conn.busy_timeout(Duration::from_secs(10)).map_err(sql)?;
    // WAL persists in the file; `query_row` because the pragma returns a row.
    let _: String = conn.query_row("PRAGMA journal_mode=WAL", [], |r| r.get(0)).map_err(sql)?;
    conn.pragma_update(None, "synchronous", "NORMAL").map_err(sql)?;
    conn.execute_batch(SCHEMA).map_err(sql)?;
    Ok(conn)
}

#[derive(Clone, Copy, PartialEq)]
enum Store {
    Meetings,
    Segments,
    Kv,
}

impl Store {
    fn parse(name: &str) -> Result<Self, String> {
        match name {
            "meetings" => Ok(Self::Meetings),
            "segments" => Ok(Self::Segments),
            "kv" => Ok(Self::Kv),
            _ => Err(format!("Unknown store: {name}")),
        }
    }

    fn table(self) -> &'static str {
        match self {
            Self::Meetings => "meetings",
            Self::Segments => "segments",
            Self::Kv => "kv",
        }
    }

    fn key_column(self) -> &'static str {
        if self == Self::Kv { "key" } else { "id" }
    }

    /// The key field of a stored object (`id`, or `key` for kv).
    fn key_of(self, value: &Value) -> Result<String, String> {
        let field = self.key_column();
        value
            .get(field)
            .and_then(Value::as_str)
            .filter(|k| !k.is_empty())
            .map(str::to_string)
            .ok_or_else(|| format!("The value has no string `{field}`."))
    }
}

fn text(value: &Value) -> Result<String, String> {
    serde_json::to_string(value).map_err(|e| format!("Could not encode the value: {e}"))
}

fn parse(json: String) -> Result<Value, String> {
    serde_json::from_str(&json).map_err(|e| format!("Stored value is damaged: {e}"))
}

fn put_in(tx: &Transaction<'_>, store: Store, value: &Value) -> Result<(), String> {
    if !value.is_object() {
        return Err("Only objects can be stored.".into());
    }
    let key = store.key_of(value)?;
    let json = text(value)?;
    if store == Store::Segments {
        let meeting_id = value
            .get("meetingId")
            .and_then(Value::as_str)
            .ok_or("The segment has no string `meetingId`.")?;
        tx.execute(
            "INSERT INTO segments(id, meeting_id, json) VALUES(?1, ?2, ?3)
             ON CONFLICT(id) DO UPDATE SET meeting_id = excluded.meeting_id, json = excluded.json",
            params![key, meeting_id, json],
        )
        .map_err(sql)?;
    } else {
        tx.execute(
            &format!(
                "INSERT INTO {t}({k}, json) VALUES(?1, ?2) ON CONFLICT({k}) DO UPDATE SET json = excluded.json",
                t = store.table(),
                k = store.key_column()
            ),
            params![key, json],
        )
        .map_err(sql)?;
    }
    Ok(())
}

fn exists(tx: &Transaction<'_>, store: Store, key: &str) -> Result<bool, String> {
    tx.query_row(
        &format!("SELECT 1 FROM {} WHERE {} = ?1", store.table(), store.key_column()),
        [key],
        |_| Ok(()),
    )
    .optional()
    .map(|r| r.is_some())
    .map_err(sql)
}

pub fn get(conn: &Connection, store: &str, key: &str) -> Result<Value, String> {
    let store = Store::parse(store)?;
    let json: Option<String> = conn
        .query_row(
            &format!("SELECT json FROM {} WHERE {} = ?1", store.table(), store.key_column()),
            [key],
            |r| r.get(0),
        )
        .optional()
        .map_err(sql)?;
    json.map(parse).transpose().map(|v| v.unwrap_or(Value::Null))
}

fn collect(conn: &Connection, query: &str, bind: &[&dyn rusqlite::ToSql]) -> Result<Vec<Value>, String> {
    let mut stmt = conn.prepare(query).map_err(sql)?;
    let rows = stmt.query_map(bind, |r| r.get::<_, String>(0)).map_err(sql)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(parse(row.map_err(sql)?)?);
    }
    Ok(out)
}

pub fn get_all(conn: &Connection, store: &str) -> Result<Vec<Value>, String> {
    let store = Store::parse(store)?;
    collect(conn, &format!("SELECT json FROM {} ORDER BY {}", store.table(), store.key_column()), &[])
}

pub fn get_by_index(conn: &Connection, store: &str, index: &str, key: &str) -> Result<Vec<Value>, String> {
    if Store::parse(store)? != Store::Segments || !matches!(index, "by-meeting" | "meetingId") {
        return Err(format!("Unknown index {index} on {store}."));
    }
    collect(conn, "SELECT json FROM segments WHERE meeting_id = ?1 ORDER BY id", &[&key])
}

pub fn put(conn: &mut Connection, store: &str, value: &Value) -> Result<(), String> {
    let store = Store::parse(store)?;
    let tx = conn.transaction().map_err(sql)?;
    put_in(&tx, store, value)?;
    tx.commit().map_err(sql)
}

pub fn delete(conn: &Connection, store: &str, key: &str) -> Result<(), String> {
    let store = Store::parse(store)?;
    conn.execute(&format!("DELETE FROM {} WHERE {} = ?1", store.table(), store.key_column()), [key])
        .map_err(sql)?;
    Ok(())
}

/// Replace `value` only when its key already exists (one transaction).
pub fn put_if_exists(conn: &mut Connection, store: &str, value: &Value) -> Result<bool, String> {
    let store = Store::parse(store)?;
    let key = store.key_of(value)?;
    let tx = conn.transaction().map_err(sql)?;
    if !exists(&tx, store, &key)? {
        return Ok(false);
    }
    put_in(&tx, store, value)?;
    tx.commit().map_err(sql)?;
    Ok(true)
}

/// If the meeting exists: replace its segments, then store
/// `{...meeting, ...patch, transcriptionStatus: "completed"}` — all or nothing.
pub fn commit_transcript(
    conn: &mut Connection,
    meeting_id: &str,
    segments: &[Value],
    patch: &Value,
) -> Result<bool, String> {
    let tx = conn.transaction().map_err(sql)?;
    let current: Option<String> = tx
        .query_row("SELECT json FROM meetings WHERE id = ?1", [meeting_id], |r| r.get(0))
        .optional()
        .map_err(sql)?;
    let Some(current) = current else { return Ok(false) };
    let mut meeting = match parse(current)? {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    if let Value::Object(patch) = patch {
        for (k, v) in patch {
            meeting.insert(k.clone(), v.clone());
        }
    }
    meeting.insert("transcriptionStatus".into(), Value::String("completed".into()));
    tx.execute("DELETE FROM segments WHERE meeting_id = ?1", [meeting_id]).map_err(sql)?;
    for segment in segments {
        // The segment belongs to this meeting whatever its own field says.
        let mut segment = segment.clone();
        match segment.as_object_mut() {
            Some(obj) => obj.insert("meetingId".into(), Value::String(meeting_id.to_string())),
            None => return Err("Segments must be objects.".into()),
        };
        put_in(&tx, Store::Segments, &segment)?;
    }
    put_in(&tx, Store::Meetings, &Value::Object(meeting))?;
    tx.commit().map_err(sql)?;
    Ok(true)
}

/// Set `speaker` on the listed segments of a meeting (`{segmentId: speaker}`).
pub fn set_segment_speakers(conn: &mut Connection, meeting_id: &str, speakers: &Map<String, Value>) -> Result<(), String> {
    let tx = conn.transaction().map_err(sql)?;
    let rows: Vec<(String, String)> = {
        let mut stmt = tx.prepare("SELECT id, json FROM segments WHERE meeting_id = ?1").map_err(sql)?;
        let rows = stmt
            .query_map([meeting_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(sql)?;
        rows.collect::<Result<_, _>>().map_err(sql)?
    };
    for (id, json) in rows {
        let Some(speaker) = speakers.get(&id) else { continue };
        let mut value = parse(json)?;
        if let Some(obj) = value.as_object_mut() {
            obj.insert("speaker".into(), speaker.clone());
        }
        tx.execute("UPDATE segments SET json = ?1 WHERE id = ?2", params![text(&value)?, id]).map_err(sql)?;
    }
    tx.commit().map_err(sql)
}

/// The meeting and all its segments, in one transaction.
pub fn delete_meeting(conn: &mut Connection, id: &str) -> Result<(), String> {
    let tx = conn.transaction().map_err(sql)?;
    tx.execute("DELETE FROM segments WHERE meeting_id = ?1", [id]).map_err(sql)?;
    tx.execute("DELETE FROM meetings WHERE id = ?1", [id]).map_err(sql)?;
    tx.commit().map_err(sql)
}

/// `server_db_*` dispatch (`cmd` without the prefix).
pub fn handle(user_dir: &Path, cmd: &str, args: &Args) -> Result<Value, String> {
    let mut conn = open(user_dir)?;
    match cmd {
        "get" => get(&conn, &args.get::<String>("store")?, &key_arg(args)?),
        "get_all" => Ok(Value::Array(get_all(&conn, &args.get::<String>("store")?)?)),
        "get_by_index" => Ok(Value::Array(get_by_index(
            &conn,
            &args.get::<String>("store")?,
            &args.get::<String>("index")?,
            &key_arg(args)?,
        )?)),
        "put" => put(&mut conn, &args.get::<String>("store")?, &args.raw("value")?).map(|_| Value::Null),
        "delete" => delete(&conn, &args.get::<String>("store")?, &key_arg(args)?).map(|_| Value::Null),
        "put_if_exists" => {
            put_if_exists(&mut conn, &args.get::<String>("store")?, &args.raw("value")?).map(Value::Bool)
        }
        "commit_transcript" => {
            let segments: Vec<Value> = args.get("segments")?;
            commit_transcript(&mut conn, &args.get::<String>("meetingId")?, &segments, &args.raw("patch")?)
                .map(Value::Bool)
        }
        "set_segment_speakers" => {
            set_segment_speakers(&mut conn, &args.get::<String>("meetingId")?, &args.get::<Map<String, Value>>("speakers")?)
                .map(|_| Value::Null)
        }
        "delete_meeting" => delete_meeting(&mut conn, &args.get::<String>("id")?).map(|_| Value::Null),
        _ => Err(format!("Unknown command: server_db_{cmd}")),
    }
}

fn key_arg(args: &Args) -> Result<String, String> {
    args.get("key")
}

/// Every stored object, for the account export.
/// (meetings, segments, kv)
pub type Export = (Vec<Value>, Vec<Value>, Vec<Value>);

pub fn export(user_dir: &Path) -> Result<Export, String> {
    if !db_path(user_dir).is_file() {
        return Ok((Vec::new(), Vec::new(), Vec::new()));
    }
    let conn = open(user_dir)?;
    Ok((get_all(&conn, "meetings")?, get_all(&conn, "segments")?, get_all(&conn, "kv")?))
}
