use std::{
    fs::{self, OpenOptions},
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{bail, Context, Result};
use rusqlite::{backup::Backup, params, Connection, OptionalExtension, Row, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    auth::random_hex,
    http::{blocking, ApiError, ApiResult},
};

const SCHEMA_VERSION: i64 = 1;

const SCHEMA: &str = "
CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin', 'member')),
    auth TEXT NOT NULL CHECK(auth IN ('local', 'oidc')),
    oidc_issuer TEXT, oidc_sub TEXT, password_hash TEXT,
    disabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_login_at INTEGER,
    UNIQUE (oidc_issuer, oidc_sub)
);
CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL, user_agent TEXT
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE session_oidc (
    token_hash TEXT PRIMARY KEY REFERENCES sessions(token_hash) ON DELETE CASCADE,
    logout TEXT NOT NULL
);
CREATE TABLE invites (
    token_hash TEXT PRIMARY KEY, email TEXT NOT NULL COLLATE NOCASE,
    role TEXT NOT NULL CHECK(role IN ('admin', 'member')), created_by TEXT NOT NULL,
    expires_at INTEGER NOT NULL, used_at INTEGER
);
CREATE TABLE audit (
    id INTEGER PRIMARY KEY, at INTEGER NOT NULL, user_id TEXT, actor_id TEXT,
    action TEXT NOT NULL, detail TEXT
);
CREATE TABLE login_failures (
    email TEXT NOT NULL COLLATE NOCASE, ip TEXT NOT NULL, at INTEGER NOT NULL
);
CREATE INDEX login_failures_key ON login_failures(email, ip, at);
CREATE INDEX login_failures_at ON login_failures(at);
CREATE TABLE server_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL CHECK(json_valid(value)));
";

#[derive(Clone)]
pub struct AccountsDb(Arc<Mutex<Connection>>);

impl AccountsDb {
    pub fn open(data_dir: &Path) -> Result<Self> {
        fs::create_dir_all(data_dir)?;
        let path = data_dir.join("app.db");
        let mut file = OpenOptions::new();
        file.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            file.mode(0o600);
        }
        file.open(&path).context("Open app.db")?;

