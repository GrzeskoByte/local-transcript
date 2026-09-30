//! Backend / model discovery for the native ASR shell-out.
//!
//! No native compilation: the Rust side locates a CLI and reads its metadata.
//! Search order: `$WHISPER_CLI_PATH` → a user-installed `whisper-cli` /
//! `whisper-cpp` / `voxtype` (PATH plus the Homebrew / `/usr/local` dirs that
//! GUI apps on macOS do not get on their PATH) → the whisper.cpp engine bundled
//! next to the app executable (`lt-whisper`, built by the release workflow), so
//! a fresh install transcribes with zero setup.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

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
    /// A GPU acceleration backend is installed and ready to be switched on.
    pub available: bool,
    /// Acceleration is already the active backend.
    pub active: bool,
    /// "Vulkan" | "CUDA" | "MIGraphX" | ... (first installed GPU backend).
    pub backend: Option<String>,
    /// Detected GPU descriptions, e.g. "1. [Intel] Tiger Lake-LP GT2".
    pub devices: Vec<String>,
    /// Command to enable acceleration, for the manual fallback.
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
    /// The engine shipped inside the app is in use (no user install needed).
    pub bundled: bool,
    /// Model to fetch on first use for this backend (one-click setup).
    pub recommended_model: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Backend {
    pub name: String,
    pub path: String,
    pub version: Option<String>,
    pub bundled: bool,
}

// ---------------------------------------------------------------------------
// Environment helpers
// ---------------------------------------------------------------------------

pub(crate) fn home_dir() -> Option<PathBuf> {
    // HOME is usually unset on Windows; USERPROFILE is the equivalent there.
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn path_dirs() -> Vec<PathBuf> {
    // split_paths uses ';' on Windows and ':' everywhere else.
    let mut dirs: Vec<PathBuf> = match std::env::var_os("PATH") {
        Some(p) => std::env::split_paths(&p).collect(),
        None => Vec::new(),
    };
    // Apps launched from Finder / a desktop launcher get a minimal PATH that
    // misses Homebrew and per-user bins, so `brew install whisper-cpp` would
    // otherwise be invisible to the app.
    #[cfg(not(windows))]
    {
        for extra in ["/opt/homebrew/bin", "/usr/local/bin"] {
            dirs.push(PathBuf::from(extra));
        }
        if let Some(home) = home_dir() {
            dirs.push(home.join(".local/bin"));
        }
    }
    dirs
}

/// File name of the whisper.cpp engine bundled with the app (a Tauri sidecar).
pub const BUNDLED_ENGINE: &str = "lt-whisper";

/// The bundled engine, installed next to the app executable by every bundle
/// format (deb/rpm/AppImage `usr/bin`, macOS `Contents/MacOS`, Windows install dir).
pub fn bundled_engine_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let name = if cfg!(windows) {
        format!("{BUNDLED_ENGINE}.exe")
    } else {
        BUNDLED_ENGINE.to_string()
    };
    let candidate = exe.parent()?.join(name);
    candidate.is_file().then_some(candidate)
}

pub(crate) fn which(program: &str) -> Option<PathBuf> {
    #[cfg(windows)]
    let names: Vec<String> = if program.contains('.') {
        vec![program.to_string()]
    } else {
        vec![
            program.to_string(),
            format!("{program}.exe"),
            format!("{program}.cmd"),
            format!("{program}.bat"),
        ]
    };
    #[cfg(not(windows))]
    let names: Vec<String> = vec![program.to_string()];
    for dir in path_dirs() {
        for name in &names {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn backend_name_for(path: &Path) -> String {
    let base = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
    if base == "voxtype" {
        "voxtype".to_string()
    } else {
        "whisper-cli".to_string()
    }
}

fn probe_version(bin: &Path) -> Option<String> {
    let out = crate::proc::command(bin).arg("--version").output().ok()?;
    let text = if out.stdout.is_empty() {
        String::from_utf8_lossy(&out.stderr).to_string()
    } else {
        String::from_utf8_lossy(&out.stdout).to_string()
    };
    text.lines()
        .map(|l| l.trim())
        .find(|l| !l.is_empty())
        .map(|s| s.to_string())
}

/// Return the first available backend, matching the documented search order.
pub fn discover_backend() -> Option<Backend> {
    if let Some(raw) = std::env::var_os("WHISPER_CLI_PATH") {
        let pb = PathBuf::from(raw);
        if pb.is_file() {
            return Some(Backend {
                name: backend_name_for(&pb),
                version: probe_version(&pb),
                path: pb.to_string_lossy().to_string(),
                bundled: false,
            });
        }
    }

    for candidate in ["whisper-cli", "whisper-cpp", "main", "voxtype"] {
        if let Some(pb) = which(candidate) {
            return Some(Backend {
                name: backend_name_for(&pb),
                version: probe_version(&pb),
                path: pb.to_string_lossy().to_string(),
                bundled: false,
            });
        }
    }

    // Zero-setup fallback: the engine shipped inside the app.
    bundled_engine_path().map(|pb| Backend {
        name: "whisper-cli".to_string(),
        version: probe_version(&pb),
        path: pb.to_string_lossy().to_string(),
        bundled: true,
    })
}

/// Where this app stores models it downloads itself (per-OS app data dir).
pub fn app_model_dir() -> Option<PathBuf> {
    if let Some(d) = std::env::var_os("WHISPER_MODEL_DIR") {
        return Some(PathBuf::from(d));
    }
    #[cfg(windows)]
    {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            return Some(PathBuf::from(local).join("Local Transcribe/models"));
        }
    }
    let home = home_dir()?;
    #[cfg(target_os = "macos")]
    return Some(home.join("Library/Application Support/Local Transcribe/models"));
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let data = std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".local/share"));
        return Some(data.join("local-transcribe/models"));
    }
    #[allow(unreachable_code)]
    Some(home.join("AppData/Local/Local Transcribe/models"))
}

