import { expect, test } from '@playwright/test';

test('processing meeting shows transcription loader', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('local-transcribe', 1);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('meetings', 'readwrite');
          tx.objectStore('meetings').put({
            id: 'loader-test',
            title: 'Loader Test',
            mode: 'speaker',
            createdAt: Date.now(),
            startedAt: Date.now(),
            durationMs: 60000,
            audioPath: 'meetings/loader-test',
            mimeType: 'audio/webm',
            transcriptionStatus: 'processing',
          });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
        req.onerror = () => reject(req.error);
      }),
  );
  await page.goto('/#/meeting/loader-test');
  await expect(page.getByRole('status', { name: 'Transcription in progress' })).toBeVisible();
  await expect(page.getByText('Transcribing…')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
  await page.screenshot({ path: 'test-results/loader.png' });
});
