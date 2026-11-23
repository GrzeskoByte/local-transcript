use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
};

use axum::{
    extract::State,
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Form, Json, Router,
};
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine as _,
};
use rand::rngs::OsRng;
use rsa::{
    pkcs1v15::SigningKey,
    signature::{SignatureEncoding, Signer},
    traits::PublicKeyParts,
    RsaPrivateKey,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use url::Url;

use super::{cookie, json_body, request, TestApp, ADMIN, ORIGIN, PASSWORD};
use crate::{
    accounts_db::{now_ms, Role},
    config::{OidcPatch, SettingsPatch},
};

const CLIENT_ID: &str = "lt-client";
const CLIENT_SECRET: &str = "lt-client-secret";

struct MockProvider {
    issuer: String,
    jwk: Value,
    signing_key: SigningKey<Sha256>,
    pending: Mutex<HashMap<String, Issuance>>,
    exchanges: AtomicUsize,
}

struct Issuance {
    challenge: String,
    claims: Value,
}

impl MockProvider {
    async fn launch() -> (Arc<Self>, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let issuer = format!("http://{}", listener.local_addr().unwrap());
        let key = RsaPrivateKey::new(&mut OsRng, 2048).unwrap();
        let jwk = json!({
            "kty": "RSA", "kid": "lt-test-key", "alg": "RS256", "use": "sig",
            "n": URL_SAFE_NO_PAD.encode(key.n().to_bytes_be()),
            "e": URL_SAFE_NO_PAD.encode(key.e().to_bytes_be()),
        });
        let provider = Arc::new(Self {
            issuer,
            jwk,
            signing_key: SigningKey::new(key),
            pending: Mutex::default(),
            exchanges: AtomicUsize::default(),
        });
        let router = Router::new()
            .route("/.well-known/openid-configuration", get(discovery))
            .route("/keys", get(keys))
            .route("/token", post(exchange))
            .with_state(provider.clone());
        let handle = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        (provider, handle)
    }

    fn settings(&self) -> SettingsPatch {
        SettingsPatch {
            local_login: None,
            oidc: OidcPatch {
                issuer: Some(self.issuer.clone()),
                client_id: Some(CLIENT_ID.into()),
                client_secret: Some(CLIENT_SECRET.into()),
                admin_group: Some("operators".into()),
                groups_claim: Some("org_groups".into()),
                allowed_groups: Some(vec!["staff".into()]),
                allowed_domains: Some(vec!["example.com".into()]),
                ..Default::default()
            },
        }
    }

    fn issue(&self, flow: &PendingFlow, claims: Value) -> String {
        let mut base = json!({
            "iss": self.issuer,
            "aud": CLIENT_ID,
            "sub": "same-subject",
            "iat": now_ms() / 1000,
            "exp": now_ms() / 1000 + 600,
            "nonce": flow.args["nonce"],
            "email": "sso@example.com",
            "email_verified": true,
            "name": "Original Name",
            "org_groups": ["staff"],
        });
        base.as_object_mut()
            .unwrap()
            .extend(claims.as_object().unwrap().clone());
        self.issue_challenge(flow, flow.args["code_challenge"].clone(), base)
    }

    fn issue_challenge(&self, flow: &PendingFlow, challenge: String, claims: Value) -> String {
        let code = crate::auth::random_token();
        assert_eq!(flow.args["code_challenge_method"], "S256");
        self.pending
            .lock()
            .unwrap()
            .insert(code.clone(), Issuance { challenge, claims });
        code
    }

    fn sign(&self, claims: &Value) -> String {
        let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"RS256","kid":"lt-test-key","typ":"JWT"}"#);
        let claims = URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims).unwrap());
        let message = format!("{header}.{claims}");
        let signature = self.signing_key.sign(message.as_bytes());
        format!("{message}.{}", URL_SAFE_NO_PAD.encode(signature.to_bytes()))
    }
}

async fn discovery(State(provider): State<Arc<MockProvider>>) -> Json<Value> {
    let issuer = &provider.issuer;
    Json(json!({
        "issuer": issuer,
        "authorization_endpoint": format!("{issuer}/authorize"),
        "token_endpoint": format!("{issuer}/token"),
        "jwks_uri": format!("{issuer}/keys"),
        "end_session_endpoint": format!("{issuer}/logout"),
        "response_types_supported": ["code"],
        "subject_types_supported": ["public"],
        "token_endpoint_auth_methods_supported": ["client_secret_basic"],
        "id_token_signing_alg_values_supported": ["RS256"],
        "code_challenge_methods_supported": ["S256"],
    }))
}

