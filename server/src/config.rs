use std::{
    env,
    fs::{self, File},
    io::{self, Write},
    net::SocketAddr,
    path::{Path, PathBuf},
};

use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose, Engine as _};
use lt_commands::EngineConfig;
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use url::Url;

pub const HOUR_MS: i64 = 3_600_000;

pub struct Config {
    pub bind: SocketAddr,
    pub public_url: Option<Url>,
    pub static_dir: PathBuf,
    pub engine: EngineConfig,
    pub settings: SettingsPatch,
    pub bootstrap: Option<(String, String)>,
    pub session_ttl_ms: i64,
    pub session_idle_ms: i64,
    pub quota_bytes: u64,
}

impl Config {
    pub fn load() -> Result<Self> {
        let data_dir = data_dir();
        let public_url = optional("LT_PUBLIC_URL")
            .map(|value| parse_http_url(&value).context("LT_PUBLIC_URL"))
            .transpose()?;
        if public_url
            .as_ref()
            .is_some_and(|url| url.path() != "/" || url.query().is_some())
        {
            bail!("LT_PUBLIC_URL must be an origin, such as https://transcribe.example.com");
        }
        let quota_bytes = number::<u64>("LT_USER_QUOTA_MB", 0)?
            .checked_mul(1024 * 1024)
            .context("LT_USER_QUOTA_MB is too large")?;
        let bootstrap = match (optional("LT_ADMIN_EMAIL"), optional("LT_ADMIN_PASSWORD")) {
            (Some(email), Some(password)) => Some((email, password)),
            (None, None) => None,
            _ => bail!("Set both LT_ADMIN_EMAIL and LT_ADMIN_PASSWORD to bootstrap an admin"),
        };
        let settings = SettingsPatch {
            local_login: optional("LT_LOCAL_LOGIN")
                .map(|value| {
                    value
                        .parse()
                        .context("LT_LOCAL_LOGIN must be true or false")
                })
                .transpose()?,
            oidc: OidcPatch {
                issuer: optional("LT_OIDC_ISSUER"),
                client_id: optional("LT_OIDC_CLIENT_ID"),
                client_secret: optional("LT_OIDC_CLIENT_SECRET"),
                scopes: optional("LT_OIDC_SCOPES")
                    .map(|value| value.split_whitespace().map(str::to_owned).collect()),
                provider_name: optional("LT_OIDC_PROVIDER_NAME"),
                admin_group: optional("LT_OIDC_ADMIN_GROUP"),
                groups_claim: optional("LT_OIDC_GROUPS_CLAIM"),
                allowed_groups: optional("LT_OIDC_ALLOWED_GROUPS").map(|v| comma_list(&v)),
                allowed_domains: optional("LT_OIDC_ALLOWED_DOMAINS").map(|v| comma_list(&v)),
            },
        };
        if let Some(issuer) = &settings.oidc.issuer {
            parse_issuer(issuer).context("LT_OIDC_ISSUER")?;
            if public_url.is_none() {
                bail!("LT_PUBLIC_URL is required for OIDC");
            }
        }

        fs::create_dir_all(&data_dir).context("Create data directory")?;
        let secret_key = secret_key(&data_dir, optional("LT_SECRET_KEY"))?;
        Ok(Self {
            bind: optional("LT_BIND")
                .unwrap_or_else(|| "0.0.0.0:8080".into())
                .parse()
                .context("Invalid LT_BIND")?,
            public_url,
            static_dir: path("LT_STATIC_DIR", "/opt/lt/dist"),
            engine: EngineConfig {
                data_dir,
                whisper_cli: Some(path("WHISPER_CLI_PATH", "/opt/lt/bin/whisper-cli")),
                diarize_dir: Some(path("LT_DIARIZE_DIR", "/opt/lt/diarize")),
                secret_key,
            },
            settings,
            bootstrap,
            session_ttl_ms: hours("LT_SESSION_TTL_HOURS", 168)?,
            session_idle_ms: hours("LT_SESSION_IDLE_HOURS", 24)?,
            quota_bytes,
        })
    }

    pub fn secure_cookies(&self) -> bool {
        self.public_url
            .as_ref()
            .is_some_and(|url| url.scheme() == "https")
    }
}

pub fn data_dir() -> PathBuf {
    path("LT_DATA_DIR", "/data")
}

fn optional(name: &str) -> Option<String> {
    env::var(name).ok().filter(|value| !value.is_empty())
}

fn path(name: &str, default: &str) -> PathBuf {
    env::var_os(name)
        .filter(|value| !value.is_empty())
        .map_or_else(|| default.into(), Into::into)
}

fn number<T>(name: &str, default: T) -> Result<T>
where
    T: std::str::FromStr,
    T::Err: std::error::Error + Send + Sync + 'static,
{
    optional(name).map_or(Ok(default), |value| {
        value.parse().with_context(|| format!("Invalid {name}"))
    })
}

fn hours(name: &str, default: i64) -> Result<i64> {
    number(name, default)?
        .checked_mul(HOUR_MS)
        .filter(|value| *value > 0)
        .with_context(|| format!("{name} must be a positive number of hours"))
}

