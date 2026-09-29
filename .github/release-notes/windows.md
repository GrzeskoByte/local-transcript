## Local Transcriber {{VERSION}} for Windows

Private, on-device meeting recorder and transcriber. Your audio never leaves your machine.

### Downloads

| File | For |
| --- | --- |
| `LocalTranscriber_{{VERSION}}_windows_x64-setup.exe` | **Most PCs** (Intel/AMD, 64-bit). Recommended. |
| `LocalTranscriber_{{VERSION}}_windows_x64.msi` | Managed / IT deployments (`msiexec /i … /qn`). |
| `LocalTranscriber_{{VERSION}}_windows_arm64-setup.exe` | Windows on ARM (Snapdragon / Copilot+ PCs). |

**Requires** Windows 10 or 11. WebView2 is preinstalled on Windows 11; the installer fetches it on Windows 10 if missing.

### Install

1. Run the `-setup.exe` and follow the installer.
2. This build is **not code-signed yet**. If SmartScreen appears, choose **More info → Run anyway**.

### Transcription (optional)

Recording works out of the box. To transcribe, install a [whisper.cpp release](https://github.com/ggml-org/whisper.cpp/releases) (CUDA or Vulkan build for GPU speed) and point the app at it:

```powershell
setx WHISPER_CLI_PATH C:\whisper\whisper-cli.exe
```

Then pick and download a model in **Settings → Models**.

### Verify

```powershell
certutil -hashfile LocalTranscriber_{{VERSION}}_windows_x64-setup.exe SHA256
```

Compare with `SHA256SUMS.txt` in this release.
