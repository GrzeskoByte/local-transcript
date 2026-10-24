---
tags: [local-transcribe, roadmap]
---
# 0c Foundations

Back: [[00 Roadmap]] · Prev: [[0b Onboarding]] · Next: [[1 Speaker labels]], [[4 Consent local]]

```mermaid
flowchart TD
  subgraph P["Privacy tab"]
    P1["#/settings/privacy"] --> P2["Toggles: speaker labels, anonymize transcript, anonymize audio, require consent"]
  end
  subgraph A["Admin policy file"]
    A1["Launch"] --> A2["policy.rs reads policy.json (etc / Library / PROGRAMDATA)"]
    A2 --> A3{"File exists and valid?"}
    A3 -- no --> A4["User decides every toggle"]
    A3 -- yes --> A5["Forced toggles locked: Set by your IT administrator"]
  end
  subgraph W["Word timestamps"]
    W1["whisper-cli -ojf"] --> W2["Parse token times"]
    W2 --> W3["TranscriptSegment.words"]
    W3 --> W4{"bench:native: WER and time unchanged?"}
    W4 -- no --> W1
  end
  A5 --> P2
  W3 --> SL["1 Speaker labels"]
  W3 --> AA["3 Audio anonymization"]
  P2 --> CL["4 Consent local"]
  class SL,AA,CL internal-link
```

## Tasks
- AGENTS.md exceptions: diarization (MVP §5) and the consent server (no-backend rule).
- voxtype has no timestamps: features needing them show a reason instead.
