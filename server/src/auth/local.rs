use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use axum::{
    extract::{ConnectInfo, Extension, State},
    http::{HeaderMap, StatusCode},
    response::Response,
    Json,
};
use rand::rngs::OsRng;
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    accounts_db::{
        audit, has_users, insert_local, now_ms, user_by_email, user_by_id, AccountsDb, AuthKind,
        Profile, Role,
    },
    admin,
    auth::{
        csrf,
        session::{self, Session},
        token_hash, valid_token,
    },
    ctx::App,
    http::{blocking, ApiError, ApiResult, Input},
};

const WINDOW_MS: i64 = 15 * 60 * 1000;
const FAILURES_LIMIT: i64 = 5;
// Verify unknown and non-local accounts with the same Argon2 cost.
const DUMMY_HASH: &str = "$argon2id$v=19$m=19456,t=2,p=1$c29tZS1zYWx0LXZhbHVl$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

pub fn normalize_email(email: &str) -> ApiResult<String> {
    let email = email.trim().to_ascii_lowercase();
    if !email
        .rsplit_once('@')
        .is_some_and(|(user, domain)| !user.is_empty() && !user.contains('@') && !domain.is_empty())
        || email.len() > 254
        || email
            .chars()
            .any(|ch| ch.is_control() || ch.is_whitespace())
    {
        return Err(ApiError::bad_request("Enter a valid email address"));
    }
    Ok(email)
}

pub fn normalize_name(name: &str) -> ApiResult<String> {
    let name = name.trim();
    if name.is_empty() || name.len() > 256 || name.chars().any(char::is_control) {
        return Err(ApiError::bad_request(
            "Enter a name between 1 and 256 bytes",
        ));
    }
    Ok(name.to_owned())
}

async fn hash_password(app: &App, password: String) -> ApiResult<String> {
    let permit = app
        .password_slots
        .clone()
        .acquire_owned()
        .await
        .map_err(ApiError::internal)?;
    blocking(move || {
        let _permit = permit;
        hash_password_sync(&password)
    })
    .await
}

fn hash_password_sync(password: &str) -> ApiResult<String> {
    if password.is_empty() || password.len() > 1024 {
        return Err(ApiError::bad_request(
            "Enter a password between 1 and 1024 bytes",
        ));
    }
    let salt = SaltString::generate(&mut OsRng);
    Ok(Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map_err(ApiError::internal)?
        .to_string())
}

async fn verify_password(app: &App, password: String, hash: Option<String>) -> ApiResult<bool> {
    if password.len() > 1024 {
        return Ok(false);
    }
    let permit = app
        .password_slots
        .clone()
        .acquire_owned()
        .await
        .map_err(ApiError::internal)?;
    blocking(move || {
        let _permit = permit;
        let parsed =
            PasswordHash::new(hash.as_deref().unwrap_or(DUMMY_HASH)).map_err(ApiError::internal)?;
        let valid = Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok();
        Ok(valid && hash.is_some())
    })
    .await
}

#[derive(Deserialize)]
pub struct Login {
    email: String,
    password: String,
}