// ---------------------------------------------------------------------------
// Model directories / on-disk discovery
// ---------------------------------------------------------------------------

pub fn model_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(d) = std::env::var_os("WHISPER_MODEL_DIR") {
        dirs.push(PathBuf::from(d));
    }
    if let Some(app) = app_model_dir() {
        dirs.push(app);
    }
    if let Some(home) = home_dir() {
        dirs.push(home.join(".local/share/voxtype/models"));
        dirs.push(home.join(".cache/whisper"));
        dirs.push(home.join("whisper.cpp/models"));
        dirs.push(home.join(".local/share/whisper.cpp/models"));
        // Native per-OS app data locations (first pick for fresh installs).
        #[cfg(windows)]
        dirs.push(home.join("AppData/Local/Local Transcribe/models"));
        #[cfg(target_os = "macos")]
        dirs.push(home.join("Library/Application Support/Local Transcribe/models"));
    }
    #[cfg(windows)]
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        dirs.push(PathBuf::from(local).join("Local Transcribe/models"));
    }
    dirs
}

pub fn first_existing_model_dir() -> Option<String> {
    model_dirs()
        .into_iter()
        .find(|d| d.is_dir())
        .map(|d| d.to_string_lossy().to_string())
}

fn disk_models() -> Vec<NativeModel> {
    let mut out: Vec<NativeModel> = Vec::new();
    for dir in model_dirs() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let file_name = match path.file_name().and_then(|s| s.to_str()) {
                Some(f) => f,
                None => continue,
            };
            let (name, engine) = if let Some(stem) =
                file_name.strip_prefix("ggml-").and_then(|s| s.strip_suffix(".bin"))
            {
                (stem.to_string(), "whisper".to_string())
            } else if let Some(stem) = file_name.strip_suffix(".onnx") {
                (stem.to_string(), "parakeet".to_string())
            } else {
                continue;
            };
            let size = path.metadata().ok().map(|m| m.len());
            out.push(build_model(
                &name,
                &engine,
                true,
                false,
                Some(path.to_string_lossy().to_string()),
                size,
            ));
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct Catalog {
    engines: std::collections::BTreeMap<String, CatalogEngine>,
    #[serde(default)]
    #[allow(dead_code)]
    verified: bool,
}

#[derive(Debug, Deserialize)]
struct CatalogEngine {
    #[serde(default)]
    #[allow(dead_code)]
    default: Option<String>,
    models: Vec<CatalogModel>,
}

#[derive(Debug, Deserialize)]
struct CatalogModel {
    name: String,
    #[serde(default)]
    #[allow(dead_code)]
    download_arg: Option<String>,
    #[serde(default)]
    downloadable: bool,
    #[serde(default)]
    installed: bool,
}

#[derive(Debug, Deserialize)]
struct EngineCap {
    name: String,
    #[serde(default)]
    compiled: bool,
    #[serde(default)]
    #[allow(dead_code)]
    active: bool,
}

/// `voxtype info engines --json` -> engine name -> is compiled into this build.
/// A model can be listed/downloadable in the catalog yet unusable because its
/// engine feature was not enabled (e.g. `Parakeet feature not enabled`).
fn voxtype_engine_caps(bin: &str) -> Option<std::collections::HashMap<String, bool>> {
    let out = crate::proc::command(bin)
        .args(["info", "engines", "--json"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let parsed: Vec<EngineCap> = serde_json::from_str(&text).ok()?;
    Some(parsed.into_iter().map(|e| (e.name, e.compiled)).collect())
}

/// `voxtype info models --json` -> (engine names, models tagged with engine).
fn voxtype_catalog(bin: &str) -> Option<(Vec<String>, Vec<(String, CatalogModel)>)> {
    let out = crate::proc::command(bin)
        .args(["info", "models", "--json"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let catalog: Catalog = serde_json::from_str(&text).ok()?;

    let mut engines: Vec<String> = Vec::new();
    let mut models: Vec<(String, CatalogModel)> = Vec::new();
    for (engine, entry) in catalog.engines {
        engines.push(engine.clone());
        for model in entry.models {
            models.push((engine.clone(), model));
        }
    }
    Some((engines, models))
}

fn acceleration(bin: &str) -> Option<String> {
    let out = crate::proc::command(bin).args(["info", "accel"]).output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    for line in text.lines() {
        if line.contains("State:") {
            let collapsed = line.split_whitespace().collect::<Vec<_>>().join(" ");
            if !collapsed.is_empty() {
                return Some(collapsed);
            }
        }
    }
    None
}

pub fn read_acceleration(backend: &Backend) -> Option<String> {
    if backend.name == "voxtype" {
        acceleration(&backend.path)
    } else {
        None
    }
}

/// Parse `voxtype setup gpu --status`. Detects any installed GPU backend and
/// whether acceleration is already active, so the UI can offer to enable it.
fn parse_gpu_status(text: &str) -> GpuInfo {
    let mut info = GpuInfo::default();
    let mut in_devices = false;

    for raw in text.lines() {
        let line = raw.trim();

        if let Some(rest) = line.strip_prefix("Active backend:") {
            info.active = !rest.trim().to_ascii_uppercase().starts_with("CPU");
            continue;
        }
        if line.starts_with("GPUs detected:") {
            in_devices = true;
            continue;
        }
        if in_devices {
            if line.is_empty() {
                in_devices = false;
            } else if !line.starts_with("To enable") && !line.starts_with("Vulkan runtime") {
                info.devices.push(line.to_string());
            }
        }
        // e.g. "GPU (Vulkan) - installed" / "GPU (CUDA) - installed"
        if let Some(rest) = line.strip_prefix("GPU (") {
            if let Some((name, tail)) = rest.split_once(')') {
                if tail.contains("installed") {
                    info.available = true;
                    if info.backend.is_none() {
                        info.backend = Some(name.trim().to_string());
                    }
                }
            }
        }
    }

    info.hint = text
        .lines()
        .map(|l| l.trim())
        .find(|l| l.starts_with("sudo ") || l.starts_with("pkexec "))
        .map(|s| s.to_string());

    info
}

pub fn read_gpu(backend: &Backend) -> GpuInfo {
    if backend.name != "voxtype" {
        return GpuInfo::default();
    }
    match crate::proc::command(&backend.path)
        .args(["setup", "gpu", "--status"])
        .output()
    {
        Ok(out) => parse_gpu_status(&String::from_utf8_lossy(&out.stdout)),
        Err(_) => GpuInfo::default(),
    }
}

pub fn install_hint() -> String {
    "No local transcription CLI found. Install whisper.cpp (which provides `whisper-cli`) \
     or Voxtype (https://github.com/voxtype/voxtype) to enable on-device transcription."
        .to_string()
}

// ---------------------------------------------------------------------------
// Model metadata
// ---------------------------------------------------------------------------

fn accuracy_rank(name: &str) -> u32 {
    match name {
        "tiny" | "tiny.en" => 1,
        "base" | "base.en" => 2,
        "small" | "small.en" => 3,
        "medium" | "medium.en" => 4,
        "large-v3" | "large-v3-turbo" | "large-v3-turbo-q5_0" => 5,
        "parakeet-tdt-0.6b-v3" | "parakeet-tdt-0.6b-v2" => 6,
        _ => 0,
    }
}

fn is_recommended(name: &str) -> bool {
    matches!(name, "large-v3-turbo" | "large-v3-turbo-q5_0" | "parakeet-tdt-0.6b-v3")
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

fn build_model(
    name: &str,
    engine: &str,
    installed: bool,
    downloadable: bool,
    path: Option<String>,
    size: Option<u64>,
) -> NativeModel {
    NativeModel {
        name: name.to_string(),
        engine: engine.to_string(),
        installed,
        downloadable,
        path,
        size_bytes: size,
        accuracy: accuracy_rank(name),
        recommended: is_recommended(name),
        detail: detail_for(name, size),
    }
}

/// Model a whisper.cpp backend fetches on first use: large-v3-turbo quantized
/// to 5 bits — ~550 MB instead of 1.6 GB, practically the same accuracy, and
/// faster on CPUs.
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

/// Merge the backend catalog with models present on disk.
/// Returns (engine names, models).
pub fn collect_models(backend: Option<&Backend>) -> (Vec<String>, Vec<NativeModel>) {
    let disk = disk_models();
    let mut engines: Vec<String> = Vec::new();
    let mut models: Vec<NativeModel> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    let is_voxtype = backend.map(|b| b.name == "voxtype").unwrap_or(false);
    if is_voxtype {
        if let Some(b) = backend {
            let engine_caps = voxtype_engine_caps(&b.path).unwrap_or_default();
            if let Some((catalog_engines, catalog_models)) = voxtype_catalog(&b.path) {
                engines = catalog_engines;
                for (engine, entry) in catalog_models {
                    let on_disk = disk.iter().find(|d| d.name == entry.name);
                    let installed = entry.installed || on_disk.is_some();
                    let path = on_disk.and_then(|d| d.path.clone());
                    let size = on_disk.and_then(|d| d.size_bytes);
                    seen.insert(entry.name.clone());
                    let mut model = build_model(
                        &entry.name,
                        &engine,
                        installed,
                        entry.downloadable,
                        path,
                        size,
                    );
                    // Engine not compiled into this build -> cannot download or use.
                    if engine_caps.get(&engine) == Some(&false) {
                        model.downloadable = false;
                        model.recommended = false;
                        let note = format!("requires a voxtype build with the {} feature", engine);
                        model.detail = if model.detail.is_empty() {
                            note
                        } else {
                            format!("{} · {}", model.detail, note)
                        };
                    }
                    models.push(model);
                }
            }
            // Only report engines this build can actually run.
            if !engine_caps.is_empty() {
                engines.retain(|e| engine_caps.get(e) == Some(&true));
            }
        }
    }

    // No usable catalog -> static whisper fallback.
    if models.is_empty() {
        for name in STATIC_WHISPER_CATALOG {
            let on_disk = disk.iter().find(|d| d.name == name);
            let path = on_disk.and_then(|d| d.path.clone());
            let size = on_disk.and_then(|d| d.size_bytes);
            seen.insert(name.to_string());
            models.push(build_model(
                name,
                "whisper",
                on_disk.is_some(),
                true,
                path,
                size,
            ));
        }
    }

    // Append on-disk models that the catalog did not know about.
    for model in &disk {
        if seen.contains(&model.name) {
            continue;
        }
        seen.insert(model.name.clone());
        models.push(model.clone());
    }

    (engines, models)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "\
=== Voxtype Backend Status ===

Active backend: CPU (AVX-512) (daemon pid 1192)
  Binary: /usr/lib/voxtype/voxtype-avx512

Installation mode: tiered (pre-built)

Available backends:
  CPU (AVX2) - installed
  CPU (AVX-512) - active
  GPU (Vulkan) - installed

GPUs detected:
  1. [Intel] Intel Corporation Tiger Lake-LP GT2 [UHD Graphics G4] (rev 01)

Vulkan runtime: installed

To enable GPU acceleration:
  sudo voxtype setup gpu --enable
";

    #[test]
    fn parses_gpu_status_with_gpu_available() {
        let gpu = parse_gpu_status(SAMPLE);
        assert!(gpu.available);
        assert!(!gpu.active);
        assert_eq!(gpu.backend.as_deref(), Some("Vulkan"));
        assert_eq!(gpu.devices.len(), 1);
        assert!(gpu.devices[0].contains("Intel"));
        assert_eq!(gpu.hint.as_deref(), Some("sudo voxtype setup gpu --enable"));
    }

    #[test]
    fn parses_gpu_status_when_active() {
        let text = SAMPLE
            .replace("Active backend: CPU (AVX-512) (daemon pid 1192)", "Active backend: GPU (Vulkan)");
        let gpu = parse_gpu_status(&text);
        assert!(gpu.active);
        assert!(gpu.available);
    }

    #[test]
    fn parses_gpu_status_without_gpu() {
        let text = "\
Active backend: CPU (AVX-512)

Available backends:
  CPU (AVX2) - installed
  CPU (AVX-512) - active

GPUs detected:

To enable GPU acceleration:
  sudo voxtype setup gpu --enable
";
        let gpu = parse_gpu_status(text);
        assert!(!gpu.available);
        assert!(!gpu.active);
        assert!(gpu.devices.is_empty());
    }
}
