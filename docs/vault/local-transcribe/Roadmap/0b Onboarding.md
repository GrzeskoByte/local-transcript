---
tags: [local-transcribe, roadmap, onboarding]
---
# 0b Onboarding

Back: [[00 Roadmap]] · Prev: [[0a Built-in engine]] · Next: [[0c Foundations]]

Goal: one setup screen (`#/welcome`) on first launch, re-runnable any time from Settings → App **Run setup again**.

```mermaid
flowchart TD
  L["App launch"] --> F{"setup-complete in settings file?"}
  F -- yes --> D["Dashboard"]
  F -- no --> S1
  R["Settings → App: Run setup again"] --> S1

  S1["1. Privacy: stays on this device"] --> S2["2. Microphone access"]
  S2 --> G{"Granted?"}
  G -- no --> H["Hint + Try again"]
  H --> G
  G -- skip --> S3
  G -- yes --> S3["3. Audio devices: mic + output"]
  S3 --> S4["4. Spoken language"]
  S4 --> EN{"Engine found?"}
  EN -- no --> ENG["0a Built-in engine"]
  EN -- yes --> MI{"Model installed?"}
  MI -- yes --> S6
  MI -- no --> S5["5. Download recommended model (progress)"]
  S5 --> OK{"Download OK?"}
  OK -- no --> RT["Retry or Skip"]
  RT --> S5
  RT -- skip --> S6
  OK -- yes --> S6["6. Options: live transcription, transcribe after recording, speaker labels"]
  S6 --> FIN["Finish: save setup-complete"]
  FIN --> D
  class ENG internal-link
```

## Rules
- Re-run shows current values; finishing changes only what the user changed. Nothing is deleted.
- Every step can be skipped; recording works with no model.
- Disabled while recording or transcribing.
- e2e: `onboarding.spec.ts` (first run, skip, re-run from Settings keeps values).
- Update `docs/REDESIGN.md` with the new screen.
