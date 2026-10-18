import { test, expect } from '@playwright/test';
import path from 'node:path';

test('live workspace plays, changes decks, edits effects, pauses, and saves', async ({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('.clip-slot.playing')).toHaveCount(3);
  await expect(page.locator('#frame-count')).not.toHaveText('0 FPS');
  const initial=await page.evaluate(()=>window.prismDiagnostics());
  expect(initial.frames).toHaveLength(3);
  await page.getByRole('button',{name:'After hours',exact:true}).click();
  const switched=await page.evaluate(()=>window.prismDiagnostics());
  expect(switched.frames.map(f=>f.clipId)).toEqual(initial.frames.map(f=>f.clipId));
  await page.locator('.clip-slot[data-clip]').first().click({button:'right'});
  await expect(page.locator('#inspector')).toContainText('Transport');
  await page.locator('[data-browser="effects"]').click();
  await page.locator('[data-add-effect="invert-rgb"]').click();
  await expect(page.locator('#inspector .effect-card')).toHaveCount(1);
  await page.locator('[data-inspector="composition"]').click();
  await page.locator('[data-add-effect="hue-rotate"]').click();
  await expect(page.locator('#inspector .effect-card')).toHaveCount(1);
  await page.locator('#pause').click();
  const paused=await page.evaluate(()=>window.prismDiagnostics().frames);
  await page.waitForTimeout(200);
  expect((await page.evaluate(()=>window.prismDiagnostics().frames)).map(f=>f.position)).toEqual(paused.map(f=>f.position));
  await page.locator('#pause').click();
  const download=page.waitForEvent('download');await page.locator('#save-project').click();
  expect((await download).suggestedFilename()).toContain('.prism.json');
  await page.screenshot({path:'test-results/workspace.png',fullPage:true});
  expect(errors).toEqual([]);
});

test('imports and plays real video, then records the composition',async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('/');
  await page.locator('[data-browser="files"]').click();
  const chooser=page.waitForEvent('filechooser');await page.locator('#import-media').click();
  await (await chooser).setFiles(path.resolve('tests/engine-fixture.webm'));
  const clip=page.locator('.clip-slot').filter({hasText:'engine-fixture.webm'});await expect(clip).toHaveCount(1);
  await clip.click();await expect(clip).toHaveClass(/playing/);
  const before=await page.evaluate(()=>window.prismDiagnostics().frames.find(f=>f.clipId===window.prismDiagnostics().project.layers.at(-1).activeClipId).position);
  await page.waitForTimeout(350);
  const after=await page.evaluate(()=>window.prismDiagnostics().frames.find(f=>f.clipId===window.prismDiagnostics().project.layers.at(-1).activeClipId).position);
  expect(after).not.toBe(before);
  await page.locator('#record').click();await expect(page.locator('#record')).toHaveClass(/active/);
  await page.waitForTimeout(1100);const download=page.waitForEvent('download');await page.locator('#record').click();
  expect((await download).suggestedFilename()).toMatch(/\.webm$/);
  await expect(page.locator('#record')).not.toHaveClass(/active/);expect(errors).toEqual([]);
});

test('autosave recovery survives reload and invalid files preserve the session',async({page})=>{
  await page.goto('/');await page.locator('#project-name').fill('Recovery fixture');
  await expect(page.locator('#save-state')).toHaveText('RECOVERY SAVED');
  await page.reload();await expect(page.locator('dialog')).toContainText('Recover your last session');
  await page.getByRole('button',{name:'Recover',exact:true}).click();await expect(page.locator('#project-name')).toHaveValue('Recovery fixture');
  const chooser=page.waitForEvent('filechooser');await page.locator('#open-project').click();
  await (await chooser).setFiles({name:'invalid.json',mimeType:'application/json',buffer:Buffer.from('{"version":999}')});
  await expect(page.locator('.toast')).toContainText('Open failed');await expect(page.locator('#project-name')).toHaveValue('Recovery fixture');
});

test('piano release stops playback and inactive cue editing cannot alter the live clip',async({page})=>{
  await page.goto('/');
  const topRow=page.locator('.layer-row').first();
  const first=topRow.locator('[data-slot="0"]');
  await first.click({button:'right'});
  await page.locator('#prop-trigger').selectOption('piano');
  await page.locator('#clear-all').click();
  const bounds=await first.boundingBox();await page.mouse.move(bounds.x+20,bounds.y+20);await page.mouse.down();
  await expect(first).toHaveClass(/playing/);await page.mouse.up();
  await expect(first).not.toHaveClass(/playing/);
  await page.locator('#prop-trigger').selectOption('restart');await first.click();
  await page.locator('#pause').click();
  const active=await page.evaluate(()=>window.prismDiagnostics().frames);
  await topRow.locator('[data-slot="1"]').click({button:'right'});
  await page.locator('[data-cue="2"]').click();
  expect(await page.evaluate(()=>window.prismDiagnostics().frames)).toEqual(active);
  await expect(page.locator('.toast')).toContainText('Trigger this clip');
});

test('undo retains imported browser media',async({page})=>{
  await page.goto('/');await page.locator('[data-browser="files"]').click();
  const chooser=page.waitForEvent('filechooser');await page.locator('#import-media').click();
  await (await chooser).setFiles(path.resolve('tests/engine-fixture.webm'));
  const clip=page.locator('.clip-slot').filter({hasText:'engine-fixture.webm'});await expect(clip).toHaveCount(1);
  await page.locator('#prop-opacity').fill('0.4');await page.locator('#prop-opacity').blur();
  await page.locator('#status-text').click();await page.keyboard.press('Control+z');
  await clip.click();await expect(clip).toHaveClass(/playing/);
  await expect(page.locator('.toast.error')).toHaveCount(0);
});
