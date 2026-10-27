import { test as base } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Playwright's WebKit contexts are ephemeral, and WebKit refuses OPFS there
 * (`UnknownError: The operation failed for an unknown transient reason`).
 * The desktop shells use a persistent profile, so on WebKit the recording
 * specs run in a persistent context (fresh profile per test). Other engines
 * keep Playwright's default context.
 */
export const test = base.extend<{ e2eDefaults: boolean }>({
  /**
   * Most specs test one feature and start from a known state: first-run setup
   * skipped and the after-Stop wrap-up off (Stop opens the meeting). Specs for
   * those flows turn it off with `test.use({ e2eDefaults: false })`. Applied
   * once per tab (sessionStorage guard) so a spec can still change the prefs.
   */
  e2eDefaults: [true, { option: true }],
  context: async ({ context, browserName, playwright }, use, testInfo) => {
    if (browserName !== 'webkit') {
      await use(context);
      return;
    }
    const dir = await mkdtemp(join(tmpdir(), 'lt-webkit-'));
    const { baseURL, permissions, viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } =
      testInfo.project.use;
    const persistent = await playwright.webkit.launchPersistentContext(dir, {
      baseURL,
      permissions,
      viewport,
      userAgent,
      deviceScaleFactor,
      isMobile,
      hasTouch,
    });
    try {
      await use(persistent);
    } finally {
      await persistent.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
  page: async ({ context, browserName, page, e2eDefaults }, use) => {
    // The default page belongs to the default context; on WebKit use one of
    // the persistent context instead.
    const p = browserName !== 'webkit' ? page : (context.pages()[0] ?? (await context.newPage()));
    if (e2eDefaults) {
      await p.addInitScript(() => {
        try {
          if (sessionStorage.getItem('e2e-defaults')) return;
          sessionStorage.setItem('e2e-defaults', '1');
          localStorage.setItem('setup-skipped', 'true');
          if (!localStorage.getItem('wrapup-prefs')) localStorage.setItem('wrapup-prefs', JSON.stringify({ guide: false }));
        } catch {
          /* storage unavailable */
        }
      });
    }
    await use(p);
  },
});

export { expect } from '@playwright/test';
