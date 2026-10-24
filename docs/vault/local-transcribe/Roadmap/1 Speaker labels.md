---
tags: [local-transcribe, roadmap, speakers]
---
# 1 Speaker labels

Back: [[00 Roadmap]] · Prev: [[0c Foundations]] · Next: [[2 Transcript anonymization]]

Anonymous Speaker A, B, C. No voiceprints kept.

```mermaid
flowchart TD
  T["Whole-file transcript done"] --> B{"Backend whisper-cli and labels on?"}
  B -- no --> X["Keep transcript as is"]
  B -- yes --> M{"Diarization models installed?"}
  M -- no --> DL["Download on click (~40 MB)"]
  DL --> R
  M -- yes --> R["lt-diarize on 16 kHz WAV (spawn_blocking)"]
  R --> C["Clusters: start, end, id"]
  R -.-> DROP["Embeddings stay in the child process, never saved"]
  C --> MAP["speaker-labels.ts: overlap per word or segment"]
  MAP --> SPL["Split segments where speaker changes"]
  SPL --> ORD["Rename clusters A, B, C by first appearance"]
  ORD --> SAVE["segment.speaker"]
  SAVE --> VIEW["Meeting Detail"]
  VIEW --> RN{"User renames?"}
  RN -- yes --> NM["Meeting.speakerNames (display only)"]
  RN -- no --> EX
  NM --> EX{"Export: Use speaker names ticked?"}
  EX -- no --> AN["Anonymous labels"]
  EX -- yes --> NA["Names"]
  AN --> TA["2 Transcript anonymization"]
  class TA internal-link
```

## Tests
- `speaker-labels.test.ts`: overlap, splits, ordering, short blips ignored.
- `cargo test diarize`; e2e with mocked `native_diarize`.
- `src/privacy.test.ts`: models download only on a click.
