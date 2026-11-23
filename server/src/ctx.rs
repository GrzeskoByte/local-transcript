use std::{
    collections::HashMap,
    hash::Hash,
    path::PathBuf,
    sync::{Arc, Mutex, Weak},
};

use lt_commands::{Engine, UserCtx};
use openidconnect::reqwest;
use tokio::sync::{watch, Mutex as AsyncMutex, RwLock, Semaphore};

use crate::{
    accounts_db::{AccountsDb, Profile, Role},
    config::Config,
};

#[derive(Clone)]
pub struct App(Arc<State>);

pub struct State {
    pub config: Config,
    pub db: AccountsDb,
    pub engine: Arc<Engine>,
    http: reqwest::Client,
    https: reqwest::Client,
    pub password_slots: Arc<Semaphore>,
    pub asr_requests: Semaphore,
    pub live_requests: Semaphore,
    pub account_write: Arc<AsyncMutex<()>>,
    pub user_data: Gates<String, UserActivity>,
    pub logins: Gates<(String, std::net::IpAddr), AsyncMutex<()>>,
}

impl App {
    pub fn new(config: Config, db: AccountsDb) -> anyhow::Result<Self> {
        let engine = Engine::new(config.engine.clone());
        let client = |https_only| {
            reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(std::time::Duration::from_secs(15))
                .https_only(https_only)
                .build()
        };
        Ok(Self(Arc::new(State {
            config,
            db,
            engine,
            http: client(false)?,
            https: client(true)?,
            password_slots: Arc::new(Semaphore::new(4)),
            asr_requests: Semaphore::new(4),
            live_requests: Semaphore::new(2),
            account_write: Arc::new(AsyncMutex::new(())),
            user_data: Gates::default(),
            logins: Gates::default(),
        })))
    }

    pub fn oidc_http(&self, issuer: &url::Url) -> &reqwest::Client {
        if issuer.scheme() == "https" {
            &self.https
        } else {
            &self.http
        }
    }

    pub fn user_dir(&self, id: &str) -> PathBuf {
        self.config.engine.data_dir.join("users").join(id)
    }

    pub fn user_ctx(&self, profile: &Profile) -> UserCtx {
        UserCtx {
            user_id: profile.id.clone(),
            user_dir: self.user_dir(&profile.id),
            is_admin: profile.role == Role::Admin,
            quota_bytes: self.config.quota_bytes,
        }
    }
}

impl std::ops::Deref for App {
    type Target = State;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

pub struct UserActivity {
    // Wait for storage operations before removing the folder. Long-running
    // engine jobs can yield their guard so delete_user_data can cancel them.
    pub access: RwLock<()>,
    pub deleting: watch::Sender<bool>,
}

impl Default for UserActivity {
    fn default() -> Self {
        Self {
            access: RwLock::default(),
            deleting: watch::channel(false).0,
        }
    }
}

impl UserActivity {
    pub fn begin_deletion(&self) -> Deletion<'_> {
        self.deleting.send_replace(true);
        Deletion(&self.deleting)
    }
}

pub struct Deletion<'a>(&'a watch::Sender<bool>);

impl Drop for Deletion<'_> {
    fn drop(&mut self) {
        self.0.send_replace(false);
    }
}

pub struct Gates<K, V>(Mutex<HashMap<K, Weak<V>>>);

impl<K, V> Default for Gates<K, V> {
    fn default() -> Self {
        Self(Mutex::new(HashMap::new()))
    }
}

impl<K: Eq + Hash, V: Default> Gates<K, V> {
    pub fn get(&self, key: K) -> Arc<V> {
        let mut gates = self.0.lock().expect("gate map");
        gates.retain(|_, gate| gate.strong_count() != 0);
        let entry = gates.entry(key).or_default();
        if let Some(gate) = entry.upgrade() {
            return gate;
        }
        let gate = Arc::new(V::default());
        *entry = Arc::downgrade(&gate);
        gate
    }
}
