//! System ("device") audio on Linux.
//!
//! WebKitGTK only lists real capture devices — never PulseAudio/PipeWire
//! "Monitor of …" sources — and its getDisplayMedia returns video only, so a
//! Linux desktop had no way to record what the computer plays (the other side
//! of a call). While a recording needs it, we expose the default output's
//! monitor as an ordinary virtual source (`module-remap-source`, supported by
//! PulseAudio and PipeWire's pulse server) that WebKit lists as an audio
//! input; the frontend records it with getUserMedia like a microphone, so
//! MediaRecorder, OPFS chunks and crash recovery work unchanged. The source is
//! removed when the recording stops, when the app exits, and (leftovers from
//! a crash) when the app starts.

use serde::Serialize;

/// PulseAudio source name of the virtual source.
pub const SOURCE_NAME: &str = "local_transcribe_system_audio";
/// Its description, which WebKit shows as the device label. No spaces:
/// PipeWire's pulse server cuts quoted property values at the first space.
pub const SOURCE_LABEL: &str = "Local_Transcribe_system_audio";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemAudioStatus {
    /// True when system audio can be captured through the virtual source.
    pub available: bool,
    /// Why not (missing `pactl`, no sound server), for the UI.
    pub hint: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemAudioSource {
    /// Device label to pick in `enumerateDevices()`.
    pub label: String,
    /// Output whose sound is captured (e.g. `alsa_output….analog-stereo`).
    pub sink: String,
}

/// One output (sink) whose sound can be captured.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SystemAudioOutput {
    /// Sink name passed back to `native_system_audio_start`.
    pub name: String,
    /// Human-readable name (`Description:`), falls back to the sink name.
    pub description: String,
    pub is_default: bool,
}

fn pactl(args: &[&str]) -> Result<String, String> {
    let out = crate::proc::command("pactl")
        .args(args)
        .output()
        .map_err(|e| format!("could not run `pactl` ({e}). Install pulseaudio-utils (it works with PipeWire too)."))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() { format!("`pactl {}` failed", args.join(" ")) } else { err })
    }
}

/// Default output: `pactl get-default-sink`, or the `Default Sink:` line of
/// `pactl info` on older pactl builds.
fn default_sink() -> Result<String, String> {
    if let Ok(sink) = pactl(&["get-default-sink"]) {
        if !sink.is_empty() {
            return Ok(sink);
        }
    }
    let info = pactl(&["info"])?;
    parse_default_sink(&info).ok_or_else(|| "The sound server reports no default output.".to_string())
}

fn parse_default_sink(info: &str) -> Option<String> {
    info.lines()
        .find_map(|l| l.trim().strip_prefix("Default Sink:"))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && s != "@DEFAULT_SINK@")
}

/// Sinks from `pactl list sinks` (text output: `-f json` needs PulseAudio 16+).
fn parse_sinks(list: &str, default: Option<&str>) -> Vec<SystemAudioOutput> {
    let mut out: Vec<SystemAudioOutput> = Vec::new();
    for line in list.lines() {
        let t = line.trim();
        if t.starts_with("Sink #") {
            out.push(SystemAudioOutput { name: String::new(), description: String::new(), is_default: false });
        } else if let Some(cur) = out.last_mut() {
            if let Some(v) = t.strip_prefix("Name:") {
                if cur.name.is_empty() {
                    cur.name = v.trim().to_string();
                }
            } else if let Some(v) = t.strip_prefix("Description:") {
                if cur.description.is_empty() {
                    cur.description = v.trim().to_string();
                }
            }
        }
    }
    out.retain(|s| !s.name.is_empty());
    for s in &mut out {
        if s.description.is_empty() {
            s.description = s.name.clone();
        }
        s.is_default = default == Some(s.name.as_str());
    }
    out
}

/// A sink name we pass to `pactl` as part of one argument (`master=<sink>.monitor`).
fn valid_sink_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 256
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | ':' | '@'))
}

/// Module indexes of our virtual source(s) in `pactl list short modules`.
fn our_modules(list: &str) -> Vec<String> {
    list.lines()
        .filter(|l| l.contains("module-remap-source") && l.contains(&format!("source_name={SOURCE_NAME}")))
        .filter_map(|l| l.split_whitespace().next().map(str::to_string))
        .collect()
}

/// Remove every virtual source this app created. Best-effort.
pub fn remove_sources() {
    if !cfg!(target_os = "linux") {
        return;
    }
    if let Ok(list) = pactl(&["list", "short", "modules"]) {
        for id in our_modules(&list) {
            let _ = pactl(&["unload-module", &id]);
        }
    }
}

