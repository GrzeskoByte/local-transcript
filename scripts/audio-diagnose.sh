#!/usr/bin/env bash
# Log what the sound server does during a call (Linux, PipeWire/PulseAudio).
#
#   scripts/audio-diagnose.sh [logfile]      # start BEFORE joining Zoom, Ctrl+C after
#
# Records, with timestamps:
#   - default output/input changes (Zoom or the headset switching them),
#   - Bluetooth profile switches (A2DP hi-fi ↔ HFP/HSP "headset" call mode:
#     8/16 kHz narrowband, and the A2DP sink disappears),
#   - sinks/sources appearing/disappearing (incl. Local Transcribe's
#     `local_transcribe_system_audio` source),
#   - every 5 s: default devices, card profiles, BT codec, who records/plays.
# Then run scripts/analyze-recording.py on the meeting folder.
set -u
log="${1:-audio-diagnose-$(date +%Y%m%d-%H%M%S).log}"
ts() { date '+%H:%M:%S.%3N'; }

snapshot() {
  echo "--- $(ts) snapshot"
  pactl info | grep -E 'Default (Sink|Source)'
  pactl list cards | grep -E '^\s*(Name|Active Profile|api.bluez5.codec|bluez5.profile|device.description) ' | sed 's/^\s*/  /'
  echo "  recording streams:"
  pactl list source-outputs | grep -E 'application.name|media.name|target.object|Source:' | sed 's/^\s*/    /'
  echo "  playback streams:"
  pactl list sink-inputs | grep -E 'application.name|media.name|Sink:' | sed 's/^\s*/    /'
}

{
  echo "=== audio-diagnose start $(date -Is)"
  pactl info
  echo "--- sinks"; pactl list sinks short
  echo "--- sources"; pactl list sources short
  snapshot
} >>"$log"

# Events (server = default-device changes, card = profile switches).
pactl subscribe 2>/dev/null | while read -r line; do
  case "$line" in
    *"on server"*|*"on card"*|*"'new' on sink #"*|*"'remove' on sink #"*|*"'new' on source #"*|*"'remove' on source #"*)
      echo "$(ts) $line"
      case "$line" in *"on server"*|*"on card"*) snapshot ;; esac
      ;;
  esac
done >>"$log" &
sub=$!

trap 'kill $sub 2>/dev/null; echo "=== stop $(date -Is)" >>"$log"; echo; echo "Log: $log"; exit 0' INT TERM
echo "Logging to $log — join the call, record in Local Transcribe, then press Ctrl+C."
while true; do sleep 5; snapshot >>"$log"; done
