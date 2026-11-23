use axum::{
    extract::{Extension, Request, State},
    http::{header, HeaderMap, HeaderValue},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::{
    accounts_db::{now_ms, read_user, Profile, Role, USER_COLUMNS},
    auth::{csrf, oidc, random_token, token_hash, valid_token},
    config::Config,
    ctx::App,
    http::{ApiError, ApiResult},
};

const NAME: &str = "lt_session";

#[derive(Clone)]
pub struct Session {
    pub hash: String,
    pub user: Profile,
    pub csrf: String,
}

pub async fn authenticate(
    State(app): State<App>,
    mut request: Request,
    next: Next,
) -> ApiResult<Response> {
    let token = read_cookie(request.headers(), NAME)
        .filter(|token| valid_token(token))
        .ok_or_else(ApiError::unauthorized)?;
    let session = load(&app, token_hash(token)).await?;
    csrf::check_session(request.method(), request.headers(), &session.csrf)?;
    request.extensions_mut().insert(session);
    Ok(next.run(request).await)
}

pub async fn load(app: &App, hash: String) -> ApiResult<Session> {
    let idle = app.config.session_idle_ms;
    app.db
        .run(move |db| {
            let now = now_ms();
            let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let session = tx
                .query_row(
                    &format!(
                        "SELECT {USER_COLUMNS}, s.csrf, s.expires_at, s.last_seen_at
                      FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?1"
                    ),
                    [&hash],
                    |row| {
                        Ok((
                            read_user(row)?,
                            row.get::<_, String>(9)?,
                            row.get::<_, i64>(10)?,
                            row.get::<_, i64>(11)?,
                        ))
                    },
                )
                .optional()?;
            let Some((user, csrf, expires_at, last_seen_at)) = session else {
                return Err(ApiError::unauthorized());
            };
            if user.disabled || expires_at <= now || last_seen_at <= now - idle {
                tx.execute("DELETE FROM sessions WHERE token_hash = ?1", [&hash])?;
                tx.commit()?;
                return Err(ApiError::unauthorized());
            }
            if now > last_seen_at {
                tx.execute(
                    "UPDATE sessions SET last_seen_at = ?1 WHERE token_hash = ?2",
                    params![now, hash],
                )?;
            }
            tx.commit()?;
            Ok(Session {
                hash,
                user: user.profile,
                csrf,
            })
        })
        .await
}

pub fn create(
    db: &Connection,
    config: &Config,
    user: &Profile,
    now: i64,
    user_agent: Option<String>,
    oidc_logout: Option<&str>,
) -> ApiResult<String> {
    db.execute(
        "DELETE FROM sessions WHERE expires_at <= ?1 OR last_seen_at <= ?2",
        params![now, now - config.session_idle_ms],
    )?;
    let token = random_token();
    let hash = token_hash(&token);
    db.execute(
        "INSERT INTO sessions(token_hash, user_id, csrf, created_at, last_seen_at, expires_at, user_agent)
         VALUES(?1, ?2, ?3, ?4, ?4, ?5, ?6)",
        params![hash, user.id, random_token(), now, now.saturating_add(config.session_ttl_ms), user_agent],
    )?;
    if let Some(logout) = oidc_logout {
        db.execute(
            "INSERT INTO session_oidc(token_hash, logout) VALUES(?1, ?2)",
            params![hash, logout],
        )?;
    }
    db.execute(
        "UPDATE users SET last_login_at = ?1 WHERE id = ?2",
        params![now, user.id],
    )?;
    Ok(token)
}

pub fn response(config: &Config, user: Profile, token: &str) -> Response {
    let mut reply = Json(json!({ "user": user })).into_response();
    set_session_cookie(config, token, &mut reply);
    reply
}

pub fn set_session_cookie(config: &Config, token: &str, response: &mut Response) {
    set_cookie(
        config,
        response,
        NAME,
        token,
        "/",
        config.session_ttl_ms / 1000,
    );
}

pub fn clear_session_cookie(config: &Config, response: &mut Response) {
    set_cookie(config, response, NAME, "", "/", 0);
}

pub fn set_cookie(
    config: &Config,
    response: &mut Response,
    name: &str,
    value: &str,
    path: &str,
    max_age: i64,
) {
    let secure = if config.secure_cookies() {
        "; Secure"
    } else {
        ""
    };
    let cookie =
        format!("{name}={value}; Path={path}; HttpOnly; SameSite=Lax; Max-Age={max_age}{secure}");
    response.headers_mut().append(
        header::SET_COOKIE,
        HeaderValue::from_str(&cookie).expect("cookie format"),
    );
}

pub fn read_cookie<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    let mut values = headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|line| line.split(';'))
        .filter_map(|cookie| cookie.trim().split_once('='))
        .filter_map(|(key, value)| (key == name).then_some(value));
    let value = values.next()?;
    values.next().is_none().then_some(value)
}

