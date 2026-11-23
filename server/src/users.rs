use axum::{
    body::Body,
    extract::{Extension, State},
    http::header,
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    accounts_db::{audit, now_ms, user_by_id},
    admin,
    auth::session::{self, Session},
    ctx::App,
    http::{blocking, ApiError, ApiResult, Input},
};

pub async fn usage(
    State(app): State<App>,
    Extension(session): Extension<Session>,
) -> ApiResult<Json<Value>> {
    let ctx = app.user_ctx(&session.user);
    let bytes = blocking(move || Ok(lt_commands::usage_bytes(&ctx.user_dir))).await?;
    Ok(Json(
        json!({ "bytes": bytes, "quotaBytes": app.config.quota_bytes }),
    ))
}

pub async fn export(
    State(app): State<App>,
    Extension(session): Extension<Session>,
) -> ApiResult<Response> {
    let gate = app.user_data.get(session.user.id.clone());
    let _guard = gate.access.read().await;
    let session = session::load(&app, session.hash).await?;
    let ctx = app.user_ctx(&session.user);
    tokio::fs::create_dir_all(&ctx.user_dir)
        .await
        .map_err(ApiError::internal)?;
    let zip = lt_commands::export_user(&app.engine, &ctx)
        .await
        .map_err(ApiError::bad_request)?;
    Ok((
        [
            (header::CONTENT_TYPE, "application/zip"),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=\"local-transcribe-export.zip\"",
            ),
        ],
        Body::from_stream(tokio_util::io::ReaderStream::new(tokio::fs::File::from_std(zip))),
    )
        .into_response())
}

#[derive(Deserialize)]
pub struct DeleteSelf {
    confirm: String,
}

pub async fn delete_self(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Input(body): Input<DeleteSelf>,
) -> ApiResult<Response> {
    delete_account(app.clone(), session, DeleteAccount::Own(body.confirm)).await?;
    let mut response = Json(Value::Null).into_response();
    session::clear_session_cookie(&app.config, &mut response);
    Ok(response)
}

pub enum DeleteAccount {
    Own(String),
    Admin(String),
}

pub async fn delete_account(app: App, session: Session, request: DeleteAccount) -> ApiResult<()> {
    // Once deletion starts, finish the database work even if the client leaves.
    tokio::spawn(async move {
        let _write = app.account_write.lock().await;
        let session = session::load(&app, session.hash).await?;
        let (id, action) = match request {
            DeleteAccount::Own(email) => {
                if !email.trim().eq_ignore_ascii_case(&session.user.email) {
                    return Err(ApiError::bad_request("Confirm with your account email"));
                }
                (session.user.id.clone(), "user.delete")
            }
            DeleteAccount::Admin(id) => {
                session::require_admin(&session)?;
                (id, "admin.user.delete")
            }
        };
        let lookup = id.clone();
        let config = app.clone();
        let user = app
            .db
            .run(move |db| {
                let user = user_by_id(db, &lookup)?
                    .ok_or_else(|| ApiError::not_found("Account not found"))?;
                admin::guard_last_admin(db, &config.config, &user)?;
                Ok(user)
            })
            .await?;
        let gate = app.user_data.get(id.clone());
        let _deleting = gate.begin_deletion();
        let _guard = gate.access.write().await;
        let ctx = app.user_ctx(&user.profile);
        lt_commands::delete_user_data(&app.engine, &ctx)
            .await
            .map_err(ApiError::bad_request)?;
        app.db
            .run(move |db| {
                let tx = db.transaction()?;
                tx.execute("DELETE FROM users WHERE id = ?1", [&id])?;
                tx.execute(
                    "DELETE FROM invites WHERE email = ?1",
                    [&user.profile.email],
                )?;
                tx.execute(
                    "DELETE FROM login_failures WHERE email = ?1",
                    [&user.profile.email],
                )?;
                audit(
                    &tx,
                    now_ms(),
                    Some(&id),
                    Some(&session.user.id),
                    action,
                    None,
                )?;
                tx.commit()?;
                Ok(())
            })
            .await
    })
    .await
    .map_err(ApiError::internal)?
}
