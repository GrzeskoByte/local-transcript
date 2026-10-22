#!/usr/bin/env bash
# Fetch the local speaker-detection runtime into src-tauri/diarize/ for one
# Rust target (bundled as a resource by src-tauri/tauri.diarize.conf.json):
#   sherpa-onnx-offline-speaker-diarization[.exe]   (PyPI sherpa-onnx-bin)
#   onnxruntime library                              (PyPI sherpa-onnx-core)
#   segmentation.onnx  pyannote segmentation 3.0, int8   (sherpa-onnx release)
#   embedding.onnx     NeMo TitaNet small speaker embedding (sherpa-onnx release)
# Everything is pinned and SHA-256 checked. Runs at build time only: the app
# itself never downloads any of this.
#
# Usage: scripts/fetch-diarizer.sh <rust-target-triple> [out-dir]
set -euo pipefail

TARGET="${1:?usage: fetch-diarizer.sh <rust-target> [out-dir]}"
OUT="${2:-src-tauri/diarize}"
VERSION="1.13.8"
MODELS="https://github.com/k2-fsa/sherpa-onnx/releases/download"
SEG_URL="$MODELS/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2"
EMB_URL="$MODELS/speaker-recongition-models/nemo_en_titanet_small.onnx"
SEG_SHA=24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488
EMB_SHA=ad4a1802485d8b34c722d2a9d04249662f2ece5d28a7a039063ca22f515a789e

case "$TARGET" in
  x86_64-unknown-linux-gnu)  WHEEL=manylinux2014_x86_64;  BIN=sherpa-onnx-offline-speaker-diarization;     LIB=libonnxruntime.so ;;
  aarch64-unknown-linux-gnu) WHEEL=manylinux2014_aarch64; BIN=sherpa-onnx-offline-speaker-diarization;     LIB=libonnxruntime.so ;;
  aarch64-apple-darwin)      WHEEL=macosx_11_0_arm64;     BIN=sherpa-onnx-offline-speaker-diarization;     LIB=libonnxruntime.dylib ;;
  x86_64-apple-darwin)       WHEEL=macosx_10_15_x86_64;   BIN=sherpa-onnx-offline-speaker-diarization;     LIB=libonnxruntime.dylib ;;
  x86_64-pc-windows-msvc)    WHEEL=win_amd64;             BIN=sherpa-onnx-offline-speaker-diarization.exe; LIB=onnxruntime.dll ;;
  aarch64-pc-windows-msvc)   WHEEL=win_arm64;             BIN=sherpa-onnx-offline-speaker-diarization.exe; LIB=onnxruntime.dll ;;
  *) echo "No speaker-detection runtime for $TARGET" >&2; exit 1 ;;
esac

PY=$(command -v python3 || command -v python)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT"

# PyPI: the wheel for this platform, its URL and sha256 from the JSON API.
wheel() {
  local pkg="$1"
  "$PY" - "$pkg" "$VERSION" "$WHEEL" <<'PY'
import json, sys, urllib.request
pkg, ver, tag = sys.argv[1:]
data = json.load(urllib.request.urlopen(f"https://pypi.org/pypi/{pkg}/{ver}/json"))
for u in data["urls"]:
    if u["filename"].endswith(f"-{tag}.whl") or f"-{tag}." in u["filename"]:
        print(u["url"], u["digests"]["sha256"]); break
else:
    sys.exit(f"no {pkg} {ver} wheel for {tag}")
PY
}

check() { echo "$1  $2" | (sha256sum -c - 2>/dev/null || shasum -a 256 -c -); }

fetch_wheel() {
  local pkg="$1" dest="$2"
  read -r url sha < <(wheel "$pkg")
  curl -fsSL --retry 3 -o "$dest" "$url"
  check "$sha" "$dest"
}

fetch_wheel sherpa-onnx-bin "$WORK/bin.whl"
fetch_wheel sherpa-onnx-core "$WORK/core.whl"
"$PY" -m zipfile -e "$WORK/bin.whl" "$WORK/bin"
"$PY" -m zipfile -e "$WORK/core.whl" "$WORK/core"

cp "$(find "$WORK/bin" -name "$BIN" -type f | head -1)" "$OUT/$BIN"
cp "$(find "$WORK/core" -path '*sherpa_onnx/lib*' -name "$LIB" -type f | head -1)" "$OUT/$LIB"
chmod +x "$OUT/$BIN"

curl -fsSL --retry 3 -o "$WORK/seg.tar.bz2" "$SEG_URL"
check "$SEG_SHA" "$WORK/seg.tar.bz2"
tar -xjf "$WORK/seg.tar.bz2" -C "$WORK"
cp "$WORK/sherpa-onnx-pyannote-segmentation-3-0/model.int8.onnx" "$OUT/segmentation.onnx"
cp "$WORK/sherpa-onnx-pyannote-segmentation-3-0/LICENSE" "$OUT/LICENSE-pyannote-segmentation.txt"
curl -fsSL --retry 3 -o "$OUT/embedding.onnx" "$EMB_URL"
check "$EMB_SHA" "$OUT/embedding.onnx"

cat > "$OUT/NOTICE.txt" <<EOF
Speaker detection runtime (bundled, runs offline):
- sherpa-onnx $VERSION (Apache-2.0) — https://github.com/k2-fsa/sherpa-onnx
- ONNX Runtime (MIT) — https://github.com/microsoft/onnxruntime
- pyannote segmentation 3.0 (MIT, see LICENSE-pyannote-segmentation.txt)
- NVIDIA NeMo TitaNet small (CC-BY-4.0) — https://catalog.ngc.nvidia.com/orgs/nvidia/teams/nemo/models/titanet_small
EOF

# Smoke test where the runner can execute the target (prints the CLI help).
if "$OUT/$BIN" --help >/dev/null 2>&1; then
  echo "speaker detection runtime OK for $TARGET"
else
  echo "::notice::speaker detection runtime not executable on this runner ($TARGET) — skipped the smoke test"
fi
ls -la "$OUT"