#[tauri::command]
pub fn native_system_audio_status() -> SystemAudioStatus {
    if !cfg!(target_os = "linux") {
        return SystemAudioStatus { available: false, hint: None };
    }
    match pactl(&["info"]) {
        Ok(info) if parse_default_sink(&info).is_some() || pactl(&["get-default-sink"]).is_ok() => {
            SystemAudioStatus { available: true, hint: None }
        }
        Ok(_) => SystemAudioStatus {
            available: false,
            hint: Some("The sound server reports no output device to capture.".into()),
        },
        Err(e) => SystemAudioStatus { available: false, hint: Some(e) },
    }
}

/// Outputs the user can choose to record from (Settings / New Meeting).
#[tauri::command]
pub async fn native_system_audio_outputs() -> Result<Vec<SystemAudioOutput>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        if !cfg!(target_os = "linux") {
            return Ok(Vec::new());
        }
        let default = default_sink().ok();
        let list = pactl(&["list", "sinks"])?;
        Ok(parse_sinks(&list, default.as_deref()))
    })
    .await
    .map_err(|e| format!("System audio task failed: {e}"))?
}

/// Create (or reuse) the virtual source over an output's monitor: the chosen
/// `sink` when it still exists, otherwise the default output.
#[tauri::command]
pub async fn native_system_audio_start(sink: Option<String>) -> Result<SystemAudioSource, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !cfg!(target_os = "linux") {
            return Err("System audio capture through the sound server is Linux-only.".to_string());
        }
        let chosen = sink.filter(|s| valid_sink_name(s)).filter(|s| {
            pactl(&["list", "short", "sinks"])
                .map(|l| l.lines().any(|line| line.split_whitespace().nth(1) == Some(s.as_str())))
                .unwrap_or(false)
        });
        let sink = match chosen {
            Some(s) => s,
            None => default_sink()?,
        };
        // A stale source (crash, other sink) is replaced so it follows the
        // current default output.
        remove_sources();
        let master = format!("master={sink}.monitor");
        let name = format!("source_name={SOURCE_NAME}");
        let props = format!("source_properties=device.description={SOURCE_LABEL}");
        pactl(&["load-module", "module-remap-source", &master, &name, &props])
            .map_err(|e| format!("Could not set up system audio capture: {e}"))?;
        Ok(SystemAudioSource { label: SOURCE_LABEL.to_string(), sink })
    })
    .await
    .map_err(|e| format!("System audio task failed: {e}"))?
}

/// Remove the virtual source (recording stopped).
#[tauri::command]
pub async fn native_system_audio_stop() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(remove_sources)
        .await
        .map_err(|e| format!("System audio task failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_default_sink_from_pactl_info() {
        let info = "Server Name: PulseAudio (on PipeWire 1.6.8)\nDefault Sink: alsa_output.pci-0000_00_1f.3.analog-stereo\nDefault Source: x";
        assert_eq!(parse_default_sink(info).as_deref(), Some("alsa_output.pci-0000_00_1f.3.analog-stereo"));
        assert_eq!(parse_default_sink("Default Sink: @DEFAULT_SINK@"), None);
        assert_eq!(parse_default_sink("nothing"), None);
    }

    #[test]
    fn parses_sinks_with_descriptions_and_default() {
        let list = "Sink #55\n\tState: RUNNING\n\tName: alsa_output.pci.analog-stereo\n\tDescription: Built-in Audio Analog Stereo\n\tDriver: PipeWire\n\tProperties:\n\t\tdevice.description = \"x\"\n\nSink #61\n\tName: bluez_output.AA_BB.1\n\tDescription: WH-1000XM4\n";
        let sinks = parse_sinks(list, Some("bluez_output.AA_BB.1"));
        assert_eq!(
            sinks,
            vec![
                SystemAudioOutput {
                    name: "alsa_output.pci.analog-stereo".into(),
                    description: "Built-in Audio Analog Stereo".into(),
                    is_default: false,
                },
                SystemAudioOutput { name: "bluez_output.AA_BB.1".into(), description: "WH-1000XM4".into(), is_default: true },
            ]
        );
    }

    #[test]
    fn rejects_unsafe_sink_names() {
        assert!(valid_sink_name("alsa_output.pci-0000_00_1f.3.analog-stereo"));
        assert!(valid_sink_name("bluez_output.AA_BB_CC.1"));
        assert!(!valid_sink_name(""));
        assert!(!valid_sink_name("a b"));
        assert!(!valid_sink_name("x source_name=evil"));
    }

    #[test]
    fn finds_only_our_remap_modules() {
        let list = "536870913\tmodule-null-sink\tsink_name=x\n\
                    536870916\tmodule-remap-source\tmaster=a.monitor source_name=local_transcribe_system_audio source_properties=device.description=Local_Transcribe_system_audio\n\
                    536870920\tmodule-remap-source\tmaster=b.monitor source_name=someone_else";
        assert_eq!(our_modules(list), vec!["536870916".to_string()]);
    }
}