pub async fn login(
    State(app): State<App>,
    connection: Option<Extension<ConnectInfo<SocketAddr>>>,
    headers: HeaderMap,
    Input(body): Input<Login>,
) -> ApiResult<Response> {
    csrf::check_origin(&app.config, &headers)?;
    if !admin::settings(&app).await?.local_login {
        return Err(ApiError::forbidden("Local sign-in is disabled"));
    }
    let ip = connection.map_or(
        IpAddr::V4(Ipv4Addr::UNSPECIFIED),
        |Extension(ConnectInfo(peer))| peer.ip().to_canonical(),
    );
    let email = body.email.trim().to_ascii_lowercase();
    if email.len() > 254 {
        return Err(invalid_login());
    }
    let _attempt = app.logins.get((email.clone(), ip)).lock_owned().await;
    let ip = ip.to_string();
    let rate_email = email.clone();
    let rate_ip = ip.clone();
    let user = app
        .db
        .run(move |db| {
            let attempts: i64 = db.query_row(
                "SELECT count(*) FROM login_failures WHERE email = ?1 AND ip = ?2 AND at > ?3",
                params![rate_email, rate_ip, now_ms() - WINDOW_MS],
                |row| row.get(0),
            )?;
            if attempts >= FAILURES_LIMIT {
                return Err(ApiError::new(
                    StatusCode::TOO_MANY_REQUESTS,
                    "Too many failed attempts. Try again in 15 minutes.",
                ));
            }
            user_by_email(db, &rate_email)
        })
        .await?;
    let password_hash = user.as_ref().and_then(|user| user.password_hash.clone());
    let verified = verify_password(&app, body.password, password_hash.clone()).await?;
    let user_id = user.map(|user| user.profile.id);
    let user_agent = session::user_agent(&headers);
    let config = app.clone();
    let result = app
        .db
        .run(move |db| {
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let now = now_ms();
            let candidate = match &user_id {
                Some(id) if verified && admin::read_settings(&tx, &config.config)?.local_login => {
                    user_by_id(&tx, id)?
                }
                _ => None,
            };
            let user = candidate.filter(|user| {
                !user.disabled
                    && user.profile.auth == AuthKind::Local
                    && user.password_hash == password_hash
            });
            let Some(user) = user else {
                tx.execute(
                    "DELETE FROM login_failures WHERE at <= ?1",
                    [now - WINDOW_MS],
                )?;
                tx.execute(
                    "INSERT INTO login_failures(email, ip, at) VALUES (?1, ?2, ?3)",
                    params![email, ip, now],
                )?;
                audit(
                    &tx,
                    now,
                    user_id.as_deref(),
                    None,
                    "login.failed",
                    Some(json!({ "email": email, "ip": ip })),
                )?;
                tx.commit()?;
                return Err(invalid_login());
            };
            tx.execute(
                "DELETE FROM login_failures WHERE email = ?1 AND ip = ?2",
                params![email, ip],
            )?;
            let token = session::create(&tx, &config.config, &user.profile, now, user_agent, None)?;
            audit(
                &tx,
                now,
                Some(&user.profile.id),
                Some(&user.profile.id),
                "login",
                Some(json!({ "method": "local" })),
            )?;
            tx.commit()?;
            Ok((user.profile, token))
        })
        .await?;
    Ok(session::response(&app.config, result.0, &result.1))
}

fn invalid_login() -> ApiError {
    ApiError::new(StatusCode::UNAUTHORIZED, "Invalid email or password")
}

#[derive(Deserialize)]
pub struct AcceptInvite {
    token: String,
    name: String,
    password: String,
}

pub async fn accept_invite(
    State(app): State<App>,
    headers: HeaderMap,
    Input(body): Input<AcceptInvite>,
) -> ApiResult<Response> {
    csrf::check_origin(&app.config, &headers)?;
    if !admin::settings(&app).await?.local_login {
        return Err(ApiError::forbidden("Local sign-in is disabled"));
    }
    if !valid_token(&body.token) {
        return Err(invalid_invite());
    }
    let hash = token_hash(&body.token);
    let lookup = hash.clone();
    app.db.run(move |db| {
        if !db.query_row(
            "SELECT EXISTS(SELECT 1 FROM invites WHERE token_hash = ?1 AND expires_at > ?2 AND used_at IS NULL)",
            params![lookup, now_ms()], |row| row.get::<_, bool>(0),
        )? {
            return Err(invalid_invite());
        }
        Ok(())
    }).await?;
    let name = normalize_name(&body.name)?;
    let password = hash_password(&app, body.password).await?;
    let config = app.clone();
    let user_agent = session::user_agent(&headers);
    let (user, token) = app.db.run(move |db| {
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let now = now_ms();
        if !admin::read_settings(&tx, &config.config)?.local_login {
            return Err(ApiError::forbidden("Local sign-in is disabled"));
        }
        let (email, role) = tx.query_row(
            "SELECT email, role FROM invites WHERE token_hash = ?1 AND expires_at > ?2 AND used_at IS NULL",
            params![hash, now],
            |row| Ok((row.get::<_, String>(0)?, Role::from_db(&row.get::<_, String>(1)?)))
        ).optional()?.ok_or_else(invalid_invite)?;
        let user = insert_local(&tx, email, name, password, role, now)?;
        tx.execute("UPDATE invites SET used_at = ?1 WHERE token_hash = ?2", params![now, hash])?;
        let token = session::create(&tx, &config.config, &user, now, user_agent, None)?;
        audit(&tx, now, Some(&user.id), Some(&user.id), "login", Some(json!({ "method": "invite" })))?;
        tx.commit()?;
        Ok((user, token))
    }).await?;
    Ok(session::response(&app.config, user, &token))
}

