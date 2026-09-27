mod models;
mod native_asr;
mod storage;

pub use native_asr::AppState;

use tauri::webview::{PermissionKind, PermissionResponse};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
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
            native_asr::native_asr_status,
            native_asr::native_asr_models,
            native_asr::native_asr_download_model,
            native_asr::native_asr_enable_gpu,
            native_asr::native_asr_transcribe,
            native_asr::native_asr_cancel,
            storage::native_storage_dir,
            storage::native_save_file,
            storage::native_open_storage_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