pub fn parse_http_url(input: &str) -> Result<Url> {
    let url = Url::parse(input).context("Invalid URL")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        bail!("Expected an HTTP(S) URL without credentials or a fragment");
    }
    Ok(url)
}

pub fn parse_issuer(input: &str) -> Result<Url> {
    let url = parse_http_url(input)?;
    if url.query().is_some() {
        bail!("The issuer URL must not have a query");
    }
    Ok(url)
}

fn decode_key(value: &str) -> Result<[u8; 32]> {
    let value = value.trim();
    general_purpose::STANDARD
        .decode(value)
        .or_else(|_| general_purpose::STANDARD_NO_PAD.decode(value))
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .context("The secret key must be 32 bytes encoded in base64")
}

fn secret_key(data_dir: &Path, supplied: Option<String>) -> Result<[u8; 32]> {
    if let Some(value) = supplied {
        return decode_key(&value).context("Invalid LT_SECRET_KEY");
    }
    let path = data_dir.join("secret.key");
    match fs::read_to_string(&path) {
        Ok(value) => return decode_key(&value).context("Invalid secret.key"),
        Err(err) if err.kind() == io::ErrorKind::NotFound => {}
        Err(err) => return Err(err).context("Read secret.key"),
    }

    // Persist a complete, private file before another process can see it.
    let mut key = [0; 32];
    OsRng.fill_bytes(&mut key);
    let mut file = tempfile::NamedTempFile::new_in(data_dir)?;
    writeln!(file, "{}", general_purpose::STANDARD.encode(key))?;
    file.as_file().sync_all()?;
    match file.persist_noclobber(&path) {
        Ok(_) => {
            #[cfg(unix)]
            File::open(data_dir)?.sync_all()?;
            Ok(key)
        }
        Err(err) if err.error.kind() == io::ErrorKind::AlreadyExists => {
            decode_key(&fs::read_to_string(path)?).context("Invalid secret.key")
        }
        Err(err) => Err(err.error).context("Write secret.key"),
    }
}

pub fn comma_list(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_owned)
        .collect()
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct OidcSettings {
    pub issuer: String,
    pub client_id: String,
    pub client_secret: String,
    pub scopes: Vec<String>,
    pub provider_name: String,
    pub admin_group: String,
    pub groups_claim: String,
    pub allowed_groups: Vec<String>,
    pub allowed_domains: Vec<String>,
}

impl Default for OidcSettings {
    fn default() -> Self {
        Self {
            issuer: String::new(),
            client_id: String::new(),
            client_secret: String::new(),
            scopes: ["openid", "email", "profile"].map(str::to_owned).to_vec(),
            provider_name: "SSO".into(),
            admin_group: String::new(),
            groups_claim: "groups".into(),
            allowed_groups: Vec::new(),
            allowed_domains: Vec::new(),
        }
    }
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SettingsPatch {
    pub local_login: Option<bool>,
    pub oidc: OidcPatch,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct OidcPatch {
    pub issuer: Option<String>,
    pub client_id: Option<String>,
    pub client_secret: Option<String>,
    pub scopes: Option<Vec<String>>,
    pub provider_name: Option<String>,
    pub admin_group: Option<String>,
    pub groups_claim: Option<String>,
    pub allowed_groups: Option<Vec<String>>,
    pub allowed_domains: Option<Vec<String>>,
}

impl OidcPatch {
    pub fn apply(
        &self,
        target: &mut OidcSettings,
        environment: Option<&Self>,
    ) -> Vec<&'static str> {
        // Apply only editable fields when writing settings, and report the same
        // field names the admin UI uses when overlaying the environment.
        macro_rules! fields {
            ($($field:ident => $key:literal),+ $(,)?) => {{
                let mut applied = Vec::new();
                $(
                    if !environment.is_some_and(|env| env.$field.is_some()) {
                        if let Some(value) = &self.$field {
                            target.$field.clone_from(value);
                            applied.push($key);
                        }
                    }
                )+
                applied
            }};
        }
        fields!(
            issuer => "oidc.issuer",
            client_id => "oidc.clientId",
            client_secret => "oidc.clientSecret",
            scopes => "oidc.scopes",
            provider_name => "oidc.providerName",
            admin_group => "oidc.adminGroup",
            groups_claim => "oidc.groupsClaim",
            allowed_groups => "oidc.allowedGroups",
            allowed_domains => "oidc.allowedDomains",
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_key_is_private_and_stable() {
        let dir = tempfile::tempdir().unwrap();
        let key = secret_key(dir.path(), None).unwrap();
        assert_eq!(secret_key(dir.path(), None).unwrap(), key);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(dir.path().join("secret.key"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let supplied = [51; 32];
        assert_eq!(
            secret_key(dir.path(), Some(general_purpose::STANDARD.encode(supplied))).unwrap(),
            supplied,
        );
        assert_eq!(secret_key(dir.path(), None).unwrap(), key);
    }
}