fn invalid_invite() -> ApiError {
    ApiError::bad_request("This invitation is invalid, expired, or already used")
}

#[derive(Deserialize)]
pub struct PasswordChange {
    current: String,
    next: String,
}

pub async fn change_password(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Input(body): Input<PasswordChange>,
) -> ApiResult<Json<Value>> {
    if session.user.auth != AuthKind::Local {
        return Err(ApiError::bad_request(
            "Change the password at your sign-in provider",
        ));
    }
    let id = session.user.id.clone();
    let user = app
        .db
        .run(move |db| user_by_id(db, &id))
        .await?
        .ok_or_else(ApiError::unauthorized)?;
    if !verify_password(&app, body.current, user.password_hash.clone()).await? {
        return Err(ApiError::bad_request("The current password is incorrect"));
    }
    let password = hash_password(&app, body.next).await?;
    let session = session::load(&app, session.hash).await?;
    app.db.run(move |db| {
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if tx.execute(
            "UPDATE users SET password_hash = ?1 WHERE id = ?2 AND password_hash = ?3 AND disabled = 0",
            params![password, session.user.id, user.password_hash],
        )? == 0 {
            return Err(ApiError::conflict("The account changed. Sign in again"));
        }
        tx.execute(
            "DELETE FROM sessions WHERE user_id = ?1 AND token_hash != ?2",
            params![session.user.id, session.hash],
        )?;
        audit(&tx, now_ms(), Some(&session.user.id), Some(&session.user.id), "password.change", None)?;
        tx.commit()?;
        Ok(())
    }).await?;
    Ok(Json(Value::Null))
}

pub async fn create_account(
    db: &AccountsDb,
    email: String,
    name: String,
    password: String,
    role: Role,
    bootstrap: bool,
) -> ApiResult<Option<Profile>> {
    if bootstrap && db.run(|db| has_users(db)).await? {
        return Ok(None);
    }
    let email = normalize_email(&email)?;
    let name = normalize_name(&name)?;
    let hash = blocking(move || hash_password_sync(&password)).await?;
    db.run(move |db| {
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if bootstrap && has_users(&tx)? {
            return Ok(None);
        }
        let now = now_ms();
        let user = insert_local(&tx, email, name, hash, role, now)?;
        let action = if bootstrap {
            "admin.bootstrap"
        } else {
            "admin.create"
        };
        audit(
            &tx,
            now,
            Some(&user.id),
            None,
            action,
            Some(json!({ "role": user.role })),
        )?;
        tx.commit()?;
        Ok(Some(user))
    })
    .await
}

pub async fn reset_password(db: &AccountsDb, email: String, password: String) -> ApiResult<()> {
    let email = normalize_email(&email)?;
    let hash = blocking(move || hash_password_sync(&password)).await?;
    db.run(move |db| {
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let user =
            user_by_email(&tx, &email)?.ok_or_else(|| ApiError::not_found("Account not found"))?;
        if user.profile.auth != AuthKind::Local {
            return Err(ApiError::bad_request(
                "Change the password at the account's sign-in provider",
            ));
        }
        tx.execute(
            "UPDATE users SET password_hash = ?1 WHERE id = ?2",
            params![hash, user.profile.id],
        )?;
        tx.execute(
            "DELETE FROM sessions WHERE user_id = ?1",
            [&user.profile.id],
        )?;
        tx.execute("DELETE FROM login_failures WHERE email = ?1", [&email])?;
        audit(
            &tx,
            now_ms(),
            Some(&user.profile.id),
            None,
            "admin.password.reset",
            None,
        )?;
        tx.commit()?;
        Ok(())
    })
    .await
}
