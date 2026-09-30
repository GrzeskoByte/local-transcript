## Local Transcriber {{VERSION}} for macOS

Private, on-device meeting recorder and transcriber. Your audio never leaves your Mac.

**Download → drag to Applications → record.** Transcription is built in and GPU-accelerated
(Metal): the first time you click **Transcribe**, the app downloads its speech model once
(~550 MB) and works offline after that.

| File | For |
| --- | --- |
| `LocalTranscriber_{{VERSION}}_macos_arm64.dmg` | **Apple Silicon** (M1 and newer). Recommended. |
| `LocalTranscriber_{{VERSION}}_macos_x64.dmg` | Intel Macs. |

macOS 12 or later. macOS asks for microphone access the first time you record — click **Allow**.

This early build is not notarized yet, so macOS blocks the first launch:
- *"cannot be opened because Apple cannot check it"* → open **System Settings → Privacy & Security**
  and click **Open Anyway**.
- *"is damaged and can't be opened"* (the file is fine — macOS says this about unnotarized
  downloads) → run in Terminal, then open the app again:
  `xattr -dr com.apple.quarantine "/Applications/Local Transcribe.app"`

Verify: `shasum -a 256 <file>` and compare with `SHA256SUMS.txt`.
Includes [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (MIT).
