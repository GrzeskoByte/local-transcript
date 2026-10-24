---
tags: [local-transcribe, roadmap, privacy]
---
# 2 Transcript anonymization

Back: [[00 Roadmap]] · Prev: [[1 Speaker labels]] · Next: [[3 Audio anonymization]]

```mermaid
flowchart TD
  RAW["Stored segments (raw, never rewritten)"] --> ON{"Anonymize on or forced by policy?"}
  ON -- no --> OUT
  ON -- yes --> RX["Regex: email, phone, URL, IBAN"]
  RX --> NER["Local NER: person, company"]
  NER --> MAPN["Entity map: same name = same placeholder"]
  MAPN --> RED["[PERSON 1], [COMPANY 1], [EMAIL]"]
  RED --> OUT["Outputs"]
  OUT --> V["View"]
  OUT --> E["Export TXT/MD/JSON"]
  OUT --> DM["Disk mirror"]
  OUT --> GL["GitLab upload"]
  OUT --> LLM["LLM summary input"]
  RED --> AU["3 Audio anonymization"]
  ON -. forced .-> HIDE["Raw view and raw export hidden"]
  class AU internal-link
```

## Tests
- `redact.test.ts`: each pattern, stable numbering, no partial-word matches.
- e2e: export and GitLab body contain only placeholders.
