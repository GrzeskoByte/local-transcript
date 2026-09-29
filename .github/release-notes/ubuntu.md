## Local Transcriber {{VERSION}} for Ubuntu / Linux

Private, on-device meeting recorder and transcriber. Your audio never leaves your machine.

### Downloads

| File | For |
| --- | --- |
| `LocalTranscriber_{{VERSION}}_linux_amd64.deb` | **Ubuntu 22.04+ / Debian / Mint** (x86_64). Recommended. |
| `LocalTranscriber_{{VERSION}}_linux_amd64.AppImage` | Any distro, no install (x86_64). |
| `LocalTranscriber_{{VERSION}}_linux_amd64.rpm` | Fedora / RHEL / openSUSE (x86_64). |
| `LocalTranscriber_{{VERSION}}_linux_arm64.deb` · `.AppImage` · `.rpm` | The same for ARM64 (aarch64). |

**Requires** `libwebkit2gtk-4.1` — Ubuntu 22.04 or newer (older releases ship only 4.0).

### Install

```bash
# Ubuntu / Debian
sudo apt install ./LocalTranscriber_{{VERSION}}_linux_amd64.deb

# Fedora / openSUSE
sudo dnf install ./LocalTranscriber_{{VERSION}}_linux_amd64.rpm

# AppImage (portable)
chmod +x LocalTranscriber_{{VERSION}}_linux_amd64.AppImage && ./LocalTranscriber_{{VERSION}}_linux_amd64.AppImage
```

### Transcription (optional)

Recording works out of the box. To transcribe, install [voxtype](https://voxtype.io/) (Arch: `voxtype-bin`) or any whisper.cpp build that provides `whisper-cli` — the app detects either. For GPU speed with voxtype:

```bash
sudo voxtype setup gpu --enable
```

Then pick and download a model in **Settings → Models**.

### Verify

```bash
sha256sum -c SHA256SUMS.txt --ignore-missing
```
