import { test, expect } from '@playwright/test';

const diagnostics = page => page.evaluate(() => window.prismDiagnostics());
const context = page => page.locator('[data-inspector-panel="context"]');
const clipPanel = page => page.locator('[data-inspector-panel="clip"]');
const findClip = (project, id) => project.layers.flatMap(layer => Object.values(layer.clips).flat()).find(clip => clip?.id === id);

test('composition and clip panels edit their own targets while both stay visible', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  const initial = await diagnostics(page);
  const clipId = initial.project.layers.at(-1).activeClipId;
  await page.locator('[data-inspector="composition"]').click();
  const master = context(page).locator('[data-number="masterOpacity"]');
  await master.fill('0.45');
  await master.blur();
  const clipOpacity = clipPanel(page).locator('[data-number="opacity"]');
  await clipOpacity.fill('0.7');
  await clipOpacity.blur();
  let state = await diagnostics(page);
  expect(state.project.masterOpacity).toBe(0.45);
  expect(findClip(state.project, clipId).opacity).toBe(0.7);
  await page.locator('[data-inspector="layer"]').click();
  const layerOpacity = context(page).locator('[data-number="opacity"]');
  await layerOpacity.fill('0.25');
  await layerOpacity.blur();
  state = await diagnostics(page);
  expect(state.project.layers.at(-1).opacity).toBe(0.25);
  expect(findClip(state.project, clipId).opacity).toBe(0.7);
  expect(state.project.masterOpacity).toBe(0.45);
  await expect(context(page)).toBeVisible();
  await expect(clipPanel(page)).toBeVisible();
  expect(await page.evaluate(() => {
    const ids = [...document.querySelectorAll('[id]')].map(element => element.id);
    return ids.filter((id, index) => ids.indexOf(id) !== index);
  })).toEqual([]);
  expect(errors).toEqual([]);
});

test('reference layout keeps stacked preview and live output separate at desktop sizes', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.locator('#pause').click();
  const before = await diagnostics(page);
  await page.locator('.layer-row').first().locator('[data-slot="1"] .clip-name').click();
  await expect(page.locator('#preview-canvas')).toBeVisible();
  await expect(page.locator('#output-canvas')).toBeVisible();
  await page.waitForTimeout(150);
  const after = await diagnostics(page);
  expect(after.frames.map(frame => [frame.clipId, frame.position])).toEqual(before.frames.map(frame => [frame.clipId, frame.position]));

  for (const size of [{ width: 1600, height: 1000 }, { width: 1360, height: 900 }]) {
    await page.setViewportSize(size);
    const rect = selector => page.locator(selector).boundingBox();
    const [bank, decks, toolbar, bottom, output, preview, composition, clip, browser] = await Promise.all([
      rect('.workspace'), rect('.deckbar'), rect('.toolbar'), rect('.bottom'), rect('#output-canvas'),
      rect('#preview-canvas'), rect('.context-panel'), rect('.clip-panel'), rect('.browser-panel'),
    ]);
    expect(bank.y).toBeLessThan(decks.y);
    expect(decks.y).toBeLessThan(toolbar.y);
    expect(toolbar.y).toBeLessThan(bottom.y);
    expect(output.y + output.height).toBeLessThanOrEqual(preview.y);
    expect(output.x + output.width).toBeLessThanOrEqual(composition.x + 1);
    expect(composition.x + composition.width).toBeLessThanOrEqual(clip.x + 1);
    expect(clip.x + clip.width).toBeLessThanOrEqual(browser.x + 1);
    expect(browser.x + browser.width).toBeLessThanOrEqual(size.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(size.width);
    await page.screenshot({ path: `test-results/reference-layout-${size.width}.png` });
  }
  expect(errors).toEqual([]);
});

test('workspace, monitors, and bottom panels resize by dragging and survive reload', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  const box = selector => page.locator(selector).boundingBox();
  const drag = async (name, x, y) => {
    const rect = await box(`[data-layout-splitter="${name}"]`);
    const startX = rect.x + rect.width / 2, startY = rect.y + rect.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + x, startY + y, { steps: 6 });
    await page.mouse.up();
  };
  const initialWorkspace = await box('.workspace');
  const initialBottom = await box('.bottom');
  await drag('workspace', 0, 85);
  expect((await box('.workspace')).height).toBeGreaterThan(initialWorkspace.height + 75);
  expect((await box('.bottom')).y).toBeGreaterThan(initialBottom.y + 75);

  const outputBefore = await box('#output-canvas'), previewBefore = await box('#preview-wrap');
  await drag('monitors', 0, 65);
  expect((await box('#output-canvas')).height).toBeGreaterThan(outputBefore.height + 55);
  expect((await box('#preview-wrap')).height).toBeLessThan(previewBefore.height - 55);

  const monitorBefore = await box('.monitor-panel'), contextBefore = await box('.context-panel');
  await drag('panel-0', 75, 0);
  expect((await box('.monitor-panel')).width).toBeGreaterThan(monitorBefore.width + 65);
  expect((await box('.context-panel')).width).toBeLessThan(contextBefore.width - 65);
  const contextAfter = await box('.context-panel'), clipBefore = await box('.clip-panel');
  await drag('panel-1', -35, 0);
  expect((await box('.context-panel')).width).toBeLessThan(contextAfter.width - 25);
  expect((await box('.clip-panel')).width).toBeGreaterThan(clipBefore.width + 25);
  const clipAfter = await box('.clip-panel'), browserBefore = await box('.browser-panel');
  await drag('panel-2', 45, 0);
  expect((await box('.clip-panel')).width).toBeGreaterThan(clipAfter.width + 35);
  expect((await box('.browser-panel')).width).toBeLessThan(browserBefore.width - 35);

  const beforeReload = await Promise.all(['.workspace', '#output-canvas', '#preview-wrap', '.monitor-panel',
    '.context-panel', '.clip-panel', '.browser-panel'].map(box));
  await page.reload();
  const afterReload = await Promise.all(['.workspace', '#output-canvas', '#preview-wrap', '.monitor-panel',
    '.context-panel', '.clip-panel', '.browser-panel'].map(box));
  beforeReload.forEach((rect, index) => {
    expect(Math.abs(afterReload[index].width - rect.width)).toBeLessThan(3);
    expect(Math.abs(afterReload[index].height - rect.height)).toBeLessThan(3);
  });
  await page.locator('[data-layout-splitter="workspace"]').focus();
  const beforeKey = await box('.workspace');
  await page.keyboard.press('ArrowUp');
  expect((await box('.workspace')).height).toBeLessThan(beforeKey.height - 8);
  await page.setViewportSize({ width: 1360, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1360);
  await expect(page.locator('#output-canvas')).toBeVisible();
  await expect(page.locator('#preview-canvas')).toBeVisible();
  await page.setViewportSize({ width: 1100, height: 650 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1100);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(650);
  expect((await box('#output-canvas')).height).toBeGreaterThan(35);
  expect((await box('#preview-wrap')).height).toBeGreaterThan(35);
  await page.setViewportSize({ width: 1600, height: 1000 });
  expect((await box('.workspace')).height).toBeGreaterThan(380);
  expect(errors).toEqual([]);
});
