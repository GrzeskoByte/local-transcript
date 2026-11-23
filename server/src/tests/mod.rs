mod oidc;

use std::{net::SocketAddr, path::Path};

use axum::{
    body::{to_bytes, Body},
    extract::ConnectInfo,
    http::{header, request::Builder, Request, StatusCode},
    response::Response,
    Router,
};
use lt_commands::EngineConfig;
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use tempfile::TempDir;
use tower::ServiceExt;
use url::Url;

use crate::{
    accounts_db::{now_ms, AccountsDb, Profile, Role},
    auth::{local, token_hash},
    config::{Config, SettingsPatch, HOUR_MS},
    ctx::App,
    http,
};

const PASSWORD: &str = "test password";
const ORIGIN: &str = "https://transcribe.example";
const ADMIN: &str = "admin@example.com";
const MEMBER: &str = "member@example.com";

struct TestApp {
    _dir: TempDir,
    app: App,
    router: Router,
}

impl TestApp {
    fn new(public_url: Option<&str>, settings: SettingsPatch) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().join("data");
        let static_dir = dir.path().join("dist");
        std::fs::create_dir(&static_dir).unwrap();
        std::fs::write(
            static_dir.join("index.html"),
            "<html><head></head><body>App</body></html>",
        )
        .unwrap();
        std::fs::write(static_dir.join("asset.js"), "console.log('asset')").unwrap();
        let config = Config {
            bind: "127.0.0.1:0".parse().unwrap(),
            public_url: public_url.map(|url| Url::parse(url).unwrap()),
            static_dir,
            engine: EngineConfig {
                data_dir: data_dir.clone(),
                whisper_cli: None,
                diarize_dir: None,
                calendar_allowed_hosts: Vec::new(),
                secret_key: [17; 32],
            },
            settings,
            bootstrap: None,
            session_ttl_ms: 168 * HOUR_MS,
            session_idle_ms: 24 * HOUR_MS,
            quota_bytes: 1024,
            trusted_proxies: Vec::new(),
        };
        let app = App::new(config, AccountsDb::open(&data_dir).unwrap()).unwrap();
        let router = http::router(app.clone());
        Self {
            _dir: dir,
            app,
            router,
        }
    }

    async fn request(&self, request: Builder, body: Option<Value>) -> Response {
        let request = match body {
            Some(body) => request
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string())),
            None => request.body(Body::empty()),
        }
        .unwrap();
        self.router.clone().oneshot(request).await.unwrap()
    }

    async fn create(&self, email: &str, role: Role) -> Profile {
        local::create_account(
            &self.app.db,
            email.into(),
            "Person".into(),
            PASSWORD.into(),
            role,
            false,
        )
        .await
        .unwrap()
        .unwrap()
    }

    async fn login(&self, email: &str, password: &str, ip: &str) -> Response {
        let mut builder = request("POST", "/api/auth/login")
            .extension(ConnectInfo(ip.parse::<SocketAddr>().unwrap()));
        if let Some(origin) = &self.app.config.public_url {
            builder = builder.header(header::ORIGIN, origin.origin().ascii_serialization());
        }
        self.request(
            builder,
            Some(json!({ "email": email, "password": password })),
        )
        .await
    }

    async fn login_as(&self, email: &str) -> Ticket {
        let response = self.login(email, PASSWORD, "127.0.0.1:4000").await;
        assert_eq!(response.status(), StatusCode::OK);
        self.ticket(cookie(&response, "lt_session")).await
    }

    async fn ticket(&self, cookie: String) -> Ticket {
        let response = self
            .request(
                request("GET", "/api/me").header(header::COOKIE, &cookie),
                None,
            )
            .await;
        assert_eq!(response.status(), StatusCode::OK);
        let me = json_body(response).await;
        Ticket { cookie, me }
    }
}

struct Ticket {
    cookie: String,
    me: Value,
}

