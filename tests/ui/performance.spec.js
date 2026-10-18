import { test, expect } from '@playwright/test';
import path from 'node:path';

const pageErrors = new WeakMap();
test.beforeEach(async ({ page }) => {
  const errors = []; pageErrors.set(page, errors); page.on('pageerror', error => errors.push(error.message));
});
test.afterEach(async ({ page }) => { expect(pageErrors.get(page)).toEqual([]); });
const diagnostics = page => page.evaluate(() => window.prismDiagnostics());
const row = (page, layerId) => page.locator(`.layer-row[data-layer="${layerId}"]`);
const slot = (page, layerId, column) => row(page, layerId).locator(`[data-slot="${column}"]`);
const clipIn = (project, id) => project.layers.flatMap(layer => Object.values(layer.clips).flat()).find(clip => clip?.id === id);
const canvasSize = page => page.locator('#output-canvas').evaluate(canvas => [canvas.width, canvas.height]);

async function chooseFile(page, selector, file) {
  const chooser = page.waitForEvent('filechooser'); await page.locator(selector).click(); await (await chooser).setFiles(file);
}
async function numberField(page, key, value) {
  const input = page.locator(`#inspector [data-number="${key}"]`); await input.fill(String(value)); await input.blur();
}
async function saveProject(page) {
  const download = page.waitForEvent('download'); await page.locator('#save-project').click();
  const chunks = []; for await (const chunk of await (await download).createReadStream()) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function openProject(page, project) {
  await chooseFile(page, '#open-project', { name: 'performance.prism.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project)) });
  await expect(page.locator('#save-state')).toHaveText('LOADED');
}
async function pixel(page, x = 0.5, y = 0.5) {
  return page.evaluate(([x, y]) => {
    const canvas = document.querySelector('#output-canvas'), gl = canvas.getContext('webgl2'), rgba = new Uint8Array(4);
    gl.readPixels(Math.floor(canvas.width * x), Math.floor(canvas.height * y), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    return [...rgba.slice(0, 3)];
  }, [x, y]);
}
const brightness = async (page, x, y) => (await pixel(page, x, y)).reduce((sum, channel) => sum + channel, 0);

test('custom composition description and dimensions resize the renderer and survive save/open', async ({ page }) => {
  await page.goto('/'); await page.locator('[data-inspector="composition"]').click();
  const description = 'Projection wall A\n940 by 530 pixels — late set';
  await page.locator('#composition-description').fill(description); await page.locator('#composition-description').blur();
  await page.locator('#composition-width').fill('940'); await page.locator('#composition-height').fill('530');
  await page.locator('#apply-composition-size').click();
  await expect.poll(() => canvasSize(page)).toEqual([940, 530]);
  await expect(page.locator('#composition-size')).toHaveValue('940,530');
  await expect(page.locator('#resolution')).toContainText('940');
  const saved = await saveProject(page);
  expect(saved.description).toBe(description); expect([saved.width, saved.height]).toEqual([940, 530]);
  await page.locator('#composition-size').selectOption('640,360');
  await expect.poll(() => canvasSize(page)).toEqual([640, 360]);
  await openProject(page, saved); await expect.poll(() => canvasSize(page)).toEqual([940, 530]);
  await page.locator('[data-inspector="composition"]').click();
  await expect(page.locator('#composition-description')).toHaveValue(description);
});

test('pixel position, XYZ rotation, anchors and dimension overrides edit and persist at clip and layer scope', async ({ page }) => {
  await page.goto('/');
  const initial = await diagnostics(page), layer = initial.project.layers[0], clipId = layer.clips[initial.project.selectedDeckId][1].id;
  await row(page, layer.id).locator('[data-action="solo"]').click(); await slot(page, layer.id, 1).locator('.clip-art').click();
  await page.locator('#inspector [data-dimension="width"]').check(); await numberField(page, 'width', 160);
  await page.locator('#inspector [data-dimension="height"]').check(); await numberField(page, 'height', 120);
  await numberField(page, 'x', 320);
  await expect.poll(() => brightness(page, 0.5, 0.5)).toBeLessThan(5);
  await expect.poll(() => brightness(page, 0.75, 0.5)).toBeGreaterThan(300);
  expect(clipIn((await diagnostics(page)).project, clipId).x).toBeCloseTo(0.25);
  await page.locator('label[for="prop-x"]').click({ button: 'right' });
  await expect(page.locator('#inspector [data-number="x"]')).toHaveValue('0.00');
  expect(clipIn((await diagnostics(page)).project, clipId).x).toBe(0);
  for (const [key, value] of Object.entries({ x: 128, y: -90, rotationX: 30, rotationY: -25, rotation: 15, anchorX: 40, anchorY: -20, anchorZ: 60 })) await numberField(page, key, value);
  await row(page, layer.id).locator('[data-layer-select]').click();
  await page.locator('#inspector [data-dimension="width"]').check(); await numberField(page, 'width', 400);
  await page.locator('#inspector [data-dimension="height"]').check(); await numberField(page, 'height', 300);
  await numberField(page, 'rotationX', 12); await numberField(page, 'anchorZ', -80);
  const saved = await saveProject(page), clip = clipIn(saved, clipId), savedLayer = saved.layers.find(item => item.id === layer.id);
  expect(clip.x).toBeCloseTo(0.1); expect(clip.y).toBeCloseTo(-0.125);
  for (const [key, value] of Object.entries({ width: 160, height: 120, rotationX: 30, rotationY: -25, rotation: 15, anchorX: 40, anchorY: -20, anchorZ: 60 })) expect(clip[key], key).toBe(value);
  expect(savedLayer.widthEnabled).toBe(true); expect(savedLayer.heightEnabled).toBe(true);
  expect([savedLayer.width, savedLayer.height, savedLayer.rotationX, savedLayer.anchorZ]).toEqual([400, 300, 12, -80]);
  await openProject(page, saved); await slot(page, layer.id, 1).click({ button: 'right' });
  await expect(page.locator('#inspector [data-number="x"]')).toHaveValue('128');
  await expect(page.locator('#inspector [data-number="anchorZ"]')).toHaveValue('60');
  await expect(page.locator('#inspector [data-dimension="width"]')).toBeChecked();
});

test('fit modes change real image bounds and RGB toggles alter only their selected channels', async ({ page }) => {
  await page.goto('/'); await page.locator('[data-inspector="composition"]').click();
  await page.locator('#composition-width').fill('320'); await page.locator('#composition-height').fill('320');
  await page.locator('#apply-composition-size').click();
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 64;
    const context = canvas.getContext('2d'); context.fillStyle = '#d08040'; context.fillRect(0, 0, 128, 64);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  const layer = (await diagnostics(page)).project.layers[0];
  await row(page, layer.id).locator('[data-layer-select]').click(); await row(page, layer.id).locator('[data-action="solo"]').click();
  await page.locator('[data-browser="files"]').click();
  await chooseFile(page, '#import-media', { name: 'wide-color.png', mimeType: 'image/png', buffer: Buffer.from(base64, 'base64') });
  const imported = page.locator('.clip-slot').filter({ hasText: 'wide-color.png' }); await expect(imported).toHaveCount(1);
  const clipId = await imported.getAttribute('data-clip'); await imported.locator('.clip-art').click();
  await page.locator('#prop-fit').selectOption('width');
  await expect.poll(() => brightness(page, 0.5, 0.1)).toBeLessThan(5); await expect.poll(() => brightness(page, 0.5, 0.5)).toBeGreaterThan(350);
  await page.locator('#prop-fit').selectOption('height'); await expect.poll(() => brightness(page, 0.5, 0.1)).toBeGreaterThan(350);
  await page.locator('#prop-fit').selectOption('original');
  await expect.poll(() => brightness(page, 0.1, 0.5)).toBeLessThan(5); await expect.poll(() => brightness(page, 0.5, 0.5)).toBeGreaterThan(350);
  await page.locator('#prop-fit').selectOption('stretch'); await expect.poll(() => brightness(page, 0.1, 0.1)).toBeGreaterThan(350);
  await page.locator('[data-channel="red"]').uncheck();
  await expect.poll(async () => (await pixel(page))[0]).toBeLessThan(3);
  const greenBlue = await pixel(page); expect(greenBlue[1]).toBeGreaterThan(120); expect(greenBlue[2]).toBeGreaterThan(60);
  await page.locator('[data-channel="green"]').uncheck(); await expect.poll(async () => (await pixel(page))[1]).toBeLessThan(3);
  await page.locator('[data-channel="red"]').check(); await expect.poll(async () => (await pixel(page))[0]).toBeGreaterThan(200);
  const savedClip = clipIn(await saveProject(page), clipId);
  expect([savedClip.nativeWidth, savedClip.nativeHeight]).toEqual([128, 64]);
  expect(savedClip.fit).toBe('stretch'); expect([savedClip.red, savedClip.green, savedClip.blue]).toEqual([true, false, true]);
});

test('right-click pins global playback direction for future launches and can unpin it', async ({ page }) => {
  await page.goto('/');
  const initial = await diagnostics(page), layer = initial.project.layers[0], deckId = initial.project.selectedDeckId;
  await page.locator('[data-global-direction="backward"]').click({ button: 'right' });
  await expect(page.locator('[data-global-direction="backward"]')).toHaveClass(/pinned/);
  await slot(page, layer.id, 1).locator('.clip-art').click();
  const firstId = layer.clips[deckId][1].id;
  await expect.poll(async () => (await diagnostics(page)).frames.find(frame => frame.clipId === firstId)?.direction).toBe(-1);
  expect(clipIn((await diagnostics(page)).project, firstId).direction).toBe(-1);
  await page.locator('[data-global-direction="forward"]').click();
  expect((await diagnostics(page)).project.directionPin).toBe('backward');
  await slot(page, layer.id, 2).locator('.clip-art').click();
  const nextId = layer.clips[deckId][2].id;
  await expect.poll(async () => (await diagnostics(page)).frames.find(frame => frame.clipId === nextId)?.direction).toBe(-1);
  await page.locator('[data-global-direction="backward"]').click({ button: 'right' });
  await expect(page.locator('[data-global-direction="backward"]')).not.toHaveClass(/pinned/);
  await slot(page, layer.id, 3).locator('.clip-art').click();
  await expect.poll(async () => (await diagnostics(page)).frames.find(frame => frame.clipId === layer.clips[deckId][3].id)?.direction).toBe(1);
  expect((await diagnostics(page)).project.directionPin).toBeNull();
});

test('selected target inherits composition defaults while clip overrides and piano release remain independent', async ({ page }) => {
  await page.goto('/'); await page.locator('#clear-all').click();
  const initial = await diagnostics(page), [, destination, source] = initial.project.layers, deckId = initial.project.selectedDeckId;
  const normalClip = source.clips[deckId][1], pianoClip = source.clips[deckId][2];
  await slot(page, source.id, 1).click({ button: 'right' }); await page.locator('#prop-triggerStyle').selectOption('normal');
  await page.locator('[data-inspector="composition"]').click();
  await page.locator('#prop-clipTarget').selectOption('selected'); await page.locator('#prop-triggerStyle').selectOption('piano');
  await row(page, destination.id).locator('[data-layer-select]').click(); await slot(page, source.id, 1).locator('.clip-art').click();
  await expect.poll(async () => (await diagnostics(page)).project.layers[1].activeClipId).toBe(normalClip.id);
  expect((await diagnostics(page)).project.layers[2].activeClipId).toBeNull();
  await row(page, destination.id).locator('[data-layer-select]').click();
  const bounds = await slot(page, source.id, 2).locator('.clip-art').boundingBox();
  await page.mouse.move(bounds.x + 20, bounds.y + 20); await page.mouse.down();
  await expect.poll(async () => (await diagnostics(page)).project.layers[1].activeClipId).toBe(pianoClip.id);
  await page.mouse.up(); await expect.poll(async () => (await diagnostics(page)).project.layers[1].activeClipId).toBeNull();
  await slot(page, source.id, 1).click({ button: 'right' }); await page.locator('#prop-clipTarget').selectOption('own');
  await row(page, destination.id).locator('[data-layer-select]').click(); await slot(page, source.id, 1).locator('.clip-art').click();
  await expect.poll(async () => (await diagnostics(page)).project.layers[2].activeClipId).toBe(normalClip.id);
  expect((await diagnostics(page)).project.layers[1].activeClipId).toBeNull();
  expect((await diagnostics(page)).project.layers[2].clips[deckId][2].id).toBe(pianoClip.id);
});

test('free piano key chords play two independent decoders of one video and release only the held key', async ({ page }) => {
  test.setTimeout(45000);
  await page.goto('/'); await page.locator('[data-browser="files"]').click();
  await chooseFile(page, '#import-media', path.resolve('tests/engine-fixture.webm'));
  const imported = page.locator('.clip-slot').filter({ hasText: 'engine-fixture.webm' }); await expect(imported).toHaveCount(1);
  const clipId = await imported.getAttribute('data-clip'), source = (await diagnostics(page)).project.layers.at(-1);
  await page.locator('#cut-clip').click(); await slot(page, source.id, 0).click({ button: 'right' }); await page.locator('#paste-clip').click();
  await expect(slot(page, source.id, 0)).toHaveAttribute('data-clip', clipId);
  await page.locator('[data-inspector="composition"]').click();
  await page.locator('#prop-clipTarget').selectOption('free'); await page.locator('#prop-triggerStyle').selectOption('piano');
  await page.locator('#clear-all').click(); await slot(page, source.id, 0).click({ button: 'right' });
  await expect(page.locator('#prop-clipTarget')).toHaveValue('inherit'); await expect(page.locator('#prop-triggerStyle')).toHaveValue('inherit');
  await page.locator('#status-text').click();
  try {
    await page.keyboard.down('Digit1');
    await expect.poll(async () => (await diagnostics(page)).voices.filter(voice => voice.clipId === clipId && voice.mediaPaused === false).length).toBe(1);
    await expect.poll(async () => (await diagnostics(page)).voices.find(voice => voice.clipId === clipId)?.mediaTime).toBeGreaterThan(0.2);
    const first = (await diagnostics(page)).frames.find(frame => frame.clipId === clipId);
    await page.keyboard.down('Enter');
    await expect.poll(async () => (await diagnostics(page)).voices.filter(voice => voice.clipId === clipId && voice.mediaPaused === false).length).toBe(2);
    const chord = await diagnostics(page), frames = chord.frames.filter(frame => frame.clipId === clipId), voices = chord.voices.filter(voice => voice.clipId === clipId);
    expect(frames).toHaveLength(2); expect(new Set(frames.map(frame => frame.voiceId)).size).toBe(2);
    expect(new Set(frames.map(frame => frame.inputId)).size).toBe(2); expect(new Set(frames.map(frame => frame.layerId)).size).toBe(2);
    expect(frames.every(frame => frame.sourceLayerId === source.id)).toBe(true);
    expect(Math.abs(voices[0].mediaTime - voices[1].mediaTime)).toBeGreaterThan(0.12);
    const second = frames.find(frame => frame.voiceId !== first.voiceId);
    expect(chord.project.layers.at(-1).clips[chord.project.selectedDeckId][0].id).toBe(clipId);
    expect(chord.project.layers.flatMap(layer => Object.values(layer.clips).flat()).filter(clip => clip?.id === clipId)).toHaveLength(1);
    await page.keyboard.up('Digit1');
    await expect.poll(async () => (await diagnostics(page)).frames.filter(frame => frame.clipId === clipId).map(frame => frame.voiceId)).toEqual([second.voiceId]);
    await expect.poll(async () => (await diagnostics(page)).voices.find(voice => voice.voiceId === second.voiceId)?.mediaPaused).toBe(false);
    await page.keyboard.up('Enter'); await expect.poll(async () => (await diagnostics(page)).frames.length).toBe(0);
  } finally { await page.keyboard.up('Digit1'); await page.keyboard.up('Enter'); }
});

test('preferences keep the inspector fixed while triggering and survive reload', async ({ page }) => {
  await page.goto('/');
  const initial = await diagnostics(page), layer = initial.project.layers.at(-1), deckId = initial.project.selectedDeckId;
  await slot(page, layer.id, 0).click({ button: 'right' });
  const selectedName = layer.clips[deckId][0].name, triggeredId = layer.clips[deckId][1].id;
  await page.locator('#preferences').click();
  await page.locator('[data-preference="clipPanelFollowsTrigger"]').uncheck(); await page.locator('[data-preference="showLayerTransport"]').check();
  await page.locator('dialog[open]').getByRole('button', { name: 'Save settings', exact: true }).click(); await expect(page.locator('dialog')).toHaveCount(0);
  await expect(row(page, layer.id).locator('.layer-transport')).toBeVisible();
  await slot(page, layer.id, 1).locator('.clip-art').click();
  await expect.poll(async () => (await diagnostics(page)).project.layers.at(-1).activeClipId).toBe(triggeredId);
  await expect(page.locator('#inspector h2')).toHaveText(selectedName); await expect(slot(page, layer.id, 0)).toHaveClass(/selected/);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('prism-preferences')));
  expect(stored.clipPanelFollowsTrigger).toBe(false); expect(stored.showLayerTransport).toBe(true);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-layer-transport', 'true'); await expect(page.locator('.layer-transport').first()).toBeVisible();
  await page.locator('#preferences').click(); await expect(page.locator('[data-preference="clipPanelFollowsTrigger"]')).not.toBeChecked();
  await expect(page.locator('[data-preference="showLayerTransport"]')).toBeChecked();
  await page.locator('dialog[open]').getByRole('button', { name: 'Cancel', exact: true }).click();
});