        let mut conn = Connection::open(&path)?;
        conn.busy_timeout(Duration::from_secs(5))?;
        conn.pragma_update(None, "foreign_keys", true)?;
        let transaction = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let version: i64 =
            transaction.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if version > SCHEMA_VERSION {
            bail!("app.db version {version} is newer than this server supports");
        }
        if version < SCHEMA_VERSION {
            if path.metadata()?.len() > 0 {
                // A second connection can read the pre-migration snapshot while
                // the immediate transaction keeps other writers out.
                let source = Connection::open(&path)?;
                let file = tempfile::NamedTempFile::new_in(data_dir)?;
                {
                    let mut destination = Connection::open(file.path())?;
                    Backup::new(&source, &mut destination)?.run_to_completion(
                        128,
                        Duration::from_millis(10),
                        None,
                    )?;
                }
                file.as_file().sync_all()?;
                file.persist(data_dir.join(format!("app.db.bak-{version}")))?;
            }
            if version == 0 {
                transaction.execute_batch(SCHEMA)?;
            }
            transaction.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        }
        transaction.commit()?;
        Ok(Self(Arc::new(Mutex::new(conn))))
    }

    pub async fn run<T, F>(&self, operation: F) -> ApiResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> ApiResult<T> + Send + 'static,
    {
        let conn = self.0.clone();
        blocking(move || {
            let mut conn = conn.lock().map_err(ApiError::internal)?;
            operation(&mut conn)
        })
        .await
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, clap::ValueEnum)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Admin,
    Member,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Admin => "admin",
            Self::Member => "member",
        }
    }

    pub fn from_db(value: &str) -> Self {
        if value == "admin" {
            Self::Admin
        } else {
            Self::Member
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthKind {
    Local,
    Oidc,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub email: String,
    pub name: String,
    pub role: Role,
    pub auth: AuthKind,
}

#[derive(Clone)]
pub struct User {
    pub profile: Profile,
    pub disabled: bool,
    pub created_at: i64,
    pub last_login_at: Option<i64>,
    pub password_hash: Option<String>,
}

pub const USER_COLUMNS: &str = "u.id, u.email, u.name, u.role, u.auth, u.disabled, \
                                u.created_at, u.last_login_at, u.password_hash";

pub fn read_user(row: &Row<'_>) -> rusqlite::Result<User> {
    Ok(User {
        profile: Profile {
            id: row.get(0)?,
            email: row.get(1)?,
            name: row.get(2)?,
            role: Role::from_db(row.get::<_, String>(3)?.as_str()),
            auth: if row.get::<_, String>(4)? == "oidc" {
                AuthKind::Oidc
            } else {
                AuthKind::Local
            },
        },
        disabled: row.get(5)?,
        created_at: row.get(6)?,
        last_login_at: row.get(7)?,
        password_hash: row.get(8)?,
    })
}

fn user_where(
    db: &Connection,
    predicate: &str,
    args: impl rusqlite::Params,
) -> ApiResult<Option<User>> {
    let sql = format!("SELECT {USER_COLUMNS} FROM users u WHERE {predicate}");
    Ok(db.query_row(&sql, args, read_user).optional()?)
}

pub fn user_by_id(db: &Connection, id: &str) -> ApiResult<Option<User>> {
    user_where(db, "u.id = ?1", [id])
}

pub fn user_by_email(db: &Connection, email: &str) -> ApiResult<Option<User>> {
    user_where(db, "u.email = ?1", [email])
}

pub fn user_by_oidc(db: &Connection, issuer: &str, sub: &str) -> ApiResult<Option<User>> {
    user_where(db, "u.oidc_issuer = ?1 AND u.oidc_sub = ?2", [issuer, sub])
}

pub fn list_users(db: &Connection) -> ApiResult<Vec<User>> {
    let mut statement = db.prepare(&format!(
        "SELECT {USER_COLUMNS} FROM users u ORDER BY email"
    ))?;
    let users = statement
        .query_map([], read_user)?
        .collect::<rusqlite::Result<_>>()?;
    Ok(users)
}

pub fn has_users(db: &Connection) -> ApiResult<bool> {
    Ok(db.query_row("SELECT EXISTS(SELECT 1 FROM users)", [], |row| row.get(0))?)
}

pub fn guard_last_admin(db: &Connection, user: &User) -> ApiResult<()> {
    if is_last_active_admin(db, user)? {
        return Err(ApiError::bad_request(
            "The last active admin cannot be removed, disabled, or demoted",
        ));
    }
    Ok(())
}

pub fn is_last_active_admin(db: &Connection, user: &User) -> ApiResult<bool> {
    if user.profile.role != Role::Admin || user.disabled {
        return Ok(false);
    }
    Ok(!db.query_row(
        "SELECT EXISTS(SELECT 1 FROM users WHERE id != ?1 AND role = 'admin' AND disabled = 0)",
        [&user.profile.id],
        |row| row.get::<_, bool>(0),
    )?)
}

pub fn has_oidc_admin(db: &Connection, issuer: &str, excluded: Option<&str>) -> ApiResult<bool> {
    Ok(db.query_row(
        "SELECT EXISTS(SELECT 1 FROM users WHERE role = 'admin' AND disabled = 0
         AND auth = 'oidc' AND oidc_issuer = ?1 AND id IS NOT ?2)",
        params![issuer, excluded],
        |row| row.get(0),
    )?)
}

pub fn insert_local(
    db: &Connection,
    email: String,
    name: String,
    password_hash: String,
    role: Role,
    now: i64,
) -> ApiResult<Profile> {
    if user_by_email(db, &email)?.is_some() {
        return Err(ApiError::conflict(
            "An account with this email already exists",
        ));
    }
    let role = if has_users(db)? { role } else { Role::Admin };
    let id = random_hex::<16>();
    db.execute(
        "INSERT INTO users(id, email, name, role, auth, password_hash, created_at)
         VALUES(?1, ?2, ?3, ?4, 'local', ?5, ?6)",
        params![id, email, name, role.as_str(), password_hash, now],
    )?;
    Ok(Profile {
        id,
        email,
        name,
        role,
        auth: AuthKind::Local,
    })
}

pub fn audit(
    db: &Connection,
    now: i64,
    user: Option<&str>,
    actor: Option<&str>,
    action: &str,
    detail: Option<Value>,
) -> ApiResult<()> {
    db.execute(
        "INSERT INTO audit(at, user_id, actor_id, action, detail) VALUES(?1, ?2, ?3, ?4, ?5)",
        params![
            now,
            user,
            actor,
            action,
            detail.map(|value| value.to_string())
        ],
    )?;
    Ok(())
}

pub fn read_setting<T: serde::de::DeserializeOwned>(
    db: &Connection,
    key: &str,
) -> ApiResult<Option<T>> {
    let value: Option<String> = db
        .query_row(
            "SELECT value FROM server_settings WHERE key = ?1",
            [key],
            |row| row.get(0),
        )
        .optional()?;
    value
        .map(|raw| serde_json::from_str(&raw).map_err(ApiError::internal))
        .transpose()
}

pub fn write_setting(db: &Connection, key: &str, value: &impl Serialize) -> ApiResult<()> {
    db.execute(
        "INSERT INTO server_settings(key, value) VALUES(?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![
            key,
            serde_json::to_string(value).map_err(ApiError::internal)?
        ],
    )?;
    Ok(())
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock before Unix epoch")
        .as_millis() as i64
}
