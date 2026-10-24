---
tags: [local-transcribe, roadmap, privacy]
---
# 3 Audio anonymization

Back: [[00 Roadmap]] · Prev: [[2 Transcript anonymization]]

```mermaid
flowchart TD
  EX["Export audio clicked"] --> ON{"Audio anonymization on?"}
  ON -- no --> ORIG["Export original"]
  ON -- yes --> WT{"Word timestamps exist?"}
  WT -- no --> DIS["Disabled: needs whisper-cli word times"]
  WT -- yes --> RG["Ranges from redacted entities"]
  RG --> MD{"Mode"}
  MD -- bleep --> BL["1 kHz tone, 10 ms fades"]
  MD -- silence --> SI["Silence, 10 ms fades"]
  BL --> VD
  SI --> VD{"Voice disguise?"}
  VD -- yes --> WARN["Warning: does not reliably prevent re-identification"]
  WARN --> PS["Pitch and formant shift"]
  PS --> ENC
  VD -- no --> ENC["native_audio_redact: decode Ogg, edit, re-encode Opus"]
  ENC --> COPY["Export copy only"]
  COPY -.-> KEEP["Original recording untouched"]
```

## Tests
- Rust: ranges land on the right samples; output decodes with ffmpeg.
- e2e: option disabled with reason on voxtype.
