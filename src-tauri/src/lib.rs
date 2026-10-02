mod audio_diag;
mod models;
mod native_asr;
mod opencode;
mod proc;
mod recordings;
mod relaunch;
mod settings;
mod storage;
mod system_audio;
mod calendar;
mod calendar_detect;
mod claude_code;
mod updater;

pub use native_asr::AppState;

use tauri::webview::{PermissionKind, PermissionResponse};

/// Inside the AppImage, WebKit uses the bundled GStreamer plugins. Give them
/// their own registry cache so the bundled GStreamer does not rewrite (and
/// fight over) the host's `~/.cache/gstreamer-1.0/registry.*.bin`. Must run
/// before GTK/WebKit start: their processes inherit the variable.
fn use_own_gstreamer_registry() {
    if !cfg!(target_os = "linux") || proc::bundle_root().is_none() || std::env::var_os("GST_REGISTRY_1_0").is_some() {
        return;
    }
    let cache = std::env::var_os("XDG_CACHE_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".cache")));
    if let Some(dir) = cache.map(|c| c.join("io.localtranscribe.app")) {
        if std::fs::create_dir_all(&dir).is_ok() {
            std::env::set_var("GST_REGISTRY_1_0", dir.join("gstreamer-registry.bin"));
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // After an update/reset relaunch: let the old instance release the profile.
    relaunch::wait_for_previous_instance();
    use_own_gstreamer_registry();
    // A crash mid-recording can leave the virtual system-audio source behind.
    std::thread::spawn(system_audio::remove_sources);
    tauri::Builder::default()
        .manage(AppState::default())
        .manage(settings::SettingsLock::default())
        .manage(updater::UpdateState::default())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // WebKitGTK denies any media request the embedder does not handle, so
        // without this handler getUserMedia/getDisplayMedia always fail inside
        // the desktop shell (the cryptic NotAllowedError). Allow exactly the
        // microphone, camera and display capture the recorder needs; anything
        // else keeps the platform default (Linux resolves Default to Deny).
        .on_permission_request(|_webview, kind| match kind {
            PermissionKind::Microphone | PermissionKind::Camera | PermissionKind::DisplayCapture => {
                PermissionResponse::Allow
            }
            _ => PermissionResponse::Default,
        })
        .invoke_handler(tauri::generate_handler![
            audio_diag::native_audio_diag_start,
            audio_diag::native_audio_diag_peek,
            audio_diag::native_audio_diag_stop,
            native_asr::native_asr_status,
            native_asr::native_asr_models,
            native_asr::native_asr_download_model,
            native_asr::native_asr_download_progress,
            native_asr::native_asr_enable_gpu,
            native_asr::native_asr_transcribe,
            native_asr::native_asr_cancel,
            opencode::native_opencode_status,
            opencode::native_opencode_summarize,
            claude_code::native_claude_status,
            claude_code::native_claude_summarize,
            recordings::native_recording_write,
            recordings::native_recording_write_meta,
            recordings::native_recording_read_meta,
            recordings::native_recording_list,
            recordings::native_recording_read,
            recordings::native_recording_delete,
            storage::native_storage_dir,
            storage::native_save_file,
            storage::native_open_storage_dir,
            storage::native_open_url,
            storage::native_reset_webview_database,
            settings::native_settings_load,
            settings::native_settings_set,
            calendar::native_calendar_create,
            calendar::native_calendar_fetch,
            calendar::native_calendar_test,
            calendar_detect::native_calendar_thunderbird,
            calendar_detect::native_calendar_probe,
            updater::native_update_check,
            updater::native_update_install,
            updater::native_update_progress,
            system_audio::native_system_audio_status,
            system_audio::native_system_audio_start,
            system_audio::native_system_audio_outputs,
            system_audio::native_system_audio_stop,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            if let tauri::RunEvent::Exit = event {
                system_audio::remove_sources();
                audio_diag::shutdown();
            }
        });
}
