// Output windows share the editor process and draw the composition canvas on
// the GPU. Verify in Electron that the window opens, mirrors the composition,
// follows blackout and closes cleanly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const near = (a, b, tolerance = 6) => a.length === b.length && a.every((value, i) => Math.abs(value - b[i]) <= tolerance);

test('same-process output windows mirror the composition and close cleanly', { timeout: 120000 }, async () => {
  assert.ok(existsSync(path.join(root, 'dist', 'index.html')), 'Run npm run build before desktop integration tests.');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-output-'));
  const profile = path.join(temporary, 'profile');
  await mkdir(profile, { recursive: true });
  const env = { ...process.env, PRISM_TEST_DATA: profile, PRISM_HEADLESS: '1' };
  delete env.ELECTRON_RUN_AS_NODE; delete env.PRISM_DEV_URL;
  let application;
  try {
    application = await electron.launch({ args: [root], cwd: root, env, timeout: 30000 });
    const page = await application.firstWindow();
    await page.waitForFunction(() => window.desktop && window.prismDiagnostics);
    const cancel = page.getByRole('button', { name: 'Cancel', exact: true });
    if (await cancel.count()) await cancel.click();
    await page.locator('#output').click();
    await page.getByRole('button', { name: 'Open output', exact: true }).click();
    await page.waitForFunction(() => window.prismDiagnostics().outputs.length === 1);
    const windows = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({ title: window.getTitle(), visible: window.isVisible() })));
    assert.equal(windows.length, 2);
    assert.ok(windows.every(window => !window.visible), 'hidden test mode keeps output windows hidden');
    const live = await page.evaluate(() => window.prismOutputProbe());
    assert.equal(live.outputs.length, 1);
    assert.ok(near(live.outputs[0], live.composition), `output ${live.outputs[0]} vs composition ${live.composition}`);
    await page.locator('#blackout').click();
    const dark = await page.evaluate(() => window.prismOutputProbe());
    assert.ok(near(dark.outputs[0], [0, 0, 0, 255], 2), `blackout output ${dark.outputs[0]}`);
    await page.locator('#blackout').click();
    await page.locator('#output').click();
    await page.waitForFunction(() => window.prismDiagnostics().outputs.length === 0);
    await page.waitForTimeout(300);
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
    assert.equal(await page.locator('.toast.error').count(), 0);
  } finally {
    await application?.close().catch(() => {});
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
});
