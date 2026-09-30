//! In-app updates from GitHub Releases via `tauri-plugin-updater`.
//! The manifest (`latest.json` on the `updater` release, built by
//! `.github/workflows/update-manifest.yml`) points at signed artifacts; the
//! plugin refuses any download whose signature does not match the public key
//! in `tauri.conf.json`. Nothing is installed without the user clicking
//! Update. Progress is polled like model downloads (no event channel).

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

const RELEASES_URL: &str = "https://github.com/GrzeskoByte/local-transcript/releases";

#[derive(Default)]
pub struct UpdateState {
    pending: Mutex<Option<Update>>,
    progress: Mutex<UpdateProgress>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    /// `idle` | `downloading` | `installing` | `restarting` | `error`.
    pub stage: String,
    pub downloaded: u64,
    pub total: Option<u64>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current_version: String,
    pub available: bool,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub date: Option<String>,
    /// False for Linux .deb/.rpm installs: only the AppImage replaces itself.
    pub can_self_update: bool,
    /// Where to download the new version manually.
    pub download_url: String,
}

/// The running app can replace itself (Linux: only when run as an AppImage).
fn can_self_update() -> bool {
    if cfg!(target_os = "linux") {
        std::env::var_os("APPIMAGE").is_some()
    } else {
        true
    }
}

fn platform_tag() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "ubuntu"
    }
}

fn set_progress(app: &AppHandle, f: impl FnOnce(&mut UpdateProgress)) {
    let state = app.state::<UpdateState>();
    let mut p = state.progress.lock().unwrap_or_else(|e| e.into_inner());
    f(&mut p);
}

#[tauri::command]
pub async fn native_update_check(
    app: AppHandle,
    state: State<'_, UpdateState>,
) -> Result<UpdateInfo, String> {
    let current_version = app.package_info().version.to_string();
    let updater = app
        .updater()
        .map_err(|e| format!("Updater unavailable: {e}"))?;
    let update = updater
        .check()
        .await
        .map_err(|e| format!("Could not check for updates: {e}"))?;
    let info = match &update {
        Some(u) => UpdateInfo {
            current_version,
            available: true,
            version: Some(u.version.clone()),
            notes: u.body.clone(),
            date: u.date.map(|d| d.to_string()),
            can_self_update: can_self_update(),
            download_url: format!("{RELEASES_URL}/tag/v{}-{}", u.version, platform_tag()),
        },
        None => UpdateInfo {
            current_version,
            available: false,
            version: None,
            notes: None,
            date: None,
            can_self_update: can_self_update(),
            download_url: RELEASES_URL.to_string(),
        },
    };
    *state.pending.lock().unwrap_or_else(|e| e.into_inner()) = update;
    Ok(info)
}

/// Download, verify and install the update found by the last check, then
/// relaunch (the old instance exits once the new one is spawned).
#[tauri::command]
pub async fn native_update_install(
    app: AppHandle,
    state: State<'_, UpdateState>,
) -> Result<(), String> {
    if !can_self_update() {
        return Err("This installation cannot update itself; download the new version instead.".into());
    }
    let update = state
        .pending
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .ok_or_else(|| "No update pending — check for updates first.".to_string())?;
    set_progress(&app, |p| *p = UpdateProgress { stage: "downloading".into(), ..Default::default() });
    let on_chunk = {
        let app = app.clone();
        move |chunk: usize, total: Option<u64>| {
            set_progress(&app, |p| {
                p.downloaded += chunk as u64;
                p.total = total;
            });
        }
    };
    let on_done = {
        let app = app.clone();
        move || set_progress(&app, |p| p.stage = "installing".into())
    };
    if let Err(e) = update.download_and_install(on_chunk, on_done).await {
        let msg = format!("Update failed: {e}");
        set_progress(&app, |p| {
            p.stage = "error".into();
            p.error = Some(msg.clone());
        });
        return Err(msg);
    }
    set_progress(&app, |p| p.stage = "restarting".into());
    crate::relaunch::relaunch(&app);
    Ok(())
}

#[tauri::command]
pub fn native_update_progress(state: State<'_, UpdateState>) -> UpdateProgress {
    let p = state.progress.lock().unwrap_or_else(|e| e.into_inner()).clone();
    if p.stage.is_empty() {
        UpdateProgress { stage: "idle".into(), ..p }
    } else {
        p
    }
}