async fn keys(State(provider): State<Arc<MockProvider>>) -> Json<Value> {
    Json(json!({ "keys": [provider.jwk] }))
}

async fn exchange(
    State(provider): State<Arc<MockProvider>>,
    headers: HeaderMap,
    Form(form): Form<HashMap<String, String>>,
) -> Response {
    provider.exchanges.fetch_add(1, Ordering::Relaxed);
    let basic = format!(
        "Basic {}",
        STANDARD.encode(format!("{CLIENT_ID}:{CLIENT_SECRET}"))
    );
    let authorized = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        == Some(&basic);
    let issued = form
        .get("code")
        .and_then(|code| provider.pending.lock().unwrap().remove(code));
    let pkce = form
        .get("code_verifier")
        .map(|verifier| URL_SAFE_NO_PAD.encode(Sha256::digest(verifier)));
    if let Some(issued) = issued.filter(|issued| {
        authorized
            && form["grant_type"] == "authorization_code"
            && form["redirect_uri"] == format!("{ORIGIN}/auth/oidc/callback")
            && pkce.as_ref() == Some(&issued.challenge)
    }) {
        return Json(json!({
            "access_token": "mock access token",
            "token_type": "Bearer",
            "id_token": provider.sign(&issued.claims),
        }))
        .into_response();
    }
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "error": "invalid_grant" })),
    )
        .into_response()
}

struct PendingFlow {
    cookie: String,
    args: HashMap<String, String>,
}

async fn begin(test: &TestApp) -> PendingFlow {
    let response = test.request(request("GET", "/auth/oidc/start"), None).await;
    assert_eq!(response.status(), StatusCode::FOUND);
    let url = Url::parse(response.headers()[header::LOCATION].to_str().unwrap()).unwrap();
    let args: HashMap<String, String> = url.query_pairs().into_owned().collect();
    assert_eq!(args["response_type"], "code");
    assert_eq!(args["client_id"], CLIENT_ID);
    assert_eq!(args["scope"], "openid email profile");
    assert!(!args.contains_key("code_verifier"));
    let encrypted = cookie(&response, "lt_oidc");
    assert!(!encrypted.contains(&args["nonce"]));
    assert!(!encrypted.contains(&args["state"]));
    PendingFlow {
        cookie: encrypted,
        args,
    }
}

async fn finish(test: &TestApp, flow: &PendingFlow, code: &str, state: &str) -> Response {
    let url = format!("/auth/oidc/callback?code={code}&state={state}");
    test.request(
        request("GET", &url).header(header::COOKIE, &flow.cookie),
        None,
    )
    .await
}

async fn sign_in(test: &TestApp, provider: &MockProvider, claims: Value) -> Response {
    let flow = begin(test).await;
    let code = provider.issue(&flow, claims);
    finish(test, &flow, &code, &flow.args["state"]).await
}

