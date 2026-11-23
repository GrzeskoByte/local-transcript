use std::collections::HashMap;

use axum::{
    extract::{Extension, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use openidconnect::ProviderMetadataWithLogout;
use openidconnect::{
    core::{
        CoreAuthDisplay, CoreAuthPrompt, CoreAuthenticationFlow, CoreClientAuthMethod,
        CoreErrorResponseType, CoreGenderClaim, CoreJsonWebKey, CoreJweContentEncryptionAlgorithm,
        CoreJwsSigningAlgorithm, CoreRevocableToken, CoreRevocationErrorResponse,
        CoreTokenIntrospectionResponse, CoreTokenType,
    },
    AccessTokenHash, AdditionalClaims, AuthType, AuthorizationCode, Client, ClientId, ClientSecret,
    CsrfToken, EmptyExtraTokenFields, EndpointMaybeSet, EndpointNotSet, EndpointSet, IdTokenFields,
    IssuerUrl, Nonce, OAuth2TokenResponse, PkceCodeChallenge, PkceCodeVerifier, RedirectUrl, Scope,
    StandardErrorResponse, StandardTokenResponse, TokenResponse,
};
use rusqlite::{params, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use subtle::ConstantTimeEq;
use url::Url;

use crate::{
    accounts_db::{
        audit, has_users, is_last_active_admin, now_ms, user_by_email, user_by_oidc, AuthKind,
        Profile, Role,
    },
    admin::{self, EffectiveSettings},
    auth::{
        local::{normalize_email, normalize_name},
        random_hex, seal,
        session::{self, Session},
        token_hash, unseal,
    },
    config::{parse_http_url, parse_issuer, Config, OidcSettings},
    ctx::App,
    http::{ApiError, ApiResult},
};

const COOKIE: &str = "lt_oidc";
const COOKIE_PATH: &str = "/auth/oidc";
const FLOW_PURPOSE: &[u8] = b"lt-server:oidc-flow";
const LOGOUT_PURPOSE: &[u8] = b"lt-server:oidc-logout";
const FLOW_TTL_SECS: i64 = 600;

#[derive(Debug, Serialize, Deserialize)]
struct ExtraClaims(HashMap<String, Value>);
impl AdditionalClaims for ExtraClaims {}

type OidcToken = StandardTokenResponse<
    IdTokenFields<
        ExtraClaims,
        EmptyExtraTokenFields,
        CoreGenderClaim,
        CoreJweContentEncryptionAlgorithm,
        CoreJwsSigningAlgorithm,
    >,
    CoreTokenType,
>;
type OidcClient = Client<
    ExtraClaims,
    CoreAuthDisplay,
    CoreGenderClaim,
    CoreJweContentEncryptionAlgorithm,
    CoreJsonWebKey,
    CoreAuthPrompt,
    StandardErrorResponse<CoreErrorResponseType>,
    OidcToken,
    CoreTokenIntrospectionResponse,
    CoreRevocableToken,
    CoreRevocationErrorResponse,
    EndpointSet,
    EndpointNotSet,
    EndpointNotSet,
    EndpointNotSet,
    EndpointMaybeSet,
    EndpointMaybeSet,
>;

#[derive(Serialize, Deserialize)]
struct Flow {
    state: String,
    nonce: String,
    verifier: String,
    settings: String,
    expires_at: i64,
}

#[derive(Serialize, Deserialize)]
struct Logout {
    endpoint: Url,
    id_token: String,
}

fn oidc_settings(settings: EffectiveSettings, config: &Config) -> ApiResult<OidcSettings> {
    if !settings.oidc_enabled(config) {
        return Err(ApiError::not_found("OIDC is not configured"));
    }
    Ok(settings.oidc)
}

// The cookie is only valid for the provider and policy used when it was issued.
fn fingerprint(settings: &OidcSettings) -> ApiResult<String> {
    Ok(token_hash(
        &serde_json::to_string(settings).map_err(ApiError::internal)?,
    ))
}

async fn discover(app: &App, settings: &OidcSettings) -> ApiResult<ProviderMetadataWithLogout> {
    let issuer_url = parse_issuer(&settings.issuer).map_err(ApiError::bad_request)?;
    let issuer = IssuerUrl::new(settings.issuer.clone()).map_err(ApiError::bad_request)?;
    let provider = ProviderMetadataWithLogout::discover_async(issuer, app.oidc_http(&issuer_url))
        .await
        .map_err(|_| {
            ApiError::new(
                StatusCode::BAD_GATEWAY,
                "Could not discover the OIDC provider",
            )
        })?;
    let token_endpoint = provider
        .token_endpoint()
        .ok_or_else(|| ApiError::bad_request("The OIDC provider has no token endpoint"))?;
    for endpoint in [
        provider.authorization_endpoint().as_str(),
        token_endpoint.as_str(),
    ] {
        let url = parse_http_url(endpoint).map_err(ApiError::bad_request)?;
        if issuer_url.scheme() == "https" && url.scheme() != "https" {
            return Err(ApiError::bad_request(
                "The OIDC provider advertised an insecure endpoint",
            ));
        }
    }
    Ok(provider)
}

fn client(
    config: &Config,
    settings: &OidcSettings,
    provider: ProviderMetadataWithLogout,
) -> OidcClient {
    let use_request_body = provider
        .token_endpoint_auth_methods_supported()
        .is_some_and(|methods| {
            methods.contains(&CoreClientAuthMethod::ClientSecretPost)
                && !methods.contains(&CoreClientAuthMethod::ClientSecretBasic)
        });
    let redirect = config
        .public_url
        .as_ref()
        .expect("OIDC requires LT_PUBLIC_URL")
        .join("/auth/oidc/callback")
        .expect("callback URL");
    let secret = (!settings.client_secret.is_empty())
        .then(|| ClientSecret::new(settings.client_secret.clone()));
    let client =
        Client::from_provider_metadata(provider, ClientId::new(settings.client_id.clone()), secret)
            .set_redirect_uri(RedirectUrl::from_url(redirect));
    if use_request_body {
        client.set_auth_type(AuthType::RequestBody)
    } else {
        client
    }
}

pub async fn start(State(app): State<App>) -> ApiResult<Response> {
    let settings = oidc_settings(admin::settings(&app).await?, &app.config)?;
    let provider = discover(&app, &settings).await?;
    let client = client(&app.config, &settings, provider);
    let (challenge, verifier) = PkceCodeChallenge::new_random_sha256();
    let mut request = client
        .authorize_url(
            CoreAuthenticationFlow::AuthorizationCode,
            CsrfToken::new_random,
            Nonce::new_random,
        )
        .set_pkce_challenge(challenge);
    for scope in settings
        .scopes
        .iter()
        .filter(|scope| scope.as_str() != "openid")
    {
        request = request.add_scope(Scope::new(scope.clone()));
    }
    let (url, state, nonce) = request.url();
    let flow = seal(
        &app.config.engine.secret_key,
        FLOW_PURPOSE,
        &Flow {
            state: state.secret().clone(),
            nonce: nonce.secret().clone(),
            verifier: verifier.secret().clone(),
            settings: fingerprint(&settings)?,
            expires_at: now_ms() + FLOW_TTL_SECS * 1000,
        },
    )
    .map_err(ApiError::internal)?;
    let mut response = found(url.as_str());
    session::set_cookie(
        &app.config,
        &mut response,
        COOKIE,
        &flow,
        COOKIE_PATH,
        FLOW_TTL_SECS,
    );
    Ok(response)
}

#[derive(Deserialize)]
pub struct Callback {
    state: Option<String>,
    code: Option<String>,
    error: Option<String>,
}

pub async fn callback(
    State(app): State<App>,
    headers: HeaderMap,
    query: Result<Query<Callback>, axum::extract::rejection::QueryRejection>,
) -> Response {
    let flow = session::read_cookie(&headers, COOKIE)
        .and_then(|cookie| unseal::<Flow>(&app.config.engine.secret_key, FLOW_PURPOSE, cookie).ok())
        .filter(|flow| flow.expires_at > now_ms());
    let mut response = match (flow, query) {
        (Some(flow), Ok(Query(query))) => match complete(&app, &headers, flow, query).await {
            Ok(token) => {
                let mut response = found("/");
                session::set_session_cookie(&app.config, &token, &mut response);
                response
            }
            Err(error) => {
                let _ = app
                    .db
                    .run(|db| {
                        audit(
                            db,
                            now_ms(),
                            None,
                            None,
                            "login.failed",
                            Some(json!({ "method": "oidc" })),
                        )
                    })
                    .await;
                error.into_response()
            }
        },
        _ => ApiError::bad_request("Invalid or expired OIDC sign-in. Start again").into_response(),
    };
    session::set_cookie(&app.config, &mut response, COOKIE, "", COOKIE_PATH, 0);
    response
}

async fn complete(
    app: &App,
    headers: &HeaderMap,
    flow: Flow,
    query: Callback,
) -> ApiResult<String> {
    if !query
        .state
        .as_ref()
        .is_some_and(|state| bool::from(state.as_bytes().ct_eq(flow.state.as_bytes())))
    {
        return Err(ApiError::bad_request(
            "OIDC state did not match. Start again",
        ));
    }
    if query.error.is_some() {
        return Err(ApiError::unauthorized());
    }
    let code = query.code.filter(|code| !code.is_empty()).ok_or_else(|| {
        ApiError::bad_request("The OIDC provider did not return an authorization code")
    })?;
    let settings = oidc_settings(admin::settings(app).await?, &app.config)?;
    if fingerprint(&settings)? != flow.settings {
        return Err(ApiError::bad_request(
            "OIDC settings changed during sign-in. Start again",
        ));
    }
    let provider = discover(app, &settings).await?;
    let issuer_url = provider.issuer().url().clone();
    let logout = provider
        .additional_metadata()
        .end_session_endpoint
        .as_ref()
        .and_then(|endpoint| parse_http_url(endpoint.as_str()).ok())
        .filter(|endpoint| issuer_url.scheme() != "https" || endpoint.scheme() == "https");
    let client = client(&app.config, &settings, provider);
    let token = client
        .exchange_code(AuthorizationCode::new(code))
        .map_err(ApiError::internal)?
        .set_pkce_verifier(PkceCodeVerifier::new(flow.verifier))
        .request_async(app.oidc_http(&issuer_url))
        .await
        .map_err(|_| {
            ApiError::new(
                StatusCode::UNAUTHORIZED,
                "The OIDC provider rejected the authorization code",
            )
        })?;
    let id_token = token.id_token().ok_or_else(ApiError::unauthorized)?;
    let verifier = client.id_token_verifier();
    let claims = id_token
        .claims(&verifier, &Nonce::new(flow.nonce))
        .map_err(|_| ApiError::unauthorized())?;
    if let Some(expected) = claims.access_token_hash() {
        let algorithm = id_token
            .signing_alg()
            .map_err(|_| ApiError::unauthorized())?;
        let key = id_token
            .signing_key(&verifier)
            .map_err(|_| ApiError::unauthorized())?;
        let actual = AccessTokenHash::from_token(token.access_token(), algorithm, key)
            .map_err(|_| ApiError::unauthorized())?;
        if actual != *expected {
            return Err(ApiError::unauthorized());
        }
    }
    let email = claims
        .email()
        .and_then(|email| normalize_email(email.as_str()).ok())
        .ok_or_else(|| {
            ApiError::forbidden("The OIDC provider did not supply a valid email address")
        })?;
    let name = claims
        .name()
        .and_then(|name| name.get(None))
        .and_then(|name| normalize_name(name.as_str()).ok())
        .unwrap_or_else(|| email.clone());
    let groups: Vec<&str> = claims
        .additional_claims()
        .0
        .get(&settings.groups_claim)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    let domain_is_allowed = settings.allowed_domains.is_empty()
        || (claims.email_verified() == Some(true)
            && email.rsplit_once('@').is_some_and(|(_, domain)| {
                settings
                    .allowed_domains
                    .iter()
                    .any(|allowed| allowed.eq_ignore_ascii_case(domain))
            }));
    let group_is_allowed = settings.allowed_groups.is_empty()
        || settings
            .allowed_groups
            .iter()
            .any(|group| groups.contains(&group.as_str()));
    if !domain_is_allowed || !group_is_allowed {
        return Err(ApiError::forbidden(
            "This OIDC account is not allowed to sign in",
        ));
    }
    let mapped_role = if settings.admin_group.is_empty() {
        None
    } else if groups.contains(&settings.admin_group.as_str()) {
        Some(Role::Admin)
    } else {
        Some(Role::Member)
    };
    let issuer = claims.issuer().as_str().to_owned();
    let sub = claims.subject().as_str().to_owned();
    if sub.is_empty() {
        return Err(ApiError::unauthorized());
    }
    let logout = logout
        .map(|endpoint| {
            seal(
                &app.config.engine.secret_key,
                LOGOUT_PURPOSE,
                &Logout {
                    endpoint,
                    id_token: id_token.to_string(),
                },
            )
            .map_err(ApiError::internal)
        })
        .transpose()?;
    let user_agent = session::user_agent(headers);

    let _write = app.account_write.lock().await;
    let config = app.clone();
    app.db
        .run(move |db| {
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            if fingerprint(&admin::read_settings(&tx, &config.config)?.oidc)? != flow.settings {
                return Err(ApiError::bad_request(
                    "OIDC settings changed during sign-in. Start again",
                ));
            }
            let now = now_ms();
            let existing = user_by_oidc(&tx, &issuer, &sub)?;
            if existing.as_ref().is_some_and(|user| user.disabled) {
                return Err(ApiError::unauthorized());
            }
            if user_by_email(&tx, &email)?.is_some_and(|other| {
                existing
                    .as_ref()
                    .is_none_or(|user| user.profile.id != other.profile.id)
            }) {
                return Err(ApiError::conflict(
                    "This email belongs to a different account",
                ));
            }
            let (id, role) = if let Some(user) = existing {
                let mut role = mapped_role.unwrap_or(user.profile.role);
                if role == Role::Member && is_last_active_admin(&tx, &user)? {
                    role = Role::Admin;
                }
                tx.execute(
                    "UPDATE users SET email = ?1, name = ?2, role = ?3 WHERE id = ?4",
                    params![email, name, role.as_str(), user.profile.id],
                )?;
                (user.profile.id, role)
            } else {
                let role = if has_users(&tx)? {
                    mapped_role.unwrap_or(Role::Member)
                } else {
                    Role::Admin
                };
                let id = random_hex::<16>();
                tx.execute(
                "INSERT INTO users(id, email, name, role, auth, oidc_issuer, oidc_sub, created_at)
                 VALUES (?1, ?2, ?3, ?4, 'oidc', ?5, ?6, ?7)",
                params![id, email, name, role.as_str(), issuer, sub, now],
            )?;
                (id, role)
            };
            let user = Profile {
                id,
                email,
                name,
                role,
                auth: AuthKind::Oidc,
            };
            let token = session::create(
                &tx,
                &config.config,
                &user,
                now,
                user_agent,
                logout.as_deref(),
            )?;
            audit(
                &tx,
                now,
                Some(&user.id),
                Some(&user.id),
                "login",
                Some(json!({ "method": "oidc" })),
            )?;
            tx.commit()?;
            Ok(token)
        })
        .await
}

pub fn logout_url(config: &Config, sealed: &str) -> Option<String> {
    let mut logout: Logout = unseal(&config.engine.secret_key, LOGOUT_PURPOSE, sealed).ok()?;
    let public_url = config.public_url.as_ref()?;
    logout
        .endpoint
        .query_pairs_mut()
        .append_pair("id_token_hint", &logout.id_token)
        .append_pair("post_logout_redirect_uri", public_url.as_str());
    Some(logout.endpoint.to_string())
}

pub async fn test_provider(
    State(app): State<App>,
    Extension(session): Extension<Session>,
) -> ApiResult<Json<Value>> {
    let settings = admin::settings(&app).await?.oidc;
    let result = discover(&app, &settings).await;
    let issuer = settings.issuer;
    let (body, ok) = match result {
        Ok(provider) => (
            json!({ "ok": true, "issuer": provider.issuer().as_str() }),
            true,
        ),
        Err(error) => (
            json!({ "ok": false, "issuer": issuer, "error": error.to_string() }),
            false,
        ),
    };
    app.db
        .run(move |db| {
            audit(
                db,
                now_ms(),
                None,
                Some(&session.user.id),
                "admin.oidc.test",
                Some(json!({ "ok": ok })),
            )
        })
        .await?;
    Ok(Json(body))
}

fn found(location: &str) -> Response {
    let mut response = StatusCode::FOUND.into_response();
    response.headers_mut().insert(
        header::LOCATION,
        HeaderValue::from_str(location).expect("redirect URL"),
    );
    response
}