impl Ticket {
    fn request(&self, method: &str, uri: &str) -> Builder {
        request(method, uri)
            .header(header::COOKIE, &self.cookie)
            .header("x-lt-csrf", self.me["csrf"].as_str().unwrap())
    }

    fn hash(&self) -> String {
        token_hash(self.cookie.split_once('=').unwrap().1)
    }
}

fn request(method: &str, uri: &str) -> Builder {
    Request::builder().method(method).uri(uri)
}

fn cookie(response: &Response, name: &str) -> String {
    response
        .headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .map(|value| value.to_str().unwrap())
        .find(|value| value.split_once('=').is_some_and(|(key, _)| key == name))
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned()
}

async fn bytes(response: Response) -> Vec<u8> {
    to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap()
        .to_vec()
}

async fn json_body(response: Response) -> Value {
    serde_json::from_slice(&bytes(response).await).unwrap()
}

#[tokio::test]
async fn local_login_and_throttling() {
    let test = TestApp::new(Some(ORIGIN), SettingsPatch::default());
    let admin = test.create(ADMIN, Role::Member).await;
    assert_eq!(admin.role, Role::Admin);
    test.create(MEMBER, Role::Member).await;
    test.app
        .db
        .run(|db| {
            let first = crate::accounts_db::user_by_email(db, ADMIN)?
                .unwrap()
                .password_hash
                .unwrap();
            let second = crate::accounts_db::user_by_email(db, MEMBER)?
                .unwrap()
                .password_hash
                .unwrap();
            assert!(first.starts_with("$argon2id$"));
            assert_ne!(first, second);
            assert!(!first.contains(PASSWORD));
            Ok(())
        })
        .await
        .unwrap();

    let rejected = test
        .request(
            request("POST", "/api/auth/login").header(header::ORIGIN, "https://other.example"),
            Some(json!({ "email": ADMIN, "password": PASSWORD })),
        )
        .await;
    assert_eq!(rejected.status(), StatusCode::FORBIDDEN);

    for _ in 0..5 {
        assert_eq!(
            test.login("Admin@Example.COM", "wrong password", "127.0.0.1:4000")
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
    }
    assert_eq!(
        test.login(ADMIN, PASSWORD, "127.0.0.1:4001").await.status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    let other_peer = test.login(ADMIN, PASSWORD, "127.0.0.2:4000").await;
    assert_eq!(other_peer.status(), StatusCode::OK);
    let cookie_header = other_peer.headers()[header::SET_COOKIE].to_str().unwrap();
    for flag in ["HttpOnly", "SameSite=Lax", "Secure", "Path=/"] {
        assert!(cookie_header.contains(flag));
    }
    test.app
        .db
        .run(|db| {
            db.execute(
                "UPDATE login_failures SET at = ?1",
                [now_ms() - 16 * 60 * 1000],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    let ticket = test.login_as(ADMIN).await;
    assert_eq!(ticket.me["user"]["id"], admin.id);
    let audit = json_body(
        test.request(ticket.request("GET", "/api/admin/audit"), None)
            .await,
    )
    .await;
    assert_eq!(
        audit
            .as_array()
            .unwrap()
            .iter()
            .filter(|row| row["action"] == "login.failed")
            .count(),
        5
    );
}

#[tokio::test]
async fn session_expiry_and_csrf() {
    let test = TestApp::new(None, SettingsPatch::default());
    test.create(ADMIN, Role::Admin).await;
    let ticket = test.login_as(ADMIN).await;
    let response = test
        .request(
            request("POST", "/api/auth/logout").header(header::COOKIE, &ticket.cookie),
            None,
        )
        .await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert!(json_body(response).await["error"].is_string());
    let wrong = test
        .request(
            request("POST", "/api/auth/logout")
                .header(header::COOKIE, &ticket.cookie)
                .header("x-lt-csrf", "wrong"),
            None,
        )
        .await;
    assert_eq!(wrong.status(), StatusCode::FORBIDDEN);

    for (column, cutoff) in [
        ("expires_at", now_ms() - 1),
        (
            "last_seen_at",
            now_ms() - test.app.config.session_idle_ms - 1,
        ),
    ] {
        let current = test.login_as(ADMIN).await;
        let hash = current.hash();
        let lookup = hash.clone();
        test.app
            .db
            .run(move |db| {
                db.execute(
                    &format!("UPDATE sessions SET {column} = ?1 WHERE token_hash = ?2"),
                    params![cutoff, lookup],
                )?;
                Ok(())
            })
            .await
            .unwrap();
        assert_eq!(
            test.request(current.request("GET", "/api/me"), None)
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
        test.app
            .db
            .run(move |db| {
                assert_eq!(
                    db.query_row(
                        "SELECT count(*) FROM sessions WHERE token_hash = ?1",
                        [hash],
                        |row| row.get::<_, i64>(0)
                    )?,
                    0
                );
                Ok(())
            })
            .await
            .unwrap();
    }
    let list = json_body(
        test.request(ticket.request("GET", "/api/me/sessions"), None)
            .await,
    )
    .await;
    assert_eq!(list[0]["id"], &ticket.hash()[..12]);
    assert_eq!(list[0]["current"], true);
    let response = test
        .request(ticket.request("POST", "/api/auth/logout"), None)
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(cookie(&response, "lt_session"), "lt_session=");
    assert_eq!(
        test.request(ticket.request("GET", "/api/me"), None)
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn invites_are_hashed_one_use_and_expire() {
    let test = TestApp::new(Some(ORIGIN), SettingsPatch::default());
    test.create(ADMIN, Role::Admin).await;
    let admin = test.login_as(ADMIN).await;
    let create = |email: &str| {
        test.request(
            admin.request("POST", "/api/admin/invites"),
            Some(json!({ "email": email, "role": "member" })),
        )
    };
    let invite = json_body(create(MEMBER).await).await;
    let url = invite["url"].as_str().unwrap();
    assert!(url.starts_with(&format!("{ORIGIN}/#/invite/")));
    assert!(invite["expiresAt"].as_i64().unwrap() > now_ms() + 6 * 24 * HOUR_MS);
    let token = url.rsplit('/').next().unwrap();
    let hash = token_hash(token);
    let lookup = hash.clone();
    test.app
        .db
        .run(move |db| {
            let stored: String =
                db.query_row("SELECT token_hash FROM invites", [], |row| row.get(0))?;
            assert_eq!(stored, lookup);
            Ok(())
        })
        .await
        .unwrap();

    let accept = |token: &str, origin: &str| {
        test.request(
            request("POST", "/api/auth/invite/accept").header(header::ORIGIN, origin),
            Some(json!({ "token": token, "name": "New Person", "password": PASSWORD })),
        )
    };
    assert_eq!(
        accept(token, "https://other.example").await.status(),
        StatusCode::FORBIDDEN
    );
    let accepted = accept(token, ORIGIN).await;
    assert_eq!(accepted.status(), StatusCode::OK);
    let member = test.ticket(cookie(&accepted, "lt_session")).await;
    assert_eq!(member.me["user"]["role"], "member");
    assert_eq!(member.me["user"]["email"], MEMBER);
    assert_eq!(
        accept(token, ORIGIN).await.status(),
        StatusCode::BAD_REQUEST
    );
    let revoked = json_body(create("revoked@example.com").await).await;
    let revoked_token = revoked["url"].as_str().unwrap().rsplit('/').next().unwrap();
    let revoked_id = token_hash(revoked_token);
    let removed = test
        .request(
            admin.request(
                "DELETE",
                &format!("/api/admin/invites/{}", &revoked_id[..12]),
            ),
            None,
        )
        .await;
    assert_eq!(removed.status(), StatusCode::OK);
    assert_eq!(
        accept(revoked_token, ORIGIN).await.status(),
        StatusCode::BAD_REQUEST
    );

    let expired = json_body(create("expired@example.com").await).await;
    let expired_token = expired["url"].as_str().unwrap().rsplit('/').next().unwrap();
    let expired_hash = token_hash(expired_token);
    test.app
        .db
        .run(move |db| {
            db.execute(
                "UPDATE invites SET expires_at = 0 WHERE token_hash = ?1",
                [expired_hash],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    assert_eq!(
        accept(expired_token, ORIGIN).await.status(),
        StatusCode::BAD_REQUEST
    );
    let listed = json_body(
        test.request(admin.request("GET", "/api/admin/invites"), None)
            .await,
    )
    .await;
    assert!(!listed.to_string().contains(token));
    assert!(listed
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["id"] == hash[..12] && row["usedAt"].is_i64()));
}

#[tokio::test]
async fn last_admin_member_access_and_disabled_sessions() {
    let test = TestApp::new(None, SettingsPatch::default());
    let admin = test.create(ADMIN, Role::Admin).await;
    let member = test.create(MEMBER, Role::Member).await;
    let admin_ticket = test.login_as(ADMIN).await;
    let member_ticket = test.login_as(MEMBER).await;
    let admin_path = format!("/api/admin/users/{}", admin.id);
    let member_path = format!("/api/admin/users/{}", member.id);
    for action in [json!({ "disabled": true }), json!({ "role": "member" })] {
        assert_eq!(
            test.request(admin_ticket.request("PATCH", &admin_path), Some(action))
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(
        test.request(admin_ticket.request("DELETE", &admin_path), None)
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        test.request(
            admin_ticket.request("DELETE", "/api/me"),
            Some(json!({ "confirm": ADMIN }))
        )
        .await
        .status(),
        StatusCode::BAD_REQUEST
    );
    for (method, path) in [
        ("GET", "/api/admin/users"),
        ("PATCH", admin_path.as_str()),
        ("DELETE", admin_path.as_str()),
        ("GET", "/api/admin/invites"),
        ("POST", "/api/admin/invites"),
        ("GET", "/api/admin/settings"),
        ("PUT", "/api/admin/settings"),
        ("POST", "/api/admin/oidc/test"),
        ("GET", "/api/admin/audit"),
        ("POST", "/api/invoke/native_asr_download_model"),
        ("POST", "/api/invoke/native_asr_enable_gpu"),
    ] {
        assert_eq!(
            test.request(member_ticket.request(method, path), None)
                .await
                .status(),
            StatusCode::FORBIDDEN,
            "{method} {path}"
        );
    }

    assert_eq!(
        test.request(
            admin_ticket.request("PATCH", &member_path),
            Some(json!({ "disabled": true }))
        )
        .await
        .status(),
        StatusCode::OK
    );
    assert_eq!(
        test.request(member_ticket.request("GET", "/api/me"), None)
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        test.login(MEMBER, PASSWORD, "127.0.0.1:4000")
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let hash = member_ticket.hash();
    test.app
        .db
        .run(move |db| {
            assert_eq!(
                db.query_row(
                    "SELECT count(*) FROM sessions WHERE token_hash = ?1",
                    [hash],
                    |row| row.get::<_, i64>(0)
                )?,
                0
            );
            Ok(())
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn invocation_directory_belongs_to_session_only() {
    let test = TestApp::new(None, SettingsPatch::default());
    let admin = test.create(ADMIN, Role::Admin).await;
    let member = test.create(MEMBER, Role::Member).await;
    let ticket = test.login_as(MEMBER).await;
    let foreign = test.app.user_dir(&admin.id);
    let own = test.app.user_dir(&member.id);
    assert!(!foreign.exists() && !own.exists());
    let response = test
        .request(
            ticket
                .request("POST", "/api/invoke/unknown")
                .header("X-User-Id", &admin.id),
            Some(json!({ "userId": admin.id, "userDir": foreign })),
        )
        .await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert!(own.is_dir());
    assert!(!foreign.exists());
    let usage = json_body(
        test.request(ticket.request("GET", "/api/me/usage"), None)
            .await,
    )
    .await;
    assert_eq!(usage, json!({ "bytes": 0, "quotaBytes": 1024 }));
}

#[tokio::test]
async fn static_spa_has_edition_marker_and_security_headers() {
    let test = TestApp::new(None, SettingsPatch::default());
    for path in ["/", "/index.html", "/spa/fallback"] {
        let response = test.request(request("GET", path), None).await;
        assert_eq!(response.status(), StatusCode::OK);
        let csp = response.headers()[header::CONTENT_SECURITY_POLICY]
            .to_str()
            .unwrap();
        assert!(csp.contains("connect-src 'self' https:"));
        assert!(csp.contains("frame-ancestors 'none'"));
        assert!(!csp.contains("unsafe-inline"));
        assert_eq!(
            response.headers()[header::X_CONTENT_TYPE_OPTIONS],
            "nosniff"
        );
        let body = String::from_utf8(bytes(response).await).unwrap();
        assert!(body.contains(r#"<meta name="lt-edition" content="server">"#));
    }
    let asset = test.request(request("GET", "/asset.js"), None).await;
    assert_eq!(bytes(asset).await, b"console.log('asset')");
    let missing_api = test.request(request("GET", "/api/unknown"), None).await;
    assert_eq!(missing_api.status(), StatusCode::NOT_FOUND);
    assert!(json_body(missing_api).await["error"].is_string());
}

#[tokio::test]
async fn admin_settings_do_not_expose_secrets_and_env_wins() {
    use crate::config::OidcPatch;

    let settings = SettingsPatch {
        local_login: Some(true),
        oidc: OidcPatch {
            provider_name: Some("Environment SSO".into()),
            ..Default::default()
        },
    };
    let test = TestApp::new(Some(ORIGIN), settings);
    test.create(ADMIN, Role::Admin).await;
    let admin = test.login_as(ADMIN).await;
    let response = test
        .request(
            admin.request("PUT", "/api/admin/settings"),
            Some(json!({
                "localLogin": false,
                "oidc": {
                    "issuer": "https://provider.example",
                    "clientId": "lt-client",
                    "clientSecret": "original-secret",
                    "providerName": "Database SSO",
                },
            })),
        )
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    let settings = json_body(response).await;
    assert_eq!(settings["localLogin"], true);
    assert_eq!(settings["oidc"]["clientSecretSet"], true);
    assert_eq!(settings["oidc"]["providerName"], "Environment SSO");
    assert!(!settings.to_string().contains("original-secret"));
    assert_eq!(
        settings["locked"],
        json!(["oidc.providerName", "localLogin"])
    );
    let public = json_body(test.request(request("GET", "/api/auth/config"), None).await).await;
    assert_eq!(
        public,
        json!({ "localLogin": true, "sso": { "name": "Environment SSO" }, "inviteOnly": true })
    );
    test.app
        .db
        .run(|db| {
            let raw: String = db.query_row(
                "SELECT value FROM server_settings WHERE key = 'oidc'",
                [],
                |row| row.get(0),
            )?;
            assert!(!raw.contains("original-secret"));
            Ok(())
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn changing_oidc_identity_requires_a_fresh_secret() {
    let test = TestApp::new(Some(ORIGIN), SettingsPatch::default());
    test.create(ADMIN, Role::Admin).await;
    let admin = test.login_as(ADMIN).await;
    let endpoint = "/api/admin/settings";
    let update = |oidc| test.request(admin.request("PUT", endpoint), Some(json!({ "oidc": oidc })));
    assert_eq!(
        test.request(admin.request("PUT", endpoint), Some(json!({ "localLogin": false }))).await.status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(update(json!({
        "issuer": "https://old.example", "clientId": "old", "clientSecret": "old-secret"
    })).await.status(), StatusCode::OK);
    for rejected in [
        json!({ "issuer": "https://new.example" }),
        json!({ "clientId": "new" }),
        json!({ "clientId": "new", "clientSecret": "" }),
        json!({ "clientId": "new", "clientSecret": "old-secret" }),
    ] {
        assert_eq!(update(rejected).await.status(), StatusCode::BAD_REQUEST);
    }
    let previous = crate::admin::settings(&test.app).await.unwrap().oidc;
    assert_eq!(previous.issuer, "https://old.example");
    assert_eq!(previous.client_id, "old");
    assert_eq!(previous.client_secret, "old-secret");
    assert_eq!(update(json!({
        "issuer": "https://new.example", "clientId": "new", "clientSecret": "new-secret"
    })).await.status(), StatusCode::OK);
    let current = crate::admin::settings(&test.app).await.unwrap().oidc;
    assert_eq!(current.issuer, "https://new.example");
    assert_eq!(current.client_id, "new");
    assert_eq!(current.client_secret, "new-secret");
}

#[tokio::test]
async fn recording_and_export_streams_preserve_binary_responses() {
    let test = TestApp::new(None, SettingsPatch::default());
    test.create(ADMIN, Role::Admin).await;
    let admin = test.login_as(ADMIN).await;
    for (name, chunk) in [("000001.ogg", "QkI="), ("000000.ogg", "QUE=")] {
        let response = test.request(
            admin.request("POST", "/api/invoke/native_recording_write"),
            Some(json!({ "request": { "meetingId": "m", "name": name, "dataBase64": chunk } })),
        ).await;
        assert_eq!(response.status(), StatusCode::OK);
    }
    let audio = test.request(
        admin.request("POST", "/api/invoke/native_recording_read"),
        Some(json!({ "meetingId": "m" })),
    ).await;
    assert_eq!(audio.headers()[header::CONTENT_TYPE], "application/octet-stream");
    assert_eq!(to_bytes(audio.into_body(), 100).await.unwrap(), "AABB");

    let archive = test.request(admin.request("GET", "/api/me/export"), None).await;
    assert_eq!(archive.status(), StatusCode::OK);
    assert_eq!(archive.headers()[header::CONTENT_TYPE], "application/zip");
    assert!(to_bytes(archive.into_body(), 4096).await.unwrap().starts_with(b"PK"));
}

#[test]
fn admin_passwords_come_from_a_prompt_or_one_stdin_line() {
    use clap::Parser;
    let args = ["lt-server", "admin", "reset-password", "--email", ADMIN];
    assert!(crate::Cli::try_parse_from(args).is_ok());
    assert!(crate::Cli::try_parse_from(args.into_iter().chain(["--password-stdin"])).is_ok());
    assert!(crate::Cli::try_parse_from(args.into_iter().chain(["--password", "value"])).is_err());
    assert_eq!(crate::read_password_line(b" password \r\nignored".as_slice()).unwrap(), " password ");
    assert!(crate::read_password_line(b"\n".as_slice()).is_err());
    assert!(crate::read_password_line(vec![b'a'; 1025].as_slice()).is_err());
}

#[test]
fn migration_backs_up_existing_database() {
    let dir = tempfile::tempdir().unwrap();
    let old = Connection::open(dir.path().join("app.db")).unwrap();
    old.execute_batch("CREATE TABLE legacy (value TEXT); INSERT INTO legacy VALUES ('original');")
        .unwrap();
    drop(old);
    AccountsDb::open(dir.path()).unwrap();
    let version = |path: &Path| {
        Connection::open(path)
            .unwrap()
            .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap()
    };
    assert_eq!(version(&dir.path().join("app.db")), 1);
    let backup = dir.path().join("app.db.bak-0");
    assert_eq!(version(&backup), 0);
    assert_eq!(
        Connection::open(backup)
            .unwrap()
            .query_row("SELECT value FROM legacy", [], |row| row
                .get::<_, String>(0),)
            .unwrap(),
        "original"
    );
}
