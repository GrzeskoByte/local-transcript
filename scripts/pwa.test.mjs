import { describe, expect, it } from 'vitest';
import { headTags, serviceWorkerSource, webManifest } from './pwa.mjs';

describe('web / phone build (PWA)', () => {
  it('has an installable manifest with relative paths and maskable icons', () => {
    const m = webManifest('1.2.3');
    expect(m).toMatchObject({ display: 'standalone', start_url: './', scope: './', version: '1.2.3' });
    const icons = m.icons;
    expect(icons.some((i) => i.sizes === '512x512' && i.purpose === 'any')).toBe(true);
    expect(icons.some((i) => i.sizes === '512x512' && i.purpose === 'maskable')).toBe(true);
    expect(icons.every((i) => !i.src.startsWith('/'))).toBe(true);
  });

  it('links the manifest and the iOS icon', () => {
    const tags = headTags();
    expect(tags.find((t) => t.attrs.rel === 'manifest')?.attrs.href).toBe('./manifest.webmanifest');
    expect(tags.some((t) => t.attrs.rel === 'apple-touch-icon')).toBe(true);
  });

  it('precaches the given files and serves only same-origin GETs', () => {
    const sw = serviceWorkerSource(['./', 'index.html', 'assets/a.js'], 'abc');
    expect(sw).toContain("const CACHE = 'local-transcribe-abc'");
    expect(sw).toContain('["./","index.html","assets/a.js"]');
    expect(sw).toContain("request.method !== 'GET' || new URL(request.url).origin !== self.location.origin");
    // Updates wait for the next launch: never reload a page that may be recording.
    expect(sw).not.toContain('skipWaiting');
  });
});
