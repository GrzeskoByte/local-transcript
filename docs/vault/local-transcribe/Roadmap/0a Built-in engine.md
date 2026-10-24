---
tags: [local-transcribe, roadmap, engine]
---
# 0a Built-in engine

Back: [[00 Roadmap]] · Next: [[0b Onboarding]]

Goal: every installer ships whisper-cli (`lt-whisper`); nobody installs it by hand.

## Release build

```mermaid
flowchart TD
  T["Tag v*"] --> M["Matrix: Linux / macOS / Windows targets"]
  M --> BE["scripts/build-engine.sh (WHISPER_CPP_VERSION)"]
  BE --> SM{"JFK smoke test passes?"}
  SM -- no --> FAIL["Fail the release job"]
  SM -- yes --> BU["tauri build --config tauri.engine.conf.json"]
  BU --> CK{"NEW: every installer contains lt-whisper?"}
  CK -- no --> FAIL
  CK -- yes --> PUB["Publish release"]
  PUB --> UPD["updater latest.json"]
```

## Engine lookup at launch

```mermaid
flowchart TD
  L["App launch"] --> E1{"WHISPER_CLI_PATH set?"}
  E1 -- yes --> U1["Use that CLI"]
  E1 -- no --> E2{"whisper-cli on PATH?"}
  E2 -- yes --> U2["Use self-installed CLI"]
  E2 -- no --> E3{"voxtype on PATH?"}
  E3 -- yes --> U3["Use voxtype"]
  E3 -- no --> E4{"lt-whisper next to the app?"}
  E4 -- yes --> U4["Use built-in engine"]
  E4 -- no --> BUG["Install hint: a bug, find out why (0a)"]
  U2 --> OF["Settings offers: Use built-in engine"]
  OF --> U4
  U4 --> UI["Settings shows: Engine built-in"]
  U4 --> OB["0b Onboarding"]
  class OB internal-link
```

## Tasks
- Find which installer lacks `lt-whisper` or where lookup misses it (`src-tauri/src/models.rs`).
- CI check: unpack each installer and run `lt-whisper --help`.
- Settings: "Engine: built-in" + **Use built-in engine** when a self-installed CLI wins.
- Remove "install whisper-cli" text from the default path.