pub fn user_agent(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::USER_AGENT)?
        .to_str()
        .ok()
        .map(|ua| ua.chars().take(512).collect())
}

pub fn require_admin(session: &Session) -> ApiResult<()> {
    if session.user.role != Role::Admin {
        return Err(ApiError::forbidden("Admin access is required"));
    }
    Ok(())
}

pub async fn logout(
    State(app): State<App>,
    Extension(session): Extension<Session>,
) -> ApiResult<Response> {
    let logout = app
        .db
        .run(move |db| {
            let tx = db.transaction()?;
            let logout: Option<String> = tx
                .query_row(
                    "SELECT logout FROM session_oidc WHERE token_hash = ?1",
                    [&session.hash],
                    |row| row.get(0),
                )
                .optional()?;
            tx.execute(
                "DELETE FROM sessions WHERE token_hash = ?1",
                [&session.hash],
            )?;
            tx.commit()?;
            Ok(logout)
        })
        .await?;
    let body = match logout.and_then(|value| oidc::logout_url(&app.config, &value)) {
        Some(redirect) => json!({ "redirect": redirect }),
        None => json!({}),
    };
    let mut response = Json(body).into_response();
    clear_session_cookie(&app.config, &mut response);
    Ok(response)
}

pub async fn me(Extension(session): Extension<Session>) -> Json<Value> {
    Json(json!({
        "user": session.user,
        "csrf": session.csrf,
        "capabilities": lt_commands::capabilities(session.user.role == Role::Admin),
    }))
}

pub async fn list(
    State(app): State<App>,
    Extension(session): Extension<Session>,
) -> ApiResult<Json<Vec<Value>>> {
    let idle = app.config.session_idle_ms;
    let sessions = app.db.run(move |db| {
        let now = now_ms();
        let mut statement = db.prepare(
            "SELECT token_hash, created_at, last_seen_at, expires_at, user_agent FROM sessions
             WHERE user_id = ?1 AND expires_at > ?2 AND last_seen_at > ?3 ORDER BY last_seen_at DESC",
        )?;
        let rows = statement.query_map(params![session.user.id, now, now - idle], |row| {
            let hash: String = row.get(0)?;
            Ok(json!({
                "id": &hash[..12],
                "createdAt": row.get::<_, i64>(1)?,
                "lastSeenAt": row.get::<_, i64>(2)?,
                "expiresAt": row.get::<_, i64>(3)?,
                "userAgent": row.get::<_, Option<String>>(4)?,
                "current": hash == session.hash,
            }))
        })?.collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }).await?;
    Ok(Json(sessions))
}

pub async fn revoke(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> ApiResult<Response> {
    if !short_id(&id) {
        return Err(ApiError::not_found("Session not found"));
    }
    let current = session.hash.starts_with(&id);
    app.db
        .run(move |db| {
            if db.execute(
                "DELETE FROM sessions WHERE user_id = ?1 AND substr(token_hash, 1, 12) = ?2",
                params![session.user.id, id],
            )? == 0
            {
                return Err(ApiError::not_found("Session not found"));
            }
            Ok(())
        })
        .await?;
    let mut response = Json(Value::Null).into_response();
    if current {
        clear_session_cookie(&app.config, &mut response);
    }
    Ok(response)
}

pub fn short_id(id: &str) -> bool {
    id.len() == 12
        && id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}
