import { test, expect } from '@playwright/test';

test('live playheads track animation frames and seeking stays immediate', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const clipId = prismDiagnostics().project.layers.at(-1).activeClipId;
    const progress = document.querySelector(`[data-clip="${clipId}"] .clip-progress`);
    const timeline = document.querySelector('[data-inspector-panel="clip"] .timeline');
    const seen = new Set(), positions = new Set();
    const start = performance.now();
    let callbacks = 0;
    while (performance.now() - start < 1200) {
      await new Promise(requestAnimationFrame);
      callbacks++;
      seen.add(progress.style.transform || progress.style.width);
      positions.add(timeline.value);
    }
    return { callbacks, progressUpdates: seen.size, timelineUpdates: positions.size,
      rendererFrameMs: prismDiagnostics().stats.frameMs };
  });
  console.log('TRANSPORT_SMOOTHNESS', result);
  expect(result.callbacks).toBeGreaterThan(20);
  expect(result.progressUpdates).toBeGreaterThan(20);
  expect(result.timelineUpdates).toBeGreaterThan(20);

  const timeline = page.locator('[data-inspector-panel="clip"] .timeline');
  await timeline.fill('0.7');
  await expect.poll(() => page.evaluate(() => {
    const clipId = prismDiagnostics().project.layers.at(-1).activeClipId;
    const frame = prismDiagnostics().frames.find(item => item.clipId === clipId);
    return frame?.position;
  })).toBeGreaterThan(0.7);
});
