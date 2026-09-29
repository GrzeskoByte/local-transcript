## Local Transcriber {{VERSION}} for Ubuntu / Linux

Private, on-device meeting recorder and transcriber. Your audio never leaves your machine.

**Download → double-click the `.deb` → Install → record.** Transcription is built in: the first
time you click **Transcribe**, the app downloads its speech model once (~550 MB) and works
offline after that.

| File | For |
| --- | --- |
| `LocalTranscriber_{{VERSION}}_linux_amd64.deb` | **Ubuntu 22.04+ / Debian / Mint** (Intel/AMD). Recommended — opens in App Center. |
| `LocalTranscriber_{{VERSION}}_linux_amd64.AppImage` | Any distro, no install (make executable, run). |
| `LocalTranscriber_{{VERSION}}_linux_amd64.rpm` | Fedora / RHEL / openSUSE. |
| `…_linux_arm64.deb` · `.AppImage` · `.rpm` | The same for ARM64. |

Terminal install: `sudo apt install ./LocalTranscriber_{{VERSION}}_linux_amd64.deb`

<details><summary>Advanced: GPU transcription</summary>

The built-in engine runs on the CPU. If [voxtype](https://voxtype.io/) or a GPU build of
whisper.cpp (`whisper-cli`) is installed, the app uses it automatically — e.g.
`sudo voxtype setup gpu --enable`.
</details>

Verify: `sha256sum -c SHA256SUMS.txt --ignore-missing`.
Includes [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (MIT).
