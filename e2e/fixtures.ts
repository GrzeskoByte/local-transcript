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
export const test = base.extend({
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
  page: async ({ context, browserName, page }, use) => {
    // The default page belongs to the default context; on WebKit use one of
    // the persistent context instead.
    if (browserName !== 'webkit') {
      await use(page);
      return;
    }
    await use(context.pages()[0] ?? (await context.newPage()));
  },
});

export { expect } from '@playwright/test';
