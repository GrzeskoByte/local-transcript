#!/usr/bin/env node
/**
 * Collect Tauri bundles into release-ready files with clean, predictable names:
 *   LocalTranscriber_<version>_<platform>_<arch><suffix>
 * e.g. LocalTranscriber_0.1.0_windows_x64-setup.exe, _macos_arm64.dmg, _linux_amd64.deb
 *
 * Usage: node scripts/collect-release.mjs <bundleDir> <outDir> <version> <platform> <arch>
 *   platform: windows | macos | linux     arch: x64 | arm64 | amd64
 * Fails if no installer was found, so a broken build never publishes an empty release.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';

const [bundleDir, outDir, version, platform, arch] = process.argv.slice(2);
if (!bundleDir || !outDir || !version || !platform || !arch) {
  console.error('usage: collect-release.mjs <bundleDir> <outDir> <version> <platform> <arch>');
  process.exit(2);
}

// [bundle sub-directory, file extension, output suffix]. The `.sig` files and
// the macOS `.app.tar.gz` exist only when updater artifacts are built
// (tauri.updater.conf.json + TAURI_SIGNING_PRIVATE_KEY); they feed latest.json.
const RULES = [
  ['nsis', '.exe', '-setup.exe'],
  ['nsis', '.exe.sig', '-setup.exe.sig'],
  ['msi', '.msi', '.msi'],
  ['dmg', '.dmg', '.dmg'],
  ['macos', '.app.tar.gz', '.app.tar.gz'],
  ['macos', '.app.tar.gz.sig', '.app.tar.gz.sig'],
  ['deb', '.deb', '.deb'],
  ['rpm', '.rpm', '.rpm'],
  ['appimage', '.AppImage', '.AppImage'],
  ['appimage', '.AppImage.sig', '.AppImage.sig'],
];

mkdirSync(outDir, { recursive: true });
const collected = [];
for (const [dir, ext, suffix] of RULES) {
  const src = path.join(bundleDir, dir);
  if (!existsSync(src)) continue;
  for (const file of readdirSync(src).filter((f) => f.endsWith(ext))) {
    const name = `LocalTranscriber_${version}_${platform}_${arch}${suffix}`;
    copyFileSync(path.join(src, file), path.join(outDir, name));
    collected.push(`${file}  →  ${name}`);
  }
}
if (collected.length === 0) {
  console.error(`No installers found under ${bundleDir}`);
  process.exit(1);
}
console.log(collected.join('\n'));
