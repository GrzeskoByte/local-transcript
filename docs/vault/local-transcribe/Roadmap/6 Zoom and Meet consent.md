---
tags: [local-transcribe, roadmap, consent]
---
# 6 Zoom and Meet consent

Back: [[00 Roadmap]] · Prev: [[5 Agreement links]]

In-client Agree/Decline panels. They never read meeting audio. Answers go to the Phase 5 Worker.

```mermaid
flowchart TD
  H["Host starts call"] --> PL{"Platform"}
  PL -- Zoom --> ZA["Zoom App panel"]
  ZA --> ZI["sendAppInvitationToAllParticipants"]
  ZI --> ANS
  PL -- Meet --> MA["Meet add-on"]
  MA --> MS["startActivity: everyone notified"]
  MS --> INS{"Participant has add-on?"}
  INS -- no --> INST["Prompt to install"]
  INST --> ANS
  INS -- yes --> ANS["Agree / Decline"]
  PL -- Teams or other --> CL["Paste agreement links in chat"]
  CL --> ANS
  ANS --> W["Consent Worker"]
  W --> GATE["5 Agreement links"]
  class GATE internal-link
```


## Notes
- Zoom: Marketplace review takes weeks.
- Meet: answers via Co-Doing API or the Worker.
