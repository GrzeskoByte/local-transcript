use axum::{
    extract::{Extension, Path, State},
    Json,
};
use rusqlite::{params, Connection, OptionalExtension, Row, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{
    accounts_db::{
        audit, guard_last_admin, list_users as load_users, now_ms, read_setting, user_by_email,
        user_by_id, write_setting, Profile, Role,
    },
    auth::{
        local::{normalize_email, normalize_name},
        random_token, seal,
        session::{self, Session},
        token_hash, unseal,
    },
    config::{parse_issuer, Config, OidcSettings, SettingsPatch, HOUR_MS},
    ctx::App,
    http::{blocking, ApiError, ApiResult, Input},
    users,
};

const OIDC_SECRET_PURPOSE: &[u8] = b"lt-server:oidc-client-secret";
const INVITE_TTL_MS: i64 = 7 * 24 * HOUR_MS;

pub struct EffectiveSettings {
    pub local_login: bool,
    pub oidc: OidcSettings,
    locked: Vec<&'static str>,
}

impl EffectiveSettings {
    pub fn oidc_enabled(&self, config: &Config) -> bool {
        config.public_url.is_some()
            && !self.oidc.issuer.is_empty()
            && !self.oidc.client_id.is_empty()
    }

    fn view(self) -> Value {
        json!({
            "localLogin": self.local_login,
            "oidc": {
                "issuer": self.oidc.issuer,
                "clientId": self.oidc.client_id,
                "clientSecretSet": !self.oidc.client_secret.is_empty(),
                "scopes": self.oidc.scopes,
                "providerName": self.oidc.provider_name,
                "adminGroup": self.oidc.admin_group,
                "groupsClaim": self.oidc.groups_claim,
                "allowedGroups": self.oidc.allowed_groups,
                "allowedDomains": self.oidc.allowed_domains,
            },
            "locked": self.locked,
        })
    }
}

pub fn read_settings(db: &Connection, config: &Config) -> ApiResult<EffectiveSettings> {
    let local = read_setting(db, "localLogin")?.unwrap_or(true);
    let stored = read_setting(db, "oidc")?.unwrap_or_default();
    effective_settings(config, local, stored)
}

fn effective_settings(
    config: &Config,
    local_login: bool,
    mut oidc: OidcSettings,
) -> ApiResult<EffectiveSettings> {
    if !oidc.client_secret.is_empty() && config.settings.oidc.client_secret.is_none() {
        oidc.client_secret = unseal(
            &config.engine.secret_key,
            OIDC_SECRET_PURPOSE,
            &oidc.client_secret,
        )
        .map_err(ApiError::internal)?;
    }
    let mut locked = config.settings.oidc.apply(&mut oidc, None);
    if config.settings.local_login.is_some() {
        locked.push("localLogin");
    }
    Ok(EffectiveSettings {
        local_login: config.settings.local_login.unwrap_or(local_login),
        oidc,
        locked,
    })
}

pub async fn settings(app: &App) -> ApiResult<EffectiveSettings> {
    let config = app.clone();
    app.db
        .run(move |db| read_settings(db, &config.config))
        .await
}

pub async fn auth_config(State(app): State<App>) -> ApiResult<Json<Value>> {
    let settings = settings(&app).await?;
    let sso = settings
        .oidc_enabled(&app.config)
        .then(|| json!({ "name": settings.oidc.provider_name }));
    Ok(Json(
        json!({ "localLogin": settings.local_login, "sso": sso, "inviteOnly": true }),
    ))
}

pub async fn get_settings(State(app): State<App>) -> ApiResult<Json<Value>> {
    Ok(Json(settings(&app).await?.view()))
}

pub async fn put_settings(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Input(patch): Input<SettingsPatch>,
) -> ApiResult<Json<Value>> {
    let _guard = app.account_write.lock().await;
    let actor = refresh_admin(&app, session).await?;
    let config = app.clone();
    let view = app
        .db
        .run(move |db| {
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let env = &config.config.settings;
            if let Some(local_login) = patch.local_login.filter(|_| env.local_login.is_none()) {
                write_setting(&tx, "localLogin", &local_login)?;
            }

            let mut oidc: OidcSettings = read_setting(&tx, "oidc")?.unwrap_or_default();
            let changed = patch.oidc.apply(&mut oidc, Some(&env.oidc));
            if changed.contains(&"oidc.issuer") && !oidc.issuer.is_empty() {
                parse_issuer(&oidc.issuer).map_err(ApiError::bad_request)?;
                if config.config.public_url.is_none() {
                    return Err(ApiError::bad_request(
                        "Set LT_PUBLIC_URL before configuring an OIDC issuer",
                    ));
                }
            }
            if changed.contains(&"oidc.clientSecret") && !oidc.client_secret.is_empty() {
                oidc.client_secret = seal(
                    &config.config.engine.secret_key,
                    OIDC_SECRET_PURPOSE,
                    &oidc.client_secret,
                )
                .map_err(ApiError::internal)?;
            }
            if !changed.is_empty() {
                write_setting(&tx, "oidc", &oidc)?;
            }
            let view = read_settings(&tx, &config.config)?.view();
            audit(
                &tx,
                now_ms(),
                None,
                Some(&actor.id),
                "admin.settings.update",
                None,
            )?;
            tx.commit()?;
            Ok(view)
        })
        .await?;
    Ok(Json(view))
}

pub async fn refresh_admin(app: &App, session: Session) -> ApiResult<Profile> {
    let session = session::load(app, session.hash).await?;
    session::require_admin(&session)?;
    Ok(session.user)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminUser {
    #[serde(flatten)]
    user: Profile,
    disabled: bool,
    created_at: i64,
    last_login_at: Option<i64>,
    bytes: u64,
}

pub async fn list_users(State(app): State<App>) -> ApiResult<Json<Vec<AdminUser>>> {
    let users = app.db.run(|db| load_users(db)).await?;
    let rows = blocking(move || {
        Ok(users
            .into_iter()
            .map(|user| AdminUser {
                bytes: lt_commands::usage_bytes(&app.user_dir(&user.profile.id)),
                user: user.profile,
                disabled: user.disabled,
                created_at: user.created_at,
                last_login_at: user.last_login_at,
            })
            .collect())
    })
    .await?;
    Ok(Json(rows))
}

#[derive(Deserialize)]
pub struct UserPatch {
    role: Option<Role>,
    disabled: Option<bool>,
    name: Option<String>,
}

pub async fn update_user(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Path(id): Path<String>,
    Input(patch): Input<UserPatch>,
) -> ApiResult<Json<Value>> {
    let name = patch.name.as_deref().map(normalize_name).transpose()?;
    let _guard = app.account_write.lock().await;
    let actor = refresh_admin(&app, session).await?;
    app.db
        .run(move |db| {
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let user =
                user_by_id(&tx, &id)?.ok_or_else(|| ApiError::not_found("Account not found"))?;
            let role = patch.role.unwrap_or(user.profile.role);
            let disabled = patch.disabled.unwrap_or(user.disabled);
            if disabled || role != Role::Admin {
                guard_last_admin(&tx, &user)?;
            }
            tx.execute(
                "UPDATE users SET role = ?1, disabled = ?2, name = ?3 WHERE id = ?4",
                params![
                    role.as_str(),
                    disabled,
                    name.as_deref().unwrap_or(&user.profile.name),
                    id
                ],
            )?;
            if disabled {
                tx.execute("DELETE FROM sessions WHERE user_id = ?1", [&id])?;
            }
            audit(
                &tx,
                now_ms(),
                Some(&id),
                Some(&actor.id),
                "admin.user.update",
                Some(json!({ "role": role, "disabled": disabled, "nameChanged": name.is_some() })),
            )?;
            tx.commit()?;
            Ok(())
        })
        .await?;
    Ok(Json(Value::Null))
}

pub async fn delete_user(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    users::delete_account(app, session, users::DeleteAccount::Admin(id)).await?;
    Ok(Json(Value::Null))
}

#[derive(Deserialize)]
pub struct NewInvite {
    email: String,
    role: Role,
}

pub async fn create_invite(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Input(invite): Input<NewInvite>,
) -> ApiResult<Json<Value>> {
    let email = normalize_email(&invite.email)?;
    let _guard = app.account_write.lock().await;
    let actor = refresh_admin(&app, session).await?;
    let token = random_token();
    let hash = token_hash(&token);
    let expires_at = app.db.run(move |db| {
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if user_by_email(&tx, &email)?.is_some() {
            return Err(ApiError::conflict("An account with this email already exists"));
        }
        let now = now_ms();
        let expires_at = now + INVITE_TTL_MS;
        tx.execute(
            "INSERT INTO invites(token_hash, email, role, created_by, expires_at) VALUES(?1, ?2, ?3, ?4, ?5)",
            params![hash, email, invite.role.as_str(), actor.id, expires_at],
        )?;
        audit(&tx, now, None, Some(&actor.id), "admin.invite.create", Some(json!({
            "id": &hash[..12], "email": email, "role": invite.role,
        })))?;
        tx.commit()?;
        Ok(expires_at)
    }).await?;
    let path = format!("/#/invite/{token}");
    let url = app.config.public_url.as_ref().map_or_else(
        || path.clone(),
        |base| base.join(&path).expect("absolute invite path").to_string(),
    );
    Ok(Json(json!({ "url": url, "expiresAt": expires_at })))
}

const INVITE_COLUMNS: &str = "token_hash, email, role, created_by, expires_at, used_at";

fn read_invite(row: &Row<'_>) -> rusqlite::Result<Value> {
    let hash: String = row.get(0)?;
    Ok(json!({
        "id": &hash[..12],
        "email": row.get::<_, String>(1)?,
        "role": row.get::<_, String>(2)?,
        "createdBy": row.get::<_, String>(3)?,
        "expiresAt": row.get::<_, i64>(4)?,
        "usedAt": row.get::<_, Option<i64>>(5)?,
    }))
}

pub async fn list_invites(State(app): State<App>) -> ApiResult<Json<Vec<Value>>> {
    let invites = app
        .db
        .run(|db| {
            let mut statement = db.prepare(&format!(
                "SELECT {INVITE_COLUMNS} FROM invites ORDER BY expires_at DESC"
            ))?;
            let rows = statement
                .query_map([], read_invite)?
                .collect::<rusqlite::Result<_>>()?;
            Ok(rows)
        })
        .await?;
    Ok(Json(invites))
}

pub async fn get_invite(State(app): State<App>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    if !session::short_id(&id) {
        return Err(ApiError::not_found("Invitation not found"));
    }
    let invite = app
        .db
        .run(move |db| {
            db.query_row(
                &format!(
                    "SELECT {INVITE_COLUMNS} FROM invites WHERE substr(token_hash, 1, 12) = ?1"
                ),
                [&id],
                read_invite,
            )
            .optional()?
            .ok_or_else(|| ApiError::not_found("Invitation not found"))
        })
        .await?;
    Ok(Json(invite))
}

pub async fn delete_invite(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    if !session::short_id(&id) {
        return Err(ApiError::not_found("Invitation not found"));
    }
    let _guard = app.account_write.lock().await;
    let actor = refresh_admin(&app, session).await?;
    app.db
        .run(move |db| {
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            if tx.execute(
                "DELETE FROM invites WHERE substr(token_hash, 1, 12) = ?1",
                [&id],
            )? == 0
            {
                return Err(ApiError::not_found("Invitation not found"));
            }
            audit(
                &tx,
                now_ms(),
                None,
                Some(&actor.id),
                "admin.invite.delete",
                Some(json!({ "id": id })),
            )?;
            tx.commit()?;
            Ok(())
        })
        .await?;
    Ok(Json(Value::Null))
}

#[derive(Deserialize)]
pub struct AuditQuery {
    limit: Option<u32>,
}

pub async fn list_audit(
    State(app): State<App>,
    query: Result<axum::extract::Query<AuditQuery>, axum::extract::rejection::QueryRejection>,
) -> ApiResult<Json<Vec<Value>>> {
    let axum::extract::Query(query) =
        query.map_err(|_| ApiError::bad_request("Invalid audit limit"))?;
    let limit = query.limit.unwrap_or(200).min(1000);
    let rows = app.db.run(move |db| {
        let mut statement = db.prepare("SELECT id, at, user_id, actor_id, action, detail FROM audit ORDER BY id DESC LIMIT ?1")?;
        let rows = statement.query_map([limit], |row| {
            let detail: Option<String> = row.get(5)?;
            Ok(json!({
                "id": row.get::<_, i64>(0)?,
                "at": row.get::<_, i64>(1)?,
                "userId": row.get::<_, Option<String>>(2)?,
                "actorId": row.get::<_, Option<String>>(3)?,
                "action": row.get::<_, String>(4)?,
                "detail": detail.and_then(|value| serde_json::from_str::<Value>(&value).ok()),
            }))
        })?.collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }).await?;
    Ok(Json(rows))
}
