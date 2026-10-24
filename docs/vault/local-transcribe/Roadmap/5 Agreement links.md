---
tags: [local-transcribe, roadmap, consent]
---
# 5 Agreement links

Back: [[00 Roadmap]] · Prev: [[4 Consent local]] · Next: [[6 Zoom and Meet consent]]

Cloudflare Worker + KV. Stores names, emails and answers only — never audio. The app contacts it only on a click.

## Sending and answering

```mermaid
sequenceDiagram
  actor U as User
  participant A as Desktop app
  participant W as Consent Worker
  actor P as Attendee
  U->>A: Send agreement links (click)
  A->>W: POST meeting + attendees
  W-->>A: Signed link per attendee
  A->>U: mailto drafts / chat text
  U->>P: Sends link
  P->>W: Open link, Agree or Decline
  U->>A: Refresh consent (click)
  A->>W: GET status
  W-->>A: Agreed / declined / pending
```

## Start gate

```mermaid
flowchart TD
  NM["New Meeting"] --> RC{"Require consent on or forced?"}
  RC -- no --> GO["Start enabled"]
  RC -- yes --> ST{"Every invitee agreed?"}
  ST -- no --> PEN["Pending list, Start disabled"]
  PEN --> RF["Refresh (click)"]
  RF --> ST
  ST -- yes --> MAN{"People not on the invite confirmed by hand?"}
  MAN -- no --> PEN
  MAN -- yes --> GO
  GO --> Z["6 Zoom and Meet consent"]
  class Z internal-link
```

## Tasks
- `src/privacy.test.ts` + README "Privacy: what goes online": Worker host, click-only.
- KV entries expire (TTL).
