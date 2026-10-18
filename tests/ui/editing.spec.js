import { test, expect } from '@playwright/test';
import path from 'node:path';

const pageErrors = new WeakMap();
test.beforeEach(async ({ page }) => {
  const errors = []; pageErrors.set(page, errors);
  page.on('pageerror', error => errors.push(error.message));
});
test.afterEach(async ({ page }) => { expect(pageErrors.get(page)).toEqual([]); });

const diagnostics = page => page.evaluate(() => window.prismDiagnostics());
const rowFor = (page, layerId) => page.locator(`.layer-row[data-layer="${layerId}"]`);
const slotFor = (page, layerId, column) => rowFor(page, layerId).locator(`[data-slot="${column}"]`);
const clipIn = (project, clipId) => project.layers.flatMap(layer => Object.values(layer.clips).flat()).find(clip => clip?.id === clipId);

async function pickFile(page, selector, file) {
  const chooser = page.waitForEvent('filechooser');
  await page.locator(selector).click();
  await (await chooser).setFiles(file);
}

async function deckAction(page, action) {
  await page.locator('#deck-actions').click();
  await page.locator('dialog[open]').getByRole('button', { name: action, exact: true }).click();
  await expect(page.locator('dialog')).toHaveCount(0);
}

async function saveProject(page) {
  const download = page.waitForEvent('download');
  await page.locator('#save-project').click();
  const stream = await (await download).createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function toneWav(seconds = 4) {
  const sampleRate = 48000, samples = sampleRate * seconds;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(samples * 2, 40);
  for (let sample = 0; sample < samples; sample++) buffer.writeInt16LE(Math.round(Math.sin(sample * 440 * Math.PI * 2 / sampleRate) * 16000), 44 + sample * 2);
  return { name: 'paired-tone.wav', mimeType: 'audio/wav', buffer };
}

async function maskPNG(page) {
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 16;
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff'; context.fillRect(0, 0, 8, 16);
    context.fillStyle = '#000'; context.fillRect(8, 0, 8, 16);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  return { name: 'split-mask.png', mimeType: 'image/png', buffer: Buffer.from(base64, 'base64') };
}

async function outputSamples(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('#output-canvas'), gl = canvas.getContext('webgl2');
    return [0.25, 0.75].map(x => {
      const pixel = new Uint8Array(4);
      gl.readPixels(Math.floor(canvas.width * x), Math.floor(canvas.height / 2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      return [...pixel.slice(0, 3)].reduce((sum, value) => sum + value, 0);
    });
  });
}

test('changing column counts keeps live playheads and exposes the new slots', async ({ page }) => {
  await page.goto('/');
  const initial = await diagnostics(page), layer = initial.project.layers.at(-1);
  const liveId = layer.activeClipId;
  await slotFor(page, layer.id, 0).click({ button: 'right' });
  await page.locator('#source-duration').fill('120'); await page.locator('#source-duration').blur();
  expect(clipIn((await diagnostics(page)).project, liveId).duration).toBe(120);
  await page.locator('#timeline').fill('0.4'); await page.locator('#timeline').blur();
  const starting = (await diagnostics(page)).frames.find(frame => frame.clipId === liveId).time;
  expect(starting).toBeGreaterThanOrEqual(48); expect(starting).toBeLessThan(49);
  for (const count of [10, 12]) {
    await page.locator('#column-actions').click();
    await page.locator('#column-count').fill(String(count));
    await page.locator('dialog[open]').getByRole('button', { name: 'Apply count', exact: true }).click();
    await expect(page.locator('#column-heads [data-column]')).toHaveCount(count);
    await expect(rowFor(page, layer.id).locator('[data-slot]')).toHaveCount(count);
    const after = await diagnostics(page);
    expect(after.project.columns).toBe(count);
    expect(after.frames.map(frame => frame.clipId)).toEqual(initial.frames.map(frame => frame.clipId));
    const time = after.frames.find(frame => frame.clipId === liveId).time;
    expect(time).toBeGreaterThanOrEqual(starting); expect(time).toBeLessThan(starting + 15);
  }
  await slotFor(page, layer.id, 11).click();
  await expect(slotFor(page, layer.id, 11)).toHaveClass(/selected/);
  const saved = await saveProject(page);
  expect(saved.columns).toBe(12);
  for (const item of saved.layers) for (const deck of saved.decks) expect(item.clips[deck.id]).toHaveLength(12);
});

test('deck insertion, renaming, reordering and deletion keep other decks playing', async ({ page }) => {
  await page.goto('/'); await page.locator('#pause').click();
  const initial = await diagnostics(page), originalIds = initial.project.decks.map(deck => deck.id);
  await deckAction(page, 'Insert before');
  const inserted = (await diagnostics(page)).project.selectedDeckId;
  await expect(page.locator('#decks button')).toHaveCount(3);
  await page.locator('#deck-actions').click(); await page.locator('#deck-name').fill('Breakdown');
  await page.locator('dialog[open]').getByRole('button', { name: 'Apply name', exact: true }).click();
  await expect(page.locator('#decks').getByRole('button', { name: 'Breakdown', exact: true })).toBeVisible();
  await deckAction(page, 'Move right');
  expect((await diagnostics(page)).project.decks.map(deck => deck.id)).toEqual([originalIds[0], inserted, originalIds[1]]);
  await deckAction(page, 'Remove deck');
  const after = await diagnostics(page);
  expect(after.project.decks.map(deck => deck.id)).toEqual(originalIds);
  expect(after.frames).toEqual(initial.frames);
  expect(after.project.decks.some(deck => deck.id === after.project.selectedDeckId)).toBe(true);
  await page.locator('#pause').click();
  await expect.poll(async () => (await diagnostics(page)).frames[0].position).not.toBe(initial.frames[0].position);
});

test('cut and paste across decks moves a playing clip without restarting it', async ({ page }) => {
  await page.goto('/');
  const initial = await diagnostics(page), layer = initial.project.layers.at(-1), oldDeck = initial.project.selectedDeckId;
  const liveId = layer.activeClipId;
  await slotFor(page, layer.id, 0).click({ button: 'right' });
  await page.locator('#source-duration').fill('120'); await page.locator('#source-duration').blur();
  expect(clipIn((await diagnostics(page)).project, liveId).duration).toBe(120);
  await page.locator('#timeline').fill('0.4'); await page.locator('#timeline').blur();
  const before = (await diagnostics(page)).frames.find(frame => frame.clipId === liveId).time;
  expect(before).toBeGreaterThanOrEqual(48); expect(before).toBeLessThan(49);
  await page.locator('#cut-clip').click();
  expect((await diagnostics(page)).project.layers.at(-1).clips[oldDeck][0].id).toBe(liveId);
  await page.locator('#decks').getByRole('button', { name: 'After hours', exact: true }).click();
  await slotFor(page, layer.id, 5).click(); await page.locator('#paste-clip').click();
  await expect(slotFor(page, layer.id, 5)).toHaveClass(/playing/);
  const after = await diagnostics(page);
  expect(after.project.layers.at(-1).clips[oldDeck][0]).toBeNull();
  expect(after.project.layers.at(-1).clips[after.project.selectedDeckId][5].id).toBe(liveId);
  expect(after.frames.find(frame => frame.clipId === liveId).time).toBeGreaterThanOrEqual(before);
  expect(after.frames.find(frame => frame.clipId === liveId).time).toBeLessThan(before + 15);
  await expect(page.locator('.toast.error')).toHaveCount(0);
});

test('Shift selects a clip range and applies opacity without retriggering the range', async ({ page }) => {
  await page.goto('/'); await page.locator('#pause').click();
  const initial = await diagnostics(page), layer = initial.project.layers.at(-1), deckId = initial.project.selectedDeckId;
  await slotFor(page, layer.id, 0).click({ button: 'right' });
  await slotFor(page, layer.id, 2).click({ modifiers: ['Shift'] });
  await expect(rowFor(page, layer.id).locator('.clip-slot.selected')).toHaveCount(3);
  await page.locator('#prop-opacity').fill('0.35'); await page.locator('#prop-opacity').blur();
  const after = await diagnostics(page), clips = after.project.layers.at(-1).clips[deckId];
  expect(clips.slice(0, 3).map(clip => clip.opacity)).toEqual([0.35, 0.35, 0.35]);
  expect(clips[3].opacity).toBe(1); expect(after.frames).toEqual(initial.frames);
});

test('a group cut across layers preserves playheads after transient destination conflicts', async ({ page }) => {
  await page.goto('/');
  const initial = await diagnostics(page), [bottom, middle, top] = initial.project.layers, deckId = initial.project.selectedDeckId;
  await rowFor(page, top.id).locator('[data-action="stop"]').click(); await page.locator('#pause').click();
  const before = await diagnostics(page);
  await slotFor(page, bottom.id, 0).click({ button: 'right' });
  await slotFor(page, middle.id, 0).click({ modifiers: ['Shift'] });
  await expect(page.locator('.clip-slot.selected')).toHaveCount(2);
  await page.locator('#cut-clip').click();
  await slotFor(page, middle.id, 1).click({ button: 'right' }); await page.locator('#paste-clip').click();
  const after = await diagnostics(page);
  expect(after.project.layers[1].clips[deckId][1].id).toBe(bottom.activeClipId);
  expect(after.project.layers[2].clips[deckId][1].id).toBe(middle.activeClipId);
  expect(after.project.layers[1].activeClipId).toBe(bottom.activeClipId);
  expect(after.project.layers[2].activeClipId).toBe(middle.activeClipId);
  expect(after.frames.map(frame => [frame.clipId, frame.position]).sort()).toEqual(before.frames.map(frame => [frame.clipId, frame.position]).sort());
});

test('column triggers respect locked layers, playing clips, and excluded target clips', async ({ page }) => {
  await page.goto('/');
  const initial = await diagnostics(page), [bottom, middle, top] = initial.project.layers, deckId = initial.project.selectedDeckId;
  await rowFor(page, bottom.id).locator('[data-layer-select]').click(); await page.locator('#ignore-column').check();
  await slotFor(page, top.id, 0).click({ button: 'right' }); await page.locator('#ignore-column').check();
  await page.locator('[data-column="1"]').click();
  await expect.poll(async () => (await diagnostics(page)).project.layers.map(layer => layer.activeClipId)).toEqual([
    bottom.activeClipId, middle.clips[deckId][1].id, top.activeClipId,
  ]);
  await page.locator('#ignore-column').uncheck();
  await rowFor(page, bottom.id).locator('[data-layer-select]').click(); await page.locator('#ignore-column').uncheck();
  await slotFor(page, middle.id, 2).click({ button: 'right' }); await page.locator('#ignore-column').check();
  await page.locator('[data-column="2"]').click();
  await expect.poll(async () => (await diagnostics(page)).project.layers.map(layer => layer.activeClipId)).toEqual([
    bottom.clips[deckId][2].id, middle.clips[deckId][1].id, top.clips[deckId][2].id,
  ]);
});

test('linked AV changes the actual layer output without changing its separate faders', async ({ page }) => {
  await page.goto('/');
  const initial = await diagnostics(page), layer = initial.project.layers[0];
  await rowFor(page, layer.id).locator('[data-action="solo"]').click(); await slotFor(page, layer.id, 1).click();
  await expect.poll(async () => (await outputSamples(page))[0]).toBeGreaterThan(300);
  const baseline = (await outputSamples(page))[0];
  await rowFor(page, layer.id).locator('[data-layer-prop="av"]').fill('0.25');
  await expect.poll(async () => (await outputSamples(page))[0]).toBeLessThan(baseline * 0.35);
  expect((await outputSamples(page))[0]).toBeGreaterThan(baseline * 0.15);
  const result = (await diagnostics(page)).project.layers[0];
  expect(result.av).toBe(0.25); expect(result.opacity).toBe(layer.opacity); expect(result.volume).toBe(layer.volume);
});

test('real paired audio plays and copied clips have independent media and effect identities', async ({ page }) => {
  test.setTimeout(60000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/'); await page.locator('[data-browser="files"]').click();
  await pickFile(page, '#import-media', path.resolve('tests/engine-fixture.webm'));
  const imported = page.locator('.clip-slot').filter({ hasText: 'engine-fixture.webm' });
  await expect(imported).toHaveCount(1); await imported.click({ button: 'right' });
  const clipId = await imported.getAttribute('data-clip');
  const beforePair = clipIn((await diagnostics(page)).project, clipId);
  await pickFile(page, '#attach-audio', toneWav(4));
  await expect.poll(async () => clipIn((await diagnostics(page)).project, clipId).audio?.duration).toBeCloseTo(4, 2);
  const paired = clipIn((await diagnostics(page)).project, clipId);
  expect(paired.duration).toBeCloseTo(4, 2); expect(paired.videoDuration).toBeCloseTo(beforePair.duration, 2);
  const layerId = await imported.locator('..').locator('..').getAttribute('data-layer');
  await rowFor(page, layerId).locator('[data-action="solo"]').click(); await imported.click();
  await expect.poll(async () => (await diagnostics(page)).stats.audioRms, { timeout: 10000 }).toBeGreaterThan(0.01);
  const playing = (await diagnostics(page)).frames.find(frame => frame.clipId === clipId).position;
  await expect.poll(async () => (await diagnostics(page)).frames.find(frame => frame.clipId === clipId).position).not.toBe(playing);
  await page.locator('#use-audio').uncheck();
  await expect.poll(async () => (await diagnostics(page)).stats.audioRms).toBeLessThan(0.001);
  await page.locator('#use-audio').check();
  await expect.poll(async () => (await diagnostics(page)).stats.audioRms).toBeGreaterThan(0.01);
  await pickFile(page, '#choose-mask', await maskPNG(page)); await expect(page.locator('#mask-enabled')).toBeChecked();
  await page.locator('[data-browser="effects"]').click(); await page.locator('[data-add-effect="invert"]').click();
  await page.locator('#copy-clip').click(); await slotFor(page, layerId, 6).click(); await page.locator('#paste-clip').click();
  const after = await diagnostics(page), original = clipIn(after.project, clipId);
  const duplicate = after.project.layers.find(layer => layer.id === layerId).clips[after.project.selectedDeckId][6];
  expect(duplicate.id).not.toBe(original.id); expect(duplicate.audio.id).not.toBe(original.audio.id);
  expect(duplicate.mask.id).not.toBe(original.mask.id); expect(duplicate.effects[0].id).not.toBe(original.effects[0].id);
  expect(duplicate.duration).toBeCloseTo(4, 2);
  await slotFor(page, layerId, 6).click(); await expect(slotFor(page, layerId, 6)).toHaveClass(/playing/);
  await expect.poll(async () => (await diagnostics(page)).stats.audioRms).toBeGreaterThan(0.01);
  expect(errors).toEqual([]); await expect(page.locator('.toast.error')).toHaveCount(0);
});

test('source masks render, invert, bypass and retain their settings through save and open', async ({ page }) => {
  await page.goto('/');
  const initial = await diagnostics(page), layer = initial.project.layers[0], clipId = layer.clips[initial.project.selectedDeckId][1].id;
  await rowFor(page, layer.id).locator('[data-action="solo"]').click(); await slotFor(page, layer.id, 1).click();
  await pickFile(page, '#choose-mask', await maskPNG(page)); await expect(page.locator('#mask-enabled')).toBeChecked();
  await expect.poll(async () => (await outputSamples(page))[0]).toBeGreaterThan(300);
  await expect.poll(async () => (await outputSamples(page))[1]).toBeLessThan(5);
  await page.locator('#mask-invert').check();
  await expect.poll(async () => (await outputSamples(page))[0]).toBeLessThan(5);
  await expect.poll(async () => (await outputSamples(page))[1]).toBeGreaterThan(300);
  await page.locator('#mask-enabled').uncheck();
  await expect.poll(async () => Math.min(...await outputSamples(page))).toBeGreaterThan(300);
  await page.locator('#render-order').selectOption('transform,mask,effects');
  const saved = await saveProject(page), savedClip = clipIn(saved, clipId);
  expect(savedClip.mask.enabled).toBe(false); expect(savedClip.mask.invert).toBe(true);
  expect(savedClip.renderOrder).toEqual(['transform', 'mask', 'effects']);
  await pickFile(page, '#open-project', { name: 'mask-roundtrip.prism.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(saved)) });
  await expect(page.locator('#save-state')).toHaveText('LOADED');
  await slotFor(page, layer.id, 1).click({ button: 'right' });
  await expect(page.locator('#mask-enabled')).not.toBeChecked(); await expect(page.locator('#mask-invert')).toBeChecked();
  await expect(page.locator('#render-order')).toHaveValue('transform,mask,effects');
  expect(clipIn((await diagnostics(page)).project, clipId).mask.id).toBe(savedClip.mask.id);
});
