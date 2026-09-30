import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  use: { baseURL: 'http://localhost:4173', trace: 'on-first-retry' },
  webServer: {
    command: 'npm run preview -- --port 4173',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    {
      // Chromium ≈ the Windows shell (WebView2).
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        permissions: ['microphone'],
        launchOptions: {
          args: [
            '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-stream',
            '--autoplay-policy=no-user-gesture-required',
          ],
        },
      },
    },
    // WebKit ≈ the macOS (WKWebView) and Linux (WebKitGTK) shells. Playwright's
    // WebKit captures from mock devices; run the recording specs with
    // `--project=webkit` (CI does, on Linux and macOS).
    {
      name: 'webkit',
      testMatch: /recording-reliability\.spec\.ts|data-integrity\.spec\.ts/,
      use: { ...devices['Desktop Safari'] },
    },
  ],
});
