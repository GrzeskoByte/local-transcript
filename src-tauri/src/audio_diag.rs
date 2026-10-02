//! Sound-server log while recording (Linux, PulseAudio/PipeWire via `pactl`).
//!
//! Meeting audio problems usually come from the sound server, not the app:
//! a Bluetooth headset switching to call mode (A2DP → HFP/HSP: narrowband
//! audio, the hi-fi output disappears) when Zoom opens its microphone, the
//! default output or input changing mid-call, devices dropping out. While a
//! recording runs we follow `pactl subscribe` and snapshot default devices
//! and card profiles on every server/card change, so the meeting can explain
//! afterwards what happened and when. Read-only: nothing is changed.

use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::process::{Child, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Instant;

/// Bounded log: a pathological sound server must not grow it without limit.
const MAX_EVENTS: usize = 300;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CardState {
    pub name: String,
    pub description: String,
    pub profile: String,
    /// Bluetooth codec when reported (`api.bluez5.codec`).
    pub codec: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AudioSnapshot {
    pub default_sink: Option<String>,
    pub default_source: Option<String>,
    pub cards: Vec<CardState>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDiagEvent {
    /// Milliseconds since the log started.
    pub at_ms: u64,
    /// `pactl subscribe` line, e.g. `Event 'change' on card #51`.
    pub event: String,
    /// State after a server/card change.
    pub snapshot: Option<AudioSnapshot>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDiagLog {
    pub server: Option<String>,
    pub start: AudioSnapshot,
    pub events: Vec<AudioDiagEvent>,
    /// Events dropped past MAX_EVENTS.
    pub dropped: usize,
}

struct Session {
    child: Child,
    log: Arc<Mutex<AudioDiagLog>>,
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);

fn pactl(args: &[&str]) -> Option<String> {
    crate::system_audio::pactl(args).ok()
}

pub fn parse_info(info: &str) -> (Option<String>, Option<String>, Option<String>) {
    let field = |key: &str| {
        info.lines()
            .find_map(|l| l.trim().strip_prefix(key).map(|v| v.trim().to_string()))
            .filter(|v| !v.is_empty())
    };
    (field("Server Name:"), field("Default Sink:"), field("Default Source:"))
}

/// Cards from `pactl list cards` (text: `-f json` needs PulseAudio 16+).
pub fn parse_cards(list: &str) -> Vec<CardState> {
    let mut cards: Vec<CardState> = Vec::new();
    for raw in list.lines() {
        let line = raw.trim();
        if line.starts_with("Card #") {
            cards.push(CardState { name: String::new(), description: String::new(), profile: String::new(), codec: None });
            continue;
        }
        let Some(card) = cards.last_mut() else { continue };
        let prop = |key: &str| {
            line.strip_prefix(key)
                .map(|v| v.trim().trim_start_matches('=').trim().trim_matches('"').to_string())
        };
        if let Some(v) = line.strip_prefix("Name:") {
            card.name = v.trim().to_string();
        } else if let Some(v) = line.strip_prefix("Active Profile:") {
            card.profile = v.trim().to_string();
        } else if let Some(v) = prop("device.description") {
            if card.description.is_empty() {
                card.description = v;
            }
        } else if let Some(v) = prop("api.bluez5.codec") {
            card.codec = Some(v);
        }
    }
    cards.retain(|c| !c.name.is_empty());
    cards
}

fn snapshot() -> AudioSnapshot {
    let (_, default_sink, default_source) = pactl(&["info"]).map(|i| parse_info(&i)).unwrap_or((None, None, None));
    let cards = pactl(&["list", "cards"]).map(|l| parse_cards(&l)).unwrap_or_default();
    AudioSnapshot { default_sink, default_source, cards }
}

/// Events worth logging: default-device changes (server), profile switches
/// (card), and outputs/inputs appearing or disappearing.
pub fn interesting(line: &str) -> bool {
    line.contains(" on server")
        || line.contains(" on card ")
        || ((line.contains("'new'") || line.contains("'remove'")) && (line.contains(" on sink #") || line.contains(" on source #")))
}

fn stop_session() -> Option<AudioDiagLog> {
    let mut session = SESSION.lock().ok()?.take()?;
    let _ = session.child.kill();
    let _ = session.child.wait();
    let log = session.log.lock().ok()?.clone();
    Some(log)
}

/// Start logging (replaces a previous log). `None` when there is no
/// `pactl`/sound server (macOS, Windows, minimal Linux).
#[tauri::command]
pub async fn native_audio_diag_start() -> Option<AudioSnapshot> {
    tauri::async_runtime::spawn_blocking(|| {
        if !cfg!(target_os = "linux") {
            return None;
        }
        let _ = stop_session();
        let info = pactl(&["info"])?;
        let (server, _, _) = parse_info(&info);
        let start = snapshot();
        let mut child = crate::proc::command("pactl")
            .arg("subscribe")
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        let stdout = child.stdout.take()?;
        let log = Arc::new(Mutex::new(AudioDiagLog { server, start: start.clone(), events: Vec::new(), dropped: 0 }));
        let sink = Arc::clone(&log);
        let began = Instant::now();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if !interesting(&line) {
                    continue;
                }
                let needs_state = line.contains(" on server") || line.contains(" on card ");
                let state = needs_state.then(snapshot);
                let Ok(mut log) = sink.lock() else { break };
                if log.events.len() >= MAX_EVENTS {
                    log.dropped += 1;
                    continue;
                }
                // Snapshots that did not change are noise (servers emit many 'change's).
                let last = log.events.iter().rev().find_map(|e| e.snapshot.as_ref()).unwrap_or(&log.start);
                if needs_state && state.as_ref() == Some(last) {
                    continue;
                }
                log.events.push(AudioDiagEvent {
                    at_ms: began.elapsed().as_millis() as u64,
                    event: line.trim().to_string(),
                    snapshot: state,
                });
            }
        });
        if let Ok(mut slot) = SESSION.lock() {
            *slot = Some(Session { child, log });
        }
        Some(start)
    })
    .await
    .ok()
    .flatten()
}

/// The log so far, without stopping (saved periodically for crash recovery).
#[tauri::command]
pub fn native_audio_diag_peek() -> Option<AudioDiagLog> {
    let slot = SESSION.lock().ok()?;
    let log = slot.as_ref()?.log.lock().ok()?.clone();
    Some(log)
}

/// Stop logging and return the log.
#[tauri::command]
pub async fn native_audio_diag_stop() -> Option<AudioDiagLog> {
    tauri::async_runtime::spawn_blocking(stop_session).await.ok().flatten()
}

/// App exit: never leave `pactl subscribe` running.
pub fn shutdown() {
    let _ = stop_session();
}

#[cfg(test)]
mod tests {
    use super::*;

    const CARDS: &str = r#"Card #51
	Name: alsa_card.pci-0000_00_1f.3
	Driver: alsa
	Properties:
		device.description = "Built-in Audio"
	Active Profile: output:analog-stereo+input:analog-stereo
Card #77
	Name: bluez_card.AA_BB_CC_DD_EE_FF
	Properties:
		device.description = "WH-1000XM4"
		api.bluez5.codec = "msbc"
	Profiles:
		a2dp-sink: High Fidelity Playback (A2DP Sink)
	Active Profile: headset-head-unit
"#;

    #[test]
    fn parses_cards_with_bluetooth_profile_and_codec() {
        let cards = parse_cards(CARDS);
        assert_eq!(cards.len(), 2);
        assert_eq!(cards[0].description, "Built-in Audio");
        assert_eq!(cards[0].profile, "output:analog-stereo+input:analog-stereo");
        assert_eq!(cards[0].codec, None);
        assert_eq!(cards[1].name, "bluez_card.AA_BB_CC_DD_EE_FF");
        assert_eq!(cards[1].profile, "headset-head-unit");
        assert_eq!(cards[1].codec.as_deref(), Some("msbc"));
    }

    #[test]
    fn parses_server_and_defaults() {
        let info = "Server Name: PulseAudio (on PipeWire 1.6.8)\nDefault Sink: alsa_output.x\nDefault Source: alsa_input.y\n";
        assert_eq!(
            parse_info(info),
            (
                Some("PulseAudio (on PipeWire 1.6.8)".into()),
                Some("alsa_output.x".into()),
                Some("alsa_input.y".into())
            )
        );
    }

    #[test]
    fn filters_subscribe_events() {
        assert!(interesting("Event 'change' on server #4294967295"));
        assert!(interesting("Event 'change' on card #77"));
        assert!(interesting("Event 'remove' on sink #80"));
        assert!(interesting("Event 'new' on source #81"));
        assert!(!interesting("Event 'change' on sink #60"));
        assert!(!interesting("Event 'new' on source-output #90"));
        assert!(!interesting("Event 'change' on client #12"));
    }

    /// `cargo test -- --ignored audio_diag_real`: against the host sound server.
    #[test]
    #[ignore]
    fn audio_diag_real_snapshot() {
        let snap = snapshot();
        eprintln!("{snap:#?}");
        assert!(snap.default_sink.is_some());
        assert!(!snap.cards.is_empty());
    }
}
