#!/usr/bin/env bash
# Curate the GStreamer plugins bundled into the AppImage.
#
# WebKitGTK does microphone/screen capture, MediaRecorder encoding, <audio>
# playback and decodeAudioData through GStreamer. The AppImage's AppRun points
# GStreamer at plugins inside the bundle only, so without them WebKit sees
# "0 devices" and getUserMedia fails with "Invalid constraint".
#
# Tauri's `bundleMediaFramework` (linuxdeploy-plugin-gstreamer) copies every
# plugin in $GSTREAMER_PLUGINS_DIR. Pointing it at this curated folder keeps
# the bundle small and, crucially, leaves out souphttpsrc (it would load
# libsoup2 into WebKit's libsoup3 process and abort) and other plugins with
# heavy or conflicting dependencies.
#
# Usage: scripts/gst-plugins.sh <out-dir> [system-plugin-dir]
# Prints `GSTREAMER_PLUGINS_DIR=<out-dir>` for $GITHUB_ENV.
set -euo pipefail

out=${1:?usage: gst-plugins.sh <out-dir> [system-plugin-dir]}
src=${2:-}
if [ -z "$src" ]; then
  for d in "/usr/lib/$(uname -m)-linux-gnu/gstreamer-1.0" /usr/lib64/gstreamer-1.0 /usr/lib/gstreamer-1.0; do
    [ -d "$d" ] && { src=$d; break; }
  done
fi
[ -d "$src" ] || { echo "No GStreamer plugin directory found" >&2; exit 1; }

# Needed: without these capture, recording, playback or decoding breaks.
required=(
  coreelements        # queue, tee, capsfilter… (gstreamer core)
  app                 # appsrc/appsink (WebKit's media plumbing)
  audioconvert audioresample audiomixer audiorate volume
  playback            # playbin/decodebin/uridecodebin (<audio>, decodeAudioData)
  typefindfunctions
  encoding transcode  # encodebin + (uri)transcodebin (MediaRecorder; transcode is in -bad)
  opus ogg            # Opus in WebM/Ogg (recording format + playback)
  matroska            # webmmux / matroskademux
  pulseaudio          # pulsesrc/pulsesink — PulseAudio and PipeWire-Pulse
  autodetect          # autoaudiosink
  interleave          # (de)interleave for Web Audio decoding
  pbtypes
)
# Useful: imports, video-bearing screen capture, echo cancellation.
optional=(
  pipewire            # pipewiresrc (screen capture via the portal)
  gio rawparse vorbis wavparse wavenc audioparsers isomp4 mpg123 flac id3demux apetag
  videoconvert videoscale videoconvertscale videorate vpx
  webrtcdsp           # echoCancellation/noiseSuppression constraints
  audiotestsrc
)

rm -rf "$out"
mkdir -p "$out"
missing=()
for name in "${required[@]}"; do
  f="$src/libgst$name.so"
  if [ -f "$f" ]; then ln -s "$f" "$out/"; else missing+=("$name"); fi
done
for name in "${optional[@]}"; do
  f="$src/libgst$name.so"
  if [ -f "$f" ]; then ln -s "$f" "$out/"; else echo "note: optional GStreamer plugin '$name' not installed" >&2; fi
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "Missing required GStreamer plugins in $src: ${missing[*]}" >&2
  exit 1
fi
echo "Bundling $(ls "$out" | wc -l) GStreamer plugins from $src" >&2
echo "GSTREAMER_PLUGINS_DIR=$(cd "$out" && pwd)"
