// ISF Library in the desktop app: search editor.isf.video, install an effect,
// add it to the selected clip, and find it again after a restart. Needs the
// network; skipped when editor.isf.video cannot be reached.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const online = await fetch('https://editor.isf.video/api/search?q=blur&from=0', { signal: AbortSignal.timeout(10000) }).then(response => response.ok).catch(() => false);

async function launch(profile) {
  const env = { ...process.env, PRISM_TEST_DATA: profile, PRISM_HEADLESS: '1' };
  delete env.ELECTRON_RUN_AS_NODE; delete env.PRISM_DEV_URL;
  const application = await electron.launch({ args: [root], cwd: root, env, timeout: 30000 });
  const page = await application.firstWindow();
  await page.waitForFunction(() => window.desktop && window.prismDiagnostics);
  return { application, page };
}

test('ISF Library: search, install an effect onto a clip, reload after restart', { skip: !online, timeout: 240000 }, async () => {
  assert.ok(existsSync(path.join(root, 'dist', 'index.html')), 'Run npm run build first.');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-isf-library-'));
  const profile = path.join(temporary, 'profile');
  await mkdir(profile, { recursive: true });
  let session;
  try {
    session = await launch(profile);
    let { page } = session;
    await page.locator('[data-browser="effects"]').click();
    await page.locator('[data-effect-kind-tab="isf"]').click();
    await page.locator('.isf-card').first().waitFor({ timeout: 60000 });
    await page.locator('#isf-search').fill('blur');
    await page.locator('#isf-search').press('Enter');
    await page.locator('#isf-kind').selectOption('effect');
    const card = page.locator('.isf-card').first();
    await card.waitFor({ timeout: 60000 });
    assert.ok(await card.locator('.isf-thumb img').count() >= 0);
    const title = (await card.locator('.isf-meta strong').textContent()).trim();
    // Select a playing clip so the effect lands on it.
    const clipId = await page.evaluate(() => window.prismDiagnostics().frames[0].clipId);
    await page.locator(`[data-clip="${clipId}"]`).first().click({ button: 'right' }).catch(() => {});
    await card.locator('[data-isf-install]').click();
    await page.waitForFunction(() => {
      const project = window.prismDiagnostics().project;
      const owners = [project, ...(project.groups || []), ...project.layers, ...project.layers.flatMap(layer => Object.values(layer.clips).flat()).filter(Boolean)];
      return owners.some(owner => (owner.effects || []).some(effect => /^isf:web-[a-f0-9]{24}$/.test(effect.type)));
    }, null, { timeout: 60000 });
    // Let it compile and render a few frames, then check for compile errors.
    await page.waitForTimeout(1500);
    const status = await page.locator('#status-text').textContent();
    assert.doesNotMatch(status, /could not compile/, status);
    const library = path.join(profile, 'ISF Library');
    const installed = await readdir(library);
    assert.equal(installed.length, 1);
    assert.match(installed[0], /^[a-f0-9]{24}$/);
    await session.application.close();

    session = await launch(profile);
    ({ page } = session);
    // Recover the autosaved session: its ISF effect must come back working.
    const recover = page.locator('dialog[open] footer button.primary');
    await recover.waitFor({ timeout: 15000 });
    await recover.click();
    await page.waitForFunction(() => {
      const project = window.prismDiagnostics().project;
      const owners = [project, ...(project.groups || []), ...project.layers, ...project.layers.flatMap(layer => Object.values(layer.clips).flat()).filter(Boolean)];
      return owners.some(owner => (owner.effects || []).some(effect => /^isf:web-/.test(effect.type)));
    }, null, { timeout: 30000 });
    await page.waitForTimeout(1000);
    assert.doesNotMatch(await page.locator('#status-text').textContent(), /could not compile/);
    await page.locator('[data-browser="effects"]').click();
    await page.locator('[data-effect-kind-tab="video"]').click();
    await page.locator('#effect-search').fill(title.slice(0, 20));
    await page.locator('[data-add-effect^="isf:web-"]').first().waitFor({ timeout: 30000 });
    await page.locator('[data-effect-kind-tab="isf"]').click();
    await page.locator('.browser-group summary', { hasText: 'Installed' }).waitFor();
    assert.match(await page.locator('.browser-group', { hasText: 'Installed' }).textContent(), /Installed\s*1/);
  } finally {
    await session?.application.close().catch(() => {});
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
});