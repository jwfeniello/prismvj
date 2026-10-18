import { test, expect } from '@playwright/test';

const diagnostics = page => page.evaluate(() => window.prismDiagnostics());
const clipById = (project, id) => project.layers.flatMap(layer => Object.values(layer.clips).flat()).find(clip => clip?.id === id);

test('effects browser search, parameter cards, presets and bypass', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.locator('[data-browser="effects"]').click();
  expect(await page.locator('[data-add-effect]').count()).toBeGreaterThan(60);
  await page.locator('#effect-search').fill('kaleido');
  await expect(page.locator('[data-add-effect]')).not.toHaveCount(0);
  expect(await page.locator('[data-add-effect]').count()).toBeLessThan(6);
  await page.locator('#effect-search').fill('');
  await page.locator('[data-inspector="layer"]').click();
  await page.locator('[data-add-effect="hue-rotate"]').click();
  const card = page.locator('[data-inspector-panel="context"] .effect-card');
  await expect(card).toHaveCount(1);
  const opacity = card.locator('input[type="range"][data-param-path$="/opacity"]');
  await opacity.evaluate(input => { input.value = '0.4'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  let project = await diagnostics(page);
  const layer = project.project.layers.at(-1);
  expect(layer.effects[0].opacity).toBeCloseTo(0.4, 3);
  await card.locator('[data-fx-bypass]').click();
  project = await diagnostics(page);
  expect(project.project.layers.at(-1).effects[0].enabled).toBe(false);
  await page.locator('[data-effect-kind-tab="audio"]').click();
  await page.locator('[data-add-effect="delay"]').click();
  project = await diagnostics(page);
  expect(project.project.layers.at(-1).audioEffects[0].type).toBe('delay');
  expect(errors).toEqual([]);
});

test('parameter cog animates a playing clip in BPM sync', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  const panel = page.locator('[data-inspector-panel="clip"]');
  await panel.locator('.field [data-animate-path$="/rotation"]').click();
  await page.locator('.animation-editor [data-anim-mode]').selectOption('bpm');
  await page.locator('.animation-editor [data-anim="beats"]').fill('1');
  await page.locator('.animation-editor [data-anim="beats"]').dispatchEvent('change');
  await page.locator('.animation-editor [data-anim-close]').click();
  const first = await diagnostics(page), id = first.project.layers.at(-1).activeClipId;
  await page.waitForTimeout(250);
  const second = await diagnostics(page);
  const a = clipById(first.project, id), b = clipById(second.project, id);
  expect(b.animations.rotation.mode).toBe('bpm');
  expect(b.rotation).not.toBe(a.rotation);
  await expect(panel.locator('.field [data-animate-path$="/rotation"]')).toHaveClass(/animated/);
  expect(errors).toEqual([]);
});

test('layer menu creates a group with its own row, inspector and column triggers', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.locator('[data-layer-select]').first().click({ button: 'right' });
  await page.locator('.context-menu button', { hasText: 'Group › New' }).click();
  await expect(page.locator('[data-group-row]')).toHaveCount(1);
  await page.locator('[data-group-select]').click();
  await expect(page.locator('[data-inspector-panel="context"]')).toContainText('Group mixing');
  await page.locator('[data-group-row] [data-group-action="bypass"]').click();
  let project = (await diagnostics(page)).project;
  expect(project.groups[0].bypass).toBe(true);
  await page.locator('[data-group-row] [data-group-action="bypass"]').click();
  await page.locator('[data-group-row] [data-group-column="2"]').click();
  await expect.poll(async () => (await diagnostics(page)).project.layers.find(layer => layer.groupId)?.activeClipId).toBeTruthy();
  expect(errors).toEqual([]);
});

test('keyboard shortcut mode assigns a key that then toggles blackout', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.locator('body').press('Control+Shift+K');
  await expect(page.locator('html')).toHaveAttribute('data-shortcut-edit', 'key');
  await page.locator('#blackout').click();
  await page.keyboard.press('KeyJ');
  await page.keyboard.press('Escape');
  await expect(page.locator('html')).not.toHaveAttribute('data-shortcut-edit', 'key');
  expect((await diagnostics(page)).project.shortcuts[0].target).toBe('composition/blackout');
  await page.locator('#status-text').click();
  await page.keyboard.press('KeyJ');
  await expect(page.locator('#blackout')).toHaveClass(/active/);
  await page.keyboard.press('KeyJ');
  await expect(page.locator('#blackout')).not.toHaveClass(/active/);
  expect(errors).toEqual([]);
});

test('sources browser adds catalog generators and an effect clip from an effect drop', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.locator('[data-browser="sources"]').click();
  await page.locator('[data-source="voronoi"]').click();
  await expect(page.locator('[data-inspector-panel="clip"] .source-params .param-row')).not.toHaveCount(0);
  await page.locator('[data-browser="effects"]').click();
  const row = page.locator('.layer-row').first();
  await page.locator('[data-add-effect="invert-rgb"]').dragTo(row.locator('[data-slot="7"]'));
  const project = (await diagnostics(page)).project;
  const slot = project.layers.at(-1).clips[project.selectedDeckId][7];
  expect(slot.kind).toBe('effect');
  expect(slot.effects[0].type).toBe('invert-rgb');
  expect(errors).toEqual([]);
});
