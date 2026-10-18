import { test, expect } from '@playwright/test';

const diagnostics = page => page.evaluate(() => window.prismDiagnostics());
const clipById = (project, id) => project.layers.flatMap(layer => Object.values(layer.clips).flat()).find(clip => clip?.id === id);
const watchErrors = page => { const errors = []; page.on('pageerror', error => errors.push(error.message)); return errors; };

test('crossfader settings and Jump & Return / Cut button behaviours', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/');
  await page.locator('[data-inspector="composition"]').click();
  const panel = page.locator('[data-inspector-panel="context"]');
  await panel.locator('[data-prop="crossfaderCurve"]').selectOption('linear');
  await panel.locator('[data-prop="crossfaderBehaviour"]').selectOption('jump-return');
  await panel.locator('[data-prop="crossfaderBlend"]').selectOption('screen');
  let project = (await diagnostics(page)).project;
  expect(project).toMatchObject({ crossfaderCurve: 'linear', crossfaderBehaviour: 'jump-return', crossfaderBlend: 'screen' });
  await page.locator('#cross-b').click();
  expect((await diagnostics(page)).project.crossfader).toBe(1);
  await page.locator('#cross-b').click();
  expect((await diagnostics(page)).project.crossfader).toBeCloseTo(0.5, 5);
  await panel.locator('[data-prop="crossfaderBehaviour"]').selectOption('cut');
  const box = await page.locator('#cross-a').boundingBox();
  await page.mouse.move(box.x + 5, box.y + 5); await page.mouse.down();
  expect((await diagnostics(page)).project.crossfader).toBe(0);
  await page.mouse.up();
  expect((await diagnostics(page)).project.crossfader).toBeCloseTo(0.5, 5);
  expect(errors).toEqual([]);
});

test('number fields accept math and arrow-key nudges', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/');
  const field = page.locator('[data-inspector-panel="clip"] [data-number="x"]');
  await field.fill('1280/4'); await field.press('Enter');
  const id = (await diagnostics(page)).project.layers.at(-1).activeClipId;
  expect(clipById((await diagnostics(page)).project, id).x * 1280).toBeCloseTo(320, 3);
  await page.locator('[data-inspector-panel="clip"] [data-number="x"]').press('ArrowUp');
  expect(clipById((await diagnostics(page)).project, id).x * 1280).toBeCloseTo(321, 3);
  await page.locator('[data-inspector-panel="clip"] [data-number="x"]').press('Shift+ArrowDown');
  expect(clipById((await diagnostics(page)).project, id).x * 1280).toBeCloseTo(311, 3);
  expect(errors).toEqual([]);
});

test('random play mode exposes interval and distance; relative pick-up and SMPTE modes are selectable', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/');
  const panel = page.locator('[data-inspector-panel="clip"]');
  const id = (await diagnostics(page)).project.layers.at(-1).activeClipId;
  await panel.locator('[data-playmode="random"]').click();
  await panel.locator('#random-interval').fill('0.5'); await panel.locator('#random-interval').press('Tab');
  await panel.locator('#random-distance').fill('2'); await panel.locator('#random-distance').press('Tab');
  await panel.locator('[data-away="relative"]').click();
  let clip = clipById((await diagnostics(page)).project, id);
  expect(clip).toMatchObject({ loop: 'random', randomInterval: 0.5, randomDistance: 2, trigger: 'relative' });
  await panel.locator('#transport-mode').selectOption('smpte');
  await panel.locator('#smpte-offset').fill('00:00:10:00'); await panel.locator('#smpte-offset').press('Tab');
  await panel.locator('#smpte-end').selectOption('loop');
  clip = clipById((await diagnostics(page)).project, id);
  expect(clip).toMatchObject({ smpte: true, beatSync: false, smpteOffset: 10, smpteEnd: 'loop' });
  expect(errors).toEqual([]);
});

test('double-clicking an effect previews it over the composition; column buttons step columns', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/');
  await page.locator('[data-browser="effects"]').click();
  await page.locator('[data-add-effect="invert-rgb"]').dblclick();
  await expect(page.locator('#preview-label')).toContainText('Invert');
  await expect(page.locator('#preview-canvas')).toBeVisible();
  await page.locator('#next-column').click();
  await expect.poll(async () => (await diagnostics(page)).frames.length).toBeGreaterThan(0);
  const project = (await diagnostics(page)).project, deck = project.selectedDeckId;
  const firstColumn = project.layers.map(layer => layer.clips[deck][0]?.id);
  expect(project.layers.map(layer => layer.activeClipId)).toEqual(firstColumn);
  await page.locator('#next-column').click();
  await expect.poll(async () => { const p = (await diagnostics(page)).project; return p.layers.map(layer => layer.activeClipId).join(); })
    .toBe(project.layers.map(layer => layer.clips[deck][1]?.id).join());
  expect(errors).toEqual([]);
});

test('a shortcut set to Selected follows the selected layer', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/');
  await page.locator('body').press('Control+Shift+K');
  await page.locator('.layer-row').first().locator('[data-action="bypass"]').click();
  await page.keyboard.press('KeyG');
  await page.keyboard.press('Escape');
  await page.locator('[data-browser="controls"]').click();
  await page.locator('[data-shortcut-field="targetMode"]').selectOption('selected');
  const project = (await diagnostics(page)).project;
  const bottom = project.layers[0];
  await page.locator(`[data-layer-select="${bottom.id}"]`).click();
  await page.locator('#status-text').click();
  await page.keyboard.press('KeyG');
  const after = (await diagnostics(page)).project;
  expect(after.layers[0].bypass).toBe(true);
  expect(after.layers.at(-1).bypass).toBe(false);
  expect(errors).toEqual([]);
});

test('right-clicking an empty slot offers import and quick sources; generators get thumbnails', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/');
  const row = page.locator('.layer-row').first();
  await row.locator('[data-slot="6"]').click({ button: 'right' });
  await expect(page.locator('.context-menu')).toContainText('Import image sequence');
  await page.locator('.context-menu button', { hasText: 'Add Gradient' }).click();
  const project = (await diagnostics(page)).project;
  const added = project.layers.at(-1).clips[project.selectedDeckId][6];
  expect(added.source).toBe('gradient');
  await expect(row.locator('[data-slot="6"] .clip-art img')).toHaveAttribute('src', /^data:image\/jpeg/, { timeout: 15000 });
  expect(errors).toEqual([]);
});
