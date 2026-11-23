//! Backend / model discovery for the server's whisper.cpp CLI.
// Ported from src-tauri/src/models.rs. The desktop module scans per-user model
// folders and also drives voxtype; the server has one shared model folder
// (`<data_dir>/models`) and supports the whisper.cpp CLI only, so both are
// parameterised/trimmed here (no process-global state).
use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeModel {
    pub name: String,
    pub engine: String,
    pub installed: bool,
    pub downloadable: bool,
    pub path: Option<String>,
    pub size_bytes: Option<u64>,
    pub accuracy: u32,
    pub recommended: bool,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GpuInfo {
    pub available: bool,
    pub active: bool,
    pub backend: Option<String>,
    pub devices: Vec<String>,
    pub hint: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAsrStatus {
    pub available: bool,
    pub backend: String,
    pub binary_path: Option<String>,
    pub version: Option<String>,
    pub engines: Vec<String>,
    pub acceleration: Option<String>,
    pub gpu: GpuInfo,
    pub model_dir: Option<String>,
    pub models: Vec<NativeModel>,
    pub install_hint: Option<String>,
    pub bundled: bool,
    pub recommended_model: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Backend {
    pub path: PathBuf,
    pub version: Option<String>,
}

fn path_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = match std::env::var_os("PATH") {
        Some(p) => std::env::split_paths(&p).collect(),
        None => Vec::new(),
    };
    dirs.push(PathBuf::from("/usr/local/bin"));
    dirs
}

fn which(program: &str) -> Option<PathBuf> {
    path_dirs().into_iter().map(|d| d.join(program)).find(|p| p.is_file())
}

fn probe_version(bin: &Path) -> Option<String> {
    let out = crate::proc::command(bin).arg("--version").output().ok()?;
    let text = if out.stdout.is_empty() {
        String::from_utf8_lossy(&out.stderr).to_string()
    } else {
        String::from_utf8_lossy(&out.stdout).to_string()
    };
    text.lines().map(|l| l.trim()).find(|l| !l.is_empty()).map(|s| s.to_string())
}

/// The configured CLI (`WHISPER_CLI_PATH` of the server), else `$WHISPER_CLI_PATH`,
/// else `whisper-cli` / `whisper-cpp` / `main` on the PATH.
pub fn discover_backend(configured: Option<&Path>) -> Option<Backend> {
    let from_env = std::env::var_os("WHISPER_CLI_PATH").map(PathBuf::from);
    let found = configured
        .map(Path::to_path_buf)
        .filter(|p| p.is_file())
        .or_else(|| from_env.filter(|p| p.is_file()))
        .or_else(|| ["whisper-cli", "whisper-cpp", "main"].iter().find_map(|c| which(c)))?;
    Some(Backend { version: probe_version(&found), path: found })
}

pub fn install_hint() -> String {
    "Transcription is not set up on this server: no whisper.cpp CLI (`whisper-cli`) was found. \
     Ask the server admin to check WHISPER_CLI_PATH."
        .to_string()
}

/// Model a whisper.cpp backend fetches on first use (see the desktop module).
pub const WHISPER_CLI_FIRST_MODEL: &str = "large-v3-turbo-q5_0";

const STATIC_WHISPER_CATALOG: [&str; 11] = [
    "tiny",
    "tiny.en",
    "base",
    "base.en",
    "small",
    "small.en",
    "medium",
    "medium.en",
    "large-v3",
    "large-v3-turbo",
    "large-v3-turbo-q5_0",
];

fn accuracy_rank(name: &str) -> u32 {
    match name {
        "tiny" | "tiny.en" => 1,
        "base" | "base.en" => 2,
        "small" | "small.en" => 3,
        "medium" | "medium.en" => 4,
        "large-v3" | "large-v3-turbo" | "large-v3-turbo-q5_0" => 5,
        _ => 0,
    }
}

fn is_recommended(name: &str) -> bool {
    matches!(name, "large-v3-turbo" | "large-v3-turbo-q5_0")
}

fn detail_for(name: &str, size: Option<u64>) -> String {
    match size {
        Some(bytes) => {
            let mb = (bytes as f64 / 1_048_576.0).round() as u64;
            let language = if name.ends_with(".en") { "English" } else { "Multilingual" };
            format!("~{} MB · {}", mb, language)
        }
        None => String::new(),
    }
}

fn build_model(name: &str, installed: bool, path: Option<String>, size: Option<u64>) -> NativeModel {
    NativeModel {
        name: name.to_string(),
        engine: "whisper".to_string(),
        installed,
        downloadable: true,
        path,
        size_bytes: size,
        accuracy: accuracy_rank(name),
        recommended: is_recommended(name),
        detail: detail_for(name, size),
    }
}

/// `ggml-<name>.bin` files in the model folder.
fn disk_models(dir: &Path) -> Vec<NativeModel> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<NativeModel> = entries
        .flatten()
        .filter(|e| e.path().is_file())
        .filter_map(|e| {
            let path = e.path();
            let file_name = path.file_name()?.to_str()?.to_string();
            let name = file_name.strip_prefix("ggml-")?.strip_suffix(".bin")?.to_string();
            let size = path.metadata().ok().map(|m| m.len());
            Some(build_model(&name, true, Some(path.to_string_lossy().to_string()), size))
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// The static catalog merged with the models present on disk.
pub fn collect_models(dir: &Path) -> Vec<NativeModel> {
    let disk = disk_models(dir);
    let mut models: Vec<NativeModel> = STATIC_WHISPER_CATALOG
        .iter()
        .map(|name| match disk.iter().find(|d| d.name == *name) {
            Some(d) => d.clone(),
            None => build_model(name, false, None, None),
        })
        .collect();
    for model in disk {
        if !models.iter().any(|m| m.name == model.name) {
            models.push(model);
        }
    }
    models
}

/// Reject anything that is not a plain model name (no paths, no flags).
pub fn valid_model_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && !name.starts_with('.')
        && !name.starts_with('-')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
}

pub fn ggml_filename(name: &str) -> String {
    format!("ggml-{name}.bin")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_model_name_rejects_paths_and_flags() {
        for good in ["tiny", "base.en", "large-v3-turbo", "large-v3-turbo-q5_0"] {
            assert!(valid_model_name(good), "{good}");
        }
        for bad in ["", "../evil", "/abs/path", "a b", "x;rm", "--model", ".hidden", &"a".repeat(65)] {
            assert!(!valid_model_name(bad), "{bad}");
        }
    }
}
