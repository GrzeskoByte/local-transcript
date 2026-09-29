## Local Transcriber {{VERSION}} for macOS

Private, on-device meeting recorder and transcriber. Your audio never leaves your machine.

### Downloads

| File | For |
| --- | --- |
| `LocalTranscriber_{{VERSION}}_macos_arm64.dmg` | **Apple Silicon** (M1 and newer). Recommended. |
| `LocalTranscriber_{{VERSION}}_macos_x64.dmg` | Intel Macs. |

**Requires** macOS 12 Monterey or later.

### Install

1. Open the `.dmg` and drag **Local Transcribe** into **Applications**.
2. This build is **not notarized yet**. On first launch, right-click the app → **Open**, or run:

```bash
xattr -dr com.apple.quarantine "/Applications/Local Transcribe.app"
```

### Transcription (optional)

Recording works out of the box. To transcribe, install whisper.cpp (Metal acceleration is built in):

```bash
brew install whisper-cpp
```

Then pick and download a model in **Settings → Models**.

### Verify

```bash
shasum -a 256 LocalTranscriber_{{VERSION}}_macos_arm64.dmg
```

Compare with `SHA256SUMS.txt` in this release.
