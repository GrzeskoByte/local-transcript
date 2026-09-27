import { expect, test } from '@playwright/test';

/**
 * Reproduces the recording → storage → decode path the transcriber depends on,
 * using Chromium's fake microphone. If this fails, transcription can never work.
 */
test('MediaRecorder chunks concatenate and decode to non-silent audio', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : '';
    const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e: BlobEvent) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    rec.start(1000); // 1s timeslices, mirroring the app's chunked persistence
    await new Promise((r) => setTimeout(r, 3000));
    await new Promise<void>((resolve) => {
      rec.onstop = () => resolve();
      rec.stop();
    });
    stream.getTracks().forEach((t) => t.stop());

    const blob = new Blob(chunks, { type: rec.mimeType });
    const buf = await blob.arrayBuffer();
    const ctx = new AudioContext();
    try {
      const decoded = await ctx.decodeAudioData(buf.slice(0));
      const data = decoded.getChannelData(0);
      let peak = 0;
      for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]!));
      return {
        ok: true as const,
        chunkCount: chunks.length,
        bytes: blob.size,
        mime: rec.mimeType,
        decodedDuration: decoded.duration,
        decodedRate: decoded.sampleRate,
        peak,
      };
    } catch (err) {
      return {
        ok: false as const,
        chunkCount: chunks.length,
        bytes: blob.size,
        mime: rec.mimeType,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      void ctx.close();
    }
  });

  console.log('DECODE RESULT', JSON.stringify(result, null, 2));
  expect(result.ok, `decode failed: ${JSON.stringify(result)}`).toBe(true);
  if (result.ok) {
    expect(result.chunkCount).toBeGreaterThan(0);
    expect(result.decodedDuration).toBeGreaterThan(1);
    expect(result.peak).toBeGreaterThan(0);
  }
});
