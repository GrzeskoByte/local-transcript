#!/usr/bin/env bash
# Build the whisper.cpp CLI that ships inside the app as a Tauri sidecar
# (src-tauri/binaries/lt-whisper-<target-triple>[.exe]), so a fresh install
# can transcribe without the user installing anything.
#
#   scripts/build-engine.sh <rust-target-triple> [whisper.cpp tag]
#
# Portable by design: no -march=native (a CI CPU's features would crash older
# machines), no OpenMP (no extra runtime libraries), static C/C++ runtimes.
# macOS builds use Metal (GPU) with the shader library embedded.
set -euo pipefail

TARGET="${1:?usage: build-engine.sh <target-triple> [whisper.cpp tag]}"
VERSION="${2:-${WHISPER_CPP_VERSION:-v1.9.4}}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${RUNNER_TEMP:-/tmp}/whisper.cpp-$VERSION-$TARGET"
# Git Bash on Windows: RUNNER_TEMP is a backslash path (D:\a\_temp) that MSYS
# tools such as `find` mishandle; use the POSIX form (MSYS converts it back
# for native programs like cmake and git).
if command -v cygpath >/dev/null 2>&1; then
  WORK="$(cygpath -u "$WORK")"
  ROOT="$(cygpath -u "$ROOT")"
fi
OUT_DIR="$ROOT/src-tauri/binaries"

rm -rf "$WORK"
git clone --quiet --depth 1 --branch "$VERSION" https://github.com/ggml-org/whisper.cpp "$WORK"

ARGS=(
  -DCMAKE_BUILD_TYPE=Release
  -DBUILD_SHARED_LIBS=OFF
  -DWHISPER_BUILD_EXAMPLES=ON
  -DWHISPER_BUILD_TESTS=OFF
  -DWHISPER_BUILD_SERVER=OFF
  -DWHISPER_SDL2=OFF
  # No network code in the shipped engine: no URL model downloads, no RPC backend.
  -DWHISPER_CURL=OFF
  -DGGML_RPC=OFF
  -DGGML_NATIVE=OFF
  -DGGML_OPENMP=OFF
)
X86_BASELINE=(-DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON)
EXT=""
case "$TARGET" in
  x86_64-unknown-linux-gnu|aarch64-unknown-linux-gnu)
    ARGS+=(-DCMAKE_EXE_LINKER_FLAGS="-static-libstdc++ -static-libgcc")
    [[ "$TARGET" == x86_64* ]] && ARGS+=("${X86_BASELINE[@]}")
    ;;
  aarch64-apple-darwin)
    ARGS+=(-DCMAKE_OSX_ARCHITECTURES=arm64 -DCMAKE_OSX_DEPLOYMENT_TARGET=12.0
           -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON)
    ;;
  x86_64-apple-darwin)
    ARGS+=(-DCMAKE_OSX_ARCHITECTURES=x86_64 -DCMAKE_OSX_DEPLOYMENT_TARGET=12.0
           -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON "${X86_BASELINE[@]}")
    ;;
  x86_64-pc-windows-msvc)
    # Default generator = newest installed Visual Studio (runner images move on).
    EXT=".exe"
    ARGS+=(-A x64
           -DCMAKE_POLICY_DEFAULT_CMP0091=NEW -DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded
           "${X86_BASELINE[@]}")
    ;;
  aarch64-pc-windows-msvc)
    # ggml does not support MSVC for ARM64; use the clang-cl toolset.
    EXT=".exe"
    ARGS+=(-A ARM64 -T ClangCL
           -DCMAKE_POLICY_DEFAULT_CMP0091=NEW -DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded)
    ;;
  *)
    echo "unsupported target: $TARGET" >&2; exit 2 ;;
esac

echo "cmake $(cmake --version | head -1); args: ${ARGS[*]}"
cmake -S "$WORK" -B "$WORK/build" "${ARGS[@]}"
cmake --build "$WORK/build" --config Release --target whisper-cli -j 4

BIN="$(find "$WORK/build" -type f -name "whisper-cli$EXT" | head -1)"
[[ -n "$BIN" ]] || { echo "whisper-cli was not produced" >&2; exit 1; }
mkdir -p "$OUT_DIR"
cp "$BIN" "$OUT_DIR/lt-whisper-$TARGET$EXT"
cp "$WORK/LICENSE" "$OUT_DIR/whisper.cpp-LICENSE.txt"
echo "built $OUT_DIR/lt-whisper-$TARGET$EXT ($(du -h "$OUT_DIR/lt-whisper-$TARGET$EXT" | cut -f1))"

# Functional smoke test where the runner can execute the binary: transcribe
# whisper.cpp's JFK sample with the tiny model and check the words.
HOST="$(uname -m)"
case "$TARGET" in
  x86_64-*) CAN_RUN=$([[ "$HOST" == x86_64 || "$HOST" == AMD64 ]] && echo 1 || echo 0) ;;
  aarch64-*) CAN_RUN=$([[ "$HOST" == aarch64 || "$HOST" == arm64 ]] && echo 1 || echo 0) ;;
esac
if [[ "${CAN_RUN:-0}" == 1 && "${SKIP_ENGINE_SMOKE:-0}" != 1 ]]; then
  MODEL="$WORK/ggml-tiny.en.bin"
  curl -fsSL -o "$MODEL" https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin
  TEXT="$("$OUT_DIR/lt-whisper-$TARGET$EXT" -m "$MODEL" -f "$WORK/samples/jfk.wav" -nt --no-prints 2>/dev/null)"
  echo "smoke test transcript: $TEXT"
  grep -qi "ask not what your country can do for you" <<<"$TEXT" || { echo "engine smoke test failed" >&2; exit 1; }
else
  echo "cross-compiled for $TARGET on $HOST: skipping the smoke test"
fi