#[tokio::test]
async fn oidc_checks_state_nonce_pkce_and_id_token_claims() {
    let (provider, task) = MockProvider::launch().await;
    let test = TestApp::new(Some(ORIGIN), provider.settings());

    let flow = begin(&test).await;
    let code = provider.issue(&flow, json!({}));
    assert_eq!(
        finish(&test, &flow, &code, "mismatched").await.status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(provider.exchanges.load(Ordering::Relaxed), 0);

    let flow = begin(&test).await;
    let code = provider.issue_challenge(&flow, "mismatched".into(), json!({}));
    assert_eq!(
        finish(&test, &flow, &code, &flow.args["state"])
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(provider.exchanges.load(Ordering::Relaxed), 1);

    for claims in [
        json!({ "nonce": "mismatched" }),
        json!({ "aud": "other-client" }),
        json!({ "iss": "https://other.example" }),
        json!({ "exp": now_ms() / 1000 - 1 }),
    ] {
        let response = sign_in(&test, &provider, claims).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            response
                .headers()
                .get_all(header::SET_COOKIE)
                .iter()
                .count(),
            1
        );
        assert_eq!(cookie(&response, "lt_oidc"), "lt_oidc=");
    }
    test.app
        .db
        .run(|db| {
            assert!(!crate::accounts_db::has_users(db)?);
            Ok(())
        })
        .await
        .unwrap();
    task.abort();
}

#[tokio::test]
async fn local_sign_in_requires_a_reachable_provider_and_an_active_oidc_admin() {
    let (provider, task) = MockProvider::launch().await;
    let test = TestApp::new(Some(ORIGIN), provider.settings());
    test.create(ADMIN, Role::Admin).await;
    let local = test.login_as(ADMIN).await;
    let configure = |local_login| test.request(
        local.request("PUT", "/api/admin/settings"),
        Some(json!({ "localLogin": local_login })),
    );
    assert_eq!(configure(false).await.status(), StatusCode::BAD_REQUEST);

    let sso_response = sign_in(&test, &provider, json!({ "org_groups": ["staff", "operators"] })).await;
    let sso = test.ticket(cookie(&sso_response, "lt_session")).await;
    assert_eq!(sso.me["user"]["role"], "admin");
    assert_eq!(configure(false).await.status(), StatusCode::OK);
    assert_eq!(test.login(ADMIN, PASSWORD, "127.0.0.1:4000").await.status(), StatusCode::FORBIDDEN);

    let user = format!("/api/admin/users/{}", sso.me["user"]["id"].as_str().unwrap());
    for patch in [json!({ "role": "member" }), json!({ "disabled": true })] {
        assert_eq!(test.request(local.request("PATCH", &user), Some(patch)).await.status(), StatusCode::BAD_REQUEST);
    }
    assert_eq!(test.request(local.request("DELETE", &user), None).await.status(), StatusCode::BAD_REQUEST);
    assert_eq!(configure(true).await.status(), StatusCode::OK);
    task.abort();
    task.await.unwrap_err();
    assert_eq!(configure(false).await.status(), StatusCode::BAD_REQUEST);
    assert!(crate::admin::settings(&test.app).await.unwrap().local_login);
}

#[tokio::test]
async fn oidc_upserts_subject_maps_groups_and_supports_logout() {
    let (provider, task) = MockProvider::launch().await;
    let test = TestApp::new(Some(ORIGIN), provider.settings());
    let local = test.create(ADMIN, Role::Admin).await;
    let admin = test.login_as(ADMIN).await;
    let discovery = json_body(
        test.request(admin.request("POST", "/api/admin/oidc/test"), None)
            .await,
    )
    .await;
    assert_eq!(discovery, json!({ "ok": true, "issuer": provider.issuer }));

    for claims in [
        json!({ "email": "sso@wrong.example" }),
        json!({ "email_verified": false }),
        json!({ "org_groups": ["visitors"] }),
    ] {
        assert_eq!(
            sign_in(&test, &provider, claims).await.status(),
            StatusCode::FORBIDDEN
        );
    }
    assert_eq!(
        sign_in(&test, &provider, json!({ "email": ADMIN }))
            .await
            .status(),
        StatusCode::CONFLICT
    );

    let response = sign_in(&test, &provider, json!({})).await;
    assert_eq!(response.status(), StatusCode::FOUND);
    assert_eq!(response.headers()[header::LOCATION], "/");
    let initial = test.ticket(cookie(&response, "lt_session")).await;
    assert_eq!(initial.me["user"]["role"], "member");
    assert_eq!(initial.me["user"]["auth"], "oidc");
    assert_ne!(initial.me["user"]["id"], local.id);

    let response = sign_in(&test, &provider, json!({
        "email": "updated@example.com", "name": "New Name", "org_groups": ["staff", "operators"],
    })).await;
    assert_eq!(response.status(), StatusCode::FOUND);
    let updated = test.ticket(cookie(&response, "lt_session")).await;
    assert_eq!(initial.me["user"]["id"], updated.me["user"]["id"]);
    assert_eq!(updated.me["user"]["email"], "updated@example.com");
    assert_eq!(updated.me["user"]["name"], "New Name");
    assert_eq!(updated.me["user"]["role"], "admin");

    let logout = test
        .request(updated.request("POST", "/api/auth/logout"), None)
        .await;
    assert_eq!(cookie(&logout, "lt_session"), "lt_session=");
    let body = json_body(logout).await;
    let url = Url::parse(body["redirect"].as_str().unwrap()).unwrap();
    assert_eq!(url.path(), "/logout");
    let query: HashMap<_, _> = url.query_pairs().collect();
    assert_eq!(query["post_logout_redirect_uri"], format!("{ORIGIN}/"));
    assert_eq!(query["id_token_hint"].split('.').count(), 3);

    let first_user = TestApp::new(Some(ORIGIN), provider.settings());
    let response = sign_in(&first_user, &provider, json!({})).await;
    assert_eq!(response.status(), StatusCode::FOUND);
    let first_user_ticket = first_user.ticket(cookie(&response, "lt_session")).await;
    assert_eq!(first_user_ticket.me["user"]["role"], "admin");
    let repeat = sign_in(&first_user, &provider, json!({})).await;
    assert_eq!(repeat.status(), StatusCode::FOUND);
    let repeat_ticket = first_user.ticket(cookie(&repeat, "lt_session")).await;
    assert_eq!(repeat_ticket.me["user"]["role"], "admin");
    task.abort();
}
