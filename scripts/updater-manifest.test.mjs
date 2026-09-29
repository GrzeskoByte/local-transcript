import { describe, expect, it } from 'vitest';
import { buildManifest, planManifest } from './updater-manifest.mjs';

const asset = (tag, name) => ({ name, browser_download_url: `https://gh/dl/${tag}/${name}` });
const release = (tag, names, extra = {}) => ({
  tag_name: tag, draft: false, published_at: '2026-10-01T00:00:00Z',
  assets: names.map((n) => asset(tag, n)), ...extra,
});

describe('updater manifest', () => {
  const releases = [
    release('v0.1.2-windows', [
      'LocalTranscriber_0.1.2_windows_x64-setup.exe', 'LocalTranscriber_0.1.2_windows_x64-setup.exe.sig',
      'LocalTranscriber_0.1.2_windows_x64.msi', 'LocalTranscriber_0.1.2_windows_x64.msi.sig',
      'LocalTranscriber_0.1.2_windows_arm64-setup.exe',
    ]),
    release('v0.1.2-ubuntu', [
      'LocalTranscriber_0.1.2_linux_amd64.AppImage', 'LocalTranscriber_0.1.2_linux_amd64.AppImage.sig',
      'LocalTranscriber_0.1.2_linux_amd64.deb',
    ]),
    release('v0.1.2-macos', ['LocalTranscriber_0.1.2_macos_arm64.app.tar.gz', 'LocalTranscriber_0.1.2_macos_arm64.app.tar.gz.sig'], { draft: true }),
    release('v0.1.1-macos', ['LocalTranscriber_0.1.1_macos_arm64.app.tar.gz', 'LocalTranscriber_0.1.1_macos_arm64.app.tar.gz.sig']),
    release('updater', []),
  ];

  it('uses the newest published version, signed artifacts only, no drafts', () => {
    const plan = planManifest(releases);
    expect(plan.version).toBe('0.1.2');
    expect(plan.entries.map((e) => e.key).sort()).toEqual(['linux-x86_64', 'windows-x86_64']);
  });

  it('builds latest.json with trimmed signatures', () => {
    const plan = planManifest(releases);
    const sigs = Object.fromEntries(plan.entries.map((e) => [e.sigUrl, `sig-${e.key}\n`]));
    const m = buildManifest(plan, sigs);
    expect(m.platforms['windows-x86_64']).toEqual({
      signature: 'sig-windows-x86_64',
      url: 'https://gh/dl/v0.1.2-windows/LocalTranscriber_0.1.2_windows_x64-setup.exe',
    });
    expect(m.version).toBe('0.1.2');
    expect(m.pub_date).toBe('2026-10-01T00:00:00Z');
  });

  it('compares versions numerically', () => {
    const plan = planManifest([
      release('v0.9.0-ubuntu', ['LocalTranscriber_0.9.0_linux_amd64.AppImage', 'LocalTranscriber_0.9.0_linux_amd64.AppImage.sig']),
      release('v0.10.0-ubuntu', ['LocalTranscriber_0.10.0_linux_amd64.AppImage', 'LocalTranscriber_0.10.0_linux_amd64.AppImage.sig']),
    ]);
    expect(plan.version).toBe('0.10.0');
  });

  it('returns null without published releases', () => {
    expect(planManifest([release('v1.0.0-windows', [], { draft: true })])).toBeNull();
  });
});
