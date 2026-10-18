// Ableton Link in the real app: a separate Link peer (Ableton's library in
// another process) and PrismVJ must share tempo in both directions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from '@playwright/test';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const addon = path.join(root, 'electron', 'native', 'prism_link.node');
const electronPath = createRequire(import.meta.url)('electron');

test('Link session tempo flows between PrismVJ and another peer', { skip: !existsSync(addon), timeout: 120000 }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-link-'));
  const profile = path.join(temporary, 'profile'), peerScript = path.join(temporary, 'peer.cjs');
  await mkdir(profile, { recursive: true });
  // The peer prints its state every 100 ms and follows "tempo <bpm>" commands.
  await writeFile(peerScript, `const link = require(${JSON.stringify(addon)}); link.enable(true); link.setTempo(128);
    setInterval(() => process.stdout.write(JSON.stringify(link.state(4)) + '\\n'), 100);
    process.stdin.on('data', data => { const m = /tempo (\\S+)/.exec(String(data)); if (m) link.setTempo(Number(m[1])); });`);
  const peer = spawn(electronPath, [peerScript], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  let peerState = null;
  peer.stdout.on('data', data => { const line = String(data).trim().split('\n').at(-1); try { peerState = JSON.parse(line); } catch { /* partial line */ } });
  const env = { ...process.env, PRISM_TEST_DATA: profile, PRISM_HEADLESS: '1' };
  delete env.ELECTRON_RUN_AS_NODE; delete env.PRISM_DEV_URL;
  let application;
  try {
    application = await electron.launch({ args: [root], cwd: root, env, timeout: 30000 });
    const page = await application.firstWindow();
    await page.waitForFunction(() => window.desktop && window.prismDiagnostics);
    const cancel = page.getByRole('button', { name: 'Cancel', exact: true });
    if (await cancel.count()) await cancel.click();
    await page.locator('#link').click();
    // Joining adopts the session tempo.
    await page.waitForFunction(() => { const d = window.prismDiagnostics(); return d.link.peers >= 1 && Math.abs(d.project.bpm - 128) < 0.01; }, null, { timeout: 20000 });
    await expectPeer(() => peerState?.peers >= 1, 'peer sees PrismVJ');
    // Our tempo change reaches the peer.
    await page.locator('#bpm').fill('140'); await page.locator('#bpm').dispatchEvent('input');
    await expectPeer(() => Math.abs((peerState?.tempo || 0) - 140) < 0.01, 'peer adopts 140 BPM');
    // The peer's change reaches us.
    peer.stdin.write('tempo 96\n');
    await page.waitForFunction(() => Math.abs(window.prismDiagnostics().project.bpm - 96) < 0.01, null, { timeout: 10000 });
    // Beat phase follows the session within the bar.
    const phase = await page.evaluate(() => window.prismDiagnostics().link.beat % 4);
    const peerPhase = peerState.phase;
    const difference = Math.abs(((phase - peerPhase + 6) % 4) - 2);
    assert.ok(difference < 0.35, `beat phase ${phase} vs session ${peerPhase}`);
    assert.equal(await page.locator('#link').textContent(), 'Link 1');
  } finally {
    peer.kill();
    await application?.close().catch(() => {});
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
  async function expectPeer(check, label) {
    const started = Date.now();
    while (!check()) { if (Date.now() - started > 10000) assert.fail(label); await new Promise(resolve => setTimeout(resolve, 100)); }
  }
});
