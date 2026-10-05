/**
 * Privacy guard: the app collects nothing and only goes online for things the
 * user asked for. Every place that can reach the network is listed here; a new
 * one fails this test until it is reviewed and added (with its reason) — and
 * documented in README "Privacy: what goes online".
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path, ext);
    return ext.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

function matching(dir: string, ext: RegExp, pattern: RegExp): string[] {
  return files(join(ROOT, dir), ext)
    .filter((f) => pattern.test(readFileSync(f, 'utf8')))
    .map((f) => relative(ROOT, f))
    .sort();
}

describe('privacy: network access is limited to user-initiated features', () => {
  it('webview code talks to the network only in the opt-in integrations', () => {
    expect(
      matching('src', /\.tsx?$/, /\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource/),
    ).toEqual([
      'src/integrations/gitlab.ts', // GitLab sharing: only on Upload/Test, to the user's server
      'src/integrations/llm.ts', // summaries: only on click, to the user's endpoint
    ]);
  });

  it('native code runs curl only for clicked downloads and the configured calendar', () => {
    expect(matching('src-tauri/src', /\.rs$/, /command\("curl"\)|"curl"/)).toEqual([
      'src-tauri/src/calendar.rs', // calendar the user configured
      'src-tauri/src/calendar_detect.rs', // "Detect from server" button
      'src-tauri/src/native_asr.rs', // model download button
    ]);
  });

  it('ships no analytics, telemetry or crash-reporting dependency', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['@fontsource/archivo-black', 'react', 'react-dom']);
    const cargo = readFileSync(join(ROOT, 'src-tauri/Cargo.toml'), 'utf8');
    const deps = cargo.split('[dependencies]')[1]!.split('\n[')[0]!;
    const names = deps.split('\n').map((l) => l.split('=')[0]!.trim()).filter(Boolean).sort();
    expect(names).toEqual(['base64', 'serde', 'serde_json', 'tauri', 'tauri-plugin-updater']);
  });

  it('does not check for updates on its own unless the user turned it on', () => {
    const updater = readFileSync(join(ROOT, 'src/platform/updater.ts'), 'utf8');
    expect(updater).toContain("getPref(AUTO_CHECK_KEY) === 'true'");
  });

  it('the bundled engine is built without network features', () => {
    const script = readFileSync(join(ROOT, 'scripts/build-engine.sh'), 'utf8');
    for (const flag of ['-DWHISPER_CURL=OFF', '-DGGML_RPC=OFF', '-DWHISPER_BUILD_SERVER=OFF']) {
      expect(script).toContain(flag);
    }
  });

  it('loads no remote scripts, styles or fonts', () => {
    const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
    expect(html).not.toMatch(/(src|href)="https?:/);
    const css = readFileSync(join(ROOT, 'src/app/styles.css'), 'utf8');
    expect(css).not.toMatch(/@import\s+url\(["']?https?:|url\(["']?https?:/);
  });
});
