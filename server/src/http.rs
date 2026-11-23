use axum::{
    body::{to_bytes, Body},
    extract::{DefaultBodyLimit, Extension, FromRequest, Path, Request, State},
    http::{header, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use futures_util::{stream, StreamExt, TryStreamExt};
use lt_commands::{Body as CommandBody, CommandError, Reply};
use serde::de::DeserializeOwned;
use serde_json::json;
use tower::ServiceExt;
use tower_http::services::ServeDir;

use crate::{
    accounts_db::{audit, now_ms, Role},
    admin,
    auth::{
        local, oidc,
        session::{self, Session},
    },
    ctx::App,
    users,
};

const MAX_COMMAND_BYTES: usize = 256 * 1024 * 1024;
const MAX_ASR_BYTES: usize = 64 * 1024 * 1024;
const CSP: &str = "default-src 'self'; connect-src 'self' https:; media-src blob:; \
                   img-src 'self' data: blob:; font-src 'self' data:; \
                   worker-src 'self' blob:; object-src 'none'; base-uri 'none'; \
                   frame-ancestors 'none'; form-action 'self'";

pub fn router(app: App) -> Router {
    let public = Router::new()
        .route(
            "/health",
            get(|| async { Json(json!({ "ok": true, "version": env!("CARGO_PKG_VERSION") })) }),
        )
        .route("/auth/config", get(admin::auth_config))
        .route("/auth/login", post(local::login))
        .route("/auth/invite/accept", post(local::accept_invite));
    let admin = Router::new()
        .route("/users", get(admin::list_users))
        .route(
            "/users/{id}",
            axum::routing::patch(admin::update_user).delete(admin::delete_user),
        )
        .route(
            "/invites",
            get(admin::list_invites).post(admin::create_invite),
        )
        .route(
            "/invites/{id}",
            get(admin::get_invite).delete(admin::delete_invite),
        )
        .route(
            "/settings",
            get(admin::get_settings).put(admin::put_settings),
        )
        .route("/oidc/test", post(oidc::test_provider))
        .route("/audit", get(admin::list_audit))
        .route_layer(middleware::from_fn(admin_only));
    let private = Router::new()
        .route("/me", get(session::me).delete(users::delete_self))
        .route("/auth/logout", post(session::logout))
        .route("/me/password", post(local::change_password))
        .route("/me/sessions", get(session::list))
        .route("/me/sessions/{id}", axum::routing::delete(session::revoke))
        .route("/me/export", get(users::export))
        .route("/me/usage", get(users::usage))
        .route("/invoke/{cmd}", post(invoke))
        .nest("/admin", admin)
        .route_layer(middleware::from_fn_with_state(
            app.clone(),
            session::authenticate,
        ));

    let api = public
        .merge(private)
        .fallback(|| async { ApiError::not_found("API endpoint not found") })
        .method_not_allowed_fallback(|| async {
            ApiError::new(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed")
        })
        .layer(DefaultBodyLimit::max(64 * 1024))
        .layer(middleware::from_fn(json_errors))
        .layer(middleware::from_fn(no_store));
    let oidc = Router::new()
        .route("/start", get(oidc::start))
        .route("/callback", get(oidc::callback))
        .layer(middleware::from_fn(no_store));
    Router::new()
        .nest("/api", api)
        .nest("/auth/oidc", oidc)
        .fallback(static_file)
        .layer(middleware::from_fn(security_headers))
        .with_state(app)
}

async fn admin_only(
    Extension(session): Extension<Session>,
    request: Request,
    next: Next,
) -> ApiResult<Response> {
    session::require_admin(&session)?;
    Ok(next.run(request).await)
}

async fn security_headers(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(CSP),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    response
}

async fn no_store(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn json_errors(request: Request, next: Next) -> Response {
    let response = next.run(request).await;
    let status = response.status();
    if (status.is_client_error() || status.is_server_error())
        && !response
            .headers()
            .get(header::CONTENT_TYPE)
            .is_some_and(|value| value == "application/json")
    {
        return ApiError::new(
            status,
            status.canonical_reason().unwrap_or("Request failed"),
        )
        .into_response();
    }
    response
}

async fn static_file(State(app): State<App>, request: Request) -> ApiResult<Response> {
    let head = request.method() == Method::HEAD;
    if request.method() != Method::GET && !head {
        return Err(ApiError::new(
            StatusCode::METHOD_NOT_ALLOWED,
            "Method not allowed",
        ));
    }
    if !matches!(request.uri().path(), "/" | "/index.html") {
        let response = ServeDir::new(&app.config.static_dir)
            .append_index_html_on_directories(false)
            .oneshot(request)
            .await
            .expect("ServeDir is infallible");
        if response.status() != StatusCode::NOT_FOUND {
            return Ok(response.into_response());
        }
    }
    let mut index = tokio::fs::read_to_string(app.config.static_dir.join("index.html"))
        .await
        .map_err(|err| {
            if err.kind() == std::io::ErrorKind::NotFound {
                ApiError::not_found("Frontend index.html is missing")
            } else {
                ApiError::internal(err)
            }
        })?;
    const MARKER: &str = r#"<meta name="lt-edition" content="server">"#;
    let head_end = index
        .to_ascii_lowercase()
        .find("</head>")
        .ok_or_else(|| ApiError::internal("Frontend index.html has no closing head tag"))?;
    index.insert_str(head_end, MARKER);
    let headers = [
        (header::CONTENT_TYPE, "text/html; charset=utf-8".to_owned()),
        (header::CONTENT_LENGTH, index.len().to_string()),
        (header::CACHE_CONTROL, "no-store".to_owned()),
    ];
    Ok((headers, if head { String::new() } else { index }).into_response())
}

async fn invoke(
    State(app): State<App>,
    Extension(session): Extension<Session>,
    Path(cmd): Path<String>,
    request: Request,
) -> ApiResult<Response> {
    let admin_command = matches!(
        cmd.as_str(),
        "native_asr_download_model" | "native_asr_enable_gpu"
    );
    if admin_command && session.user.role != Role::Admin {
        return Err(ApiError::forbidden("This command requires admin access"));
    }
    // Queued ASR jobs retain their upload until they get a preparation slot.
    let slots = match cmd.as_str() {
        "native_asr_transcribe" => Some(&app.asr_requests),
        "native_live_transcribe" => Some(&app.live_requests),
        _ => None,
    };
    let _upload = slots.map(|slots| slots.try_acquire()).transpose().map_err(|_| {
        ApiError::new(StatusCode::TOO_MANY_REQUESTS, "Transcription is busy on this server. Try again shortly.")
    })?;
    let limit = if slots.is_some() { MAX_ASR_BYTES } else { MAX_COMMAND_BYTES };
    let (parts, body) = request.into_parts();
    let raw = parts
        .headers
        .get(header::CONTENT_TYPE)
        .and_then(|header| header.to_str().ok())
        .and_then(|content_type| content_type.split(';').next())
        .is_some_and(|content_type| {
            content_type
                .trim()
                .eq_ignore_ascii_case("application/octet-stream")
        });
    let bytes = to_bytes(body, limit).await.map_err(|_| {
        ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "Command body exceeds the maximum size or could not be read",
        )
    })?;
    let body = if raw {
        let headers = parts
            .headers
            .iter()
            .filter_map(|(key, value)| {
                key.as_str().starts_with("x-").then_some(())?;
                Some((key.as_str().to_owned(), value.to_str().ok()?.to_owned()))
            })
            .collect();
        CommandBody::Raw {
            bytes: bytes.to_vec(),
            headers,
        }
    } else {
        let value = if bytes.is_empty() {
            json!({})
        } else {
            serde_json::from_slice(&bytes)
                .map_err(|_| ApiError::bad_request("Invalid command JSON body"))?
        };
        CommandBody::Json(value)
    };

    drop(bytes);
    let gate = app.user_data.get(session.user.id.clone());
    let _guard = gate.access.read().await;
    let session = session::load(&app, session.hash).await?;
    if admin_command && session.user.role != Role::Admin {
        return Err(ApiError::forbidden("This command requires admin access"));
    }
    let ctx = app.user_ctx(&session.user);
    tokio::fs::create_dir_all(&ctx.user_dir)
        .await
        .map_err(ApiError::internal)?;
    if admin_command {
        let actor = ctx.user_id.clone();
        let command = cmd.clone();
        app.db
            .run(move |db| {
                audit(
                    db,
                    now_ms(),
                    None,
                    Some(&actor),
                    "admin.command",
                    Some(json!({ "command": command })),
                )
            })
            .await?;
    }
    let dispatch = lt_commands::dispatch(&app.engine, &ctx, &cmd, body);
    let result = if matches!(
        cmd.as_str(),
        "native_asr_transcribe" | "native_live_transcribe" | "native_diarize_run"
    ) {
        let mut deleting = gate.deleting.subscribe();
        tokio::select! {
            biased;
            _ = deleting.wait_for(|deleting| *deleting) => {
                return Err(ApiError::conflict("This account is being deleted"));
            }
            result = dispatch => result,
        }
    } else {
        dispatch.await
    };
    match result {
        Ok(Reply::Json(value)) => Ok(Json(value).into_response()),
        Ok(Reply::Recording(paths)) => {
            let chunks = stream::iter(paths)
                .then(tokio::fs::File::open)
                .map_ok(tokio_util::io::ReaderStream::new)
                .try_flatten();
            Ok((
                [(header::CONTENT_TYPE, "application/octet-stream")],
                Body::from_stream(chunks),
            ).into_response())
        }
        Err(CommandError::NotFound(error)) => Err(ApiError::not_found(error)),
        Err(CommandError::Forbidden(error)) => Err(ApiError::forbidden(error)),
        Err(CommandError::Failed(error)) => Err(ApiError::bad_request(error)),
    }
}

pub type ApiResult<T> = Result<T, ApiError>;

#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    pub fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }

    pub fn bad_request(message: impl std::fmt::Display) -> Self {
        Self::new(StatusCode::BAD_REQUEST, message.to_string())
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, message)
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, message)
    }

    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, message)
    }

    pub fn unauthorized() -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "Sign in to continue")
    }

    pub fn internal(error: impl std::fmt::Display) -> Self {
        eprintln!("lt-server: {error}");
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}", self.message)
    }
}

impl std::error::Error for ApiError {}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({ "error": self.message }))).into_response()
    }
}

impl From<rusqlite::Error> for ApiError {
    fn from(error: rusqlite::Error) -> Self {
        Self::internal(error)
    }
}

pub struct Input<T>(pub T);

impl<S: Send + Sync, T: DeserializeOwned> FromRequest<S> for Input<T> {
    type Rejection = ApiError;

    async fn from_request(request: Request, state: &S) -> ApiResult<Self> {
        Json::<T>::from_request(request, state)
            .await
            .map(|Json(value)| Self(value))
            .map_err(|error| {
                if error.status() == StatusCode::PAYLOAD_TOO_LARGE {
                    ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "Request body is too large")
                } else {
                    ApiError::bad_request("Invalid JSON request body")
                }
            })
    }
}

pub async fn blocking<T: Send + 'static>(
    operation: impl FnOnce() -> ApiResult<T> + Send + 'static,
) -> ApiResult<T> {
    tokio::task::spawn_blocking(operation)
        .await
        .map_err(ApiError::internal)?
}
