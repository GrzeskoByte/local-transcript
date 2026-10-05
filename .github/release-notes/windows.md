## Local Transcriber {{VERSION}} for Windows

Private, on-device meeting recorder and transcriber. Your audio never leaves your PC. No telemetry or analytics: it goes online only when you click (model download, update check, integrations you set up).

**Download → run → record.** Transcription is built in: the first time you click
**Transcribe**, the app downloads its speech model once (~550 MB) and works offline after that.

| File | For |
| --- | --- |
| `LocalTranscriber_{{VERSION}}_windows_x64-setup.exe` | **Most PCs** (Intel/AMD). Recommended. |
| `LocalTranscriber_{{VERSION}}_windows_arm64-setup.exe` | Windows on ARM (Snapdragon / Copilot+ PCs). |
| `LocalTranscriber_{{VERSION}}_windows_x64.msi` | IT / managed deployment (`msiexec /i … /qn`). |

Windows 10 or 11. If SmartScreen shows "Windows protected your PC", click **More info → Run anyway**
(this early build is not code-signed yet).

<details><summary>Advanced: use your own GPU build of whisper.cpp</summary>

The built-in engine runs on the CPU. For GPU speed, install a CUDA or Vulkan
[whisper.cpp release](https://github.com/ggml-org/whisper.cpp/releases) and point the app at it:
`setx WHISPER_CLI_PATH C:\whisper\whisper-cli.exe`
</details>

Verify: `certutil -hashfile <file> SHA256` and compare with `SHA256SUMS.txt`.
Includes [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (MIT).
