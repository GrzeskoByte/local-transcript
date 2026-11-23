# syntax=docker/dockerfile:1

ARG VARIANT=cpu
# Match the desktop release pin in .github/workflows/release.yml.
ARG WHISPER_CPP_VERSION=v1.9.4
ARG CUDA_VERSION=12.8.1

FROM --platform=$BUILDPLATFORM node:22-bookworm AS frontend
WORKDIR /build
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts
COPY index.html tsconfig.json vite.config.ts ./
COPY public/ public/
COPY src/ src/
RUN npm run build

FROM rust:bookworm AS server
ARG TARGETARCH
WORKDIR /build
COPY server/ server/
# The server workspace can share Tauri-free modules from the desktop source.
COPY src-tauri/src/ src-tauri/src/
WORKDIR /build/server
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,id=lt-cargo-target-${TARGETARCH},target=/build/server/target,sharing=locked \
    cargo build --release --locked && install -D target/release/lt-server /out/lt-server

FROM debian:bookworm-slim AS whisper-base-cpu
FROM nvidia/cuda:${CUDA_VERSION}-devel-ubuntu24.04 AS whisper-base-cuda
FROM whisper-base-${VARIANT} AS whisper
ARG VARIANT
ARG TARGETARCH
ARG WHISPER_CPP_VERSION
WORKDIR /build
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential ca-certificates cmake curl git \
    && rm -rf /var/lib/apt/lists/*
COPY scripts/build-engine.sh scripts/build-engine.sh
RUN case "$TARGETARCH" in \
      amd64) target=x86_64-unknown-linux-gnu ;; \
      arm64) target=aarch64-unknown-linux-gnu ;; \
      *) exit 2 ;; \
    esac \
    && if [ "$VARIANT" = cuda ]; then export GGML_CUDA=1 SKIP_ENGINE_SMOKE=1; fi \
    && scripts/build-engine.sh "$target" "$WHISPER_CPP_VERSION" \
    && install -D "src-tauri/binaries/lt-whisper-$target" /out/whisper-cli \
    && install -m 644 src-tauri/binaries/whisper.cpp-LICENSE.txt /out/whisper.cpp-LICENSE.txt

FROM debian:bookworm-slim AS diarizer
ARG TARGETARCH
WORKDIR /build
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl libgomp1 libstdc++6 python3 \
    && rm -rf /var/lib/apt/lists/*
COPY scripts/fetch-diarizer.sh scripts/fetch-diarizer.sh
RUN case "$TARGETARCH" in \
      amd64) target=x86_64-unknown-linux-gnu ;; \
      arm64) target=aarch64-unknown-linux-gnu ;; \
      *) exit 2 ;; \
    esac \
    && scripts/fetch-diarizer.sh "$target" /out/diarize

FROM debian:bookworm-slim AS runtime-base-cpu
FROM nvidia/cuda:${CUDA_VERSION}-runtime-ubuntu24.04 AS runtime-base-cuda
FROM runtime-base-${VARIANT} AS runtime
ARG VERSION=dev
LABEL org.opencontainers.image.source="https://github.com/GrzeskoByte/local-transcript" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.licenses="MIT AND Apache-2.0 AND CC-BY-4.0 AND OFL-1.1"

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl libgomp1 libstdc++6 tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 lt \
    && useradd --uid 10001 --gid lt --no-create-home --home-dir /data --shell /usr/sbin/nologin lt \
    && install -d -o lt -g lt -m 0750 /data \
    && printf '%s\n' /opt/lt/diarize > /etc/ld.so.conf.d/lt-diarize.conf
COPY --from=server /out/lt-server /opt/lt/bin/
COPY --from=whisper /out/whisper-cli /opt/lt/bin/
COPY --from=whisper /out/whisper.cpp-LICENSE.txt /opt/lt/licenses/
COPY --from=diarizer /out/diarize/ /opt/lt/diarize/
COPY --from=frontend /build/dist/ /opt/lt/dist/
COPY --from=frontend /build/node_modules/@fontsource/archivo-black/LICENSE /opt/lt/licenses/Archivo-Black.txt
COPY --from=frontend /build/node_modules/@fontsource/jetbrains-mono/LICENSE /opt/lt/licenses/JetBrains-Mono.txt
COPY --from=frontend /build/node_modules/react/LICENSE /opt/lt/licenses/React.txt
COPY LICENSE /opt/lt/licenses/Local-Transcribe.txt
RUN ldconfig

ENV PATH="/opt/lt/bin:${PATH}" \
    WHISPER_CLI_PATH=/opt/lt/bin/whisper-cli \
    LT_DIARIZE_DIR=/opt/lt/diarize \
    LT_STATIC_DIR=/opt/lt/dist \
    LT_BIND=0.0.0.0:8080 \
    LT_DATA_DIR=/data
USER lt
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${LT_BIND##*:}/api/health" || exit 1
ENTRYPOINT ["tini", "--", "lt-server"]
