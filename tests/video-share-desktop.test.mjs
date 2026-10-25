// Spout and NDI® in the real app, against a peer process that uses the same
// native module: PrismVJ's 1080p composition must reach an outside receiver at
// full frame rate, and an outside sender must appear in a source clip.
// NDI runs when an NDI runtime is installed (or PRISM_NDI_LIBRARY names one).
// The editor window is shown (without focus) for these tests: a hidden window
// renders at about 1 fps, and they measure the real frame rate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from '@playwright/test';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const addon = path.join(root, 'electron', 'native', 'prism_video.node');
const require = createRequire(import.meta.url);
const electronPath = require('electron');
const built = existsSync(addon) && existsSync(path.join(root, 'dist', 'index.html'));
const ndiAvailable = built && process.platform === 'win32' && require(addon).ndiStatus().available;
const near = (a, b, tolerance) => a?.length === b.length && a.every((value, i) => Math.abs(value - b[i]) <= tolerance);

function peer(...args) {
  const child = spawn(electronPath, [path.join(root, 'tests', 'video-share-peer.cjs'), addon, ...args], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  child.lines = [];
  let partial = '';
  child.stdout.on('data', data => {
    const text = partial + data; const lines = text.split('\n'); partial = lines.pop();
    for (const line of lines) try { child.lines.push(JSON.parse(line)); } catch { /* not JSON */ }
  });
  return child;
}

async function until(check, label, timeout = 20000) {
  const started = Date.now();
  while (!check()) { if (Date.now() - started > timeout) assert.fail(label); await new Promise(resolve => setTimeout(resolve, 100)); }
}

async function close(application) {
  if (!application) return;
  const pid = application.process().pid;
  await Promise.race([application.close().catch(() => {}), new Promise(resolve => setTimeout(resolve, 15000))]);
  try { process.kill(pid); } catch { /* already gone */ }
}

async function launch(temporary) {
  const profile = path.join(temporary, 'profile');
  await mkdir(profile, { recursive: true });
  const env = { ...process.env, PRISM_TEST_DATA: profile, PRISM_HEADLESS: '1' };
  delete env.ELECTRON_RUN_AS_NODE; delete env.PRISM_DEV_URL;
  const application = await electron.launch({ args: [root], cwd: root, env, timeout: 30000 });
  const page = await application.firstWindow();
  await page.waitForFunction(() => window.desktop && window.prismDiagnostics && window.prismVideoShare?.().available);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive());
  const cancel = page.getByRole('button', { name: 'Cancel', exact: true });
  if (await cancel.count()) await cancel.click();
  await page.locator('[data-inspector="composition"]').click();
  await page.locator('#composition-size').selectOption('1920,1080');
  await page.waitForFunction(() => window.prismDiagnostics().project.width === 1920);
  return { application, page };
}

// Five seconds of receiver stats after the frame rate has settled.
async function measure(receiver) {
  await until(() => receiver.lines.filter(line => line.frames > 0).length >= 3, 'the receiver gets frames');
  const from = receiver.lines.length;
  await until(() => receiver.lines.length >= from + 5, 'five seconds of stats', 10000);
  const window = receiver.lines.slice(from, from + 5);
  return { fps: window.reduce((sum, line) => sum + line.fps, 0) / window.length, last: window.at(-1), ageMs: window.reduce((sum, line) => sum + (line.ageMs || 0), 0) / window.length };
}

async function shareOutputTest(t, kind) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), `prism-${kind}-`));
  let application, receiver;
  try {
    ({ application } = await launch(temporary));
    const page = await application.firstWindow();
    await page.locator('#output').click();
    await page.locator(kind === 'spout' ? '#share-spout' : '#share-ndi').check();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.waitForFunction(kind => window.prismVideoShare().outputs.some(output => output.target === 'composition' && output.kind === kind && output.frames > 30), kind);
    receiver = peer('receive', kind, 'PrismVJ');
    const result = await measure(receiver);
    // Pause the (animated) composition so the receiver's frame and a probe agree.
    await page.locator('body').press('Space');
    const paused = receiver.lines.length;
    await until(() => receiver.lines.length >= paused + 2, 'stats after pausing', 10000);
    const stats = await page.evaluate(() => window.prismVideoShare().outputs[0]);
    // CPU time over three seconds, per process type, as % of one core.
    const cpuTimes = () => application.evaluate(({ app }) => app.getAppMetrics().map(item => ({ pid: item.pid, type: item.type, seconds: item.cpu.cumulativeCPUUsage })));
    const before = await cpuTimes();
    await new Promise(resolve => setTimeout(resolve, 3000));
    const metrics = (await cpuTimes()).map(item => ({ type: item.type, cpu: (item.seconds - (before.find(old => old.pid === item.pid)?.seconds ?? item.seconds)) / 3 * 100 }));
    const probe = await page.evaluate(() => window.prismOutputProbe());
    t.diagnostic(`${kind} output 1080p: receiver ${result.fps.toFixed(1)} fps, frame age at read ${result.ageMs.toFixed(1)} ms, readback ${stats.readbackMs.toFixed(1)} ms, native send ${stats.sendMs.toFixed(2)} ms, skipped ${stats.skipped}, sender dropped ${stats.dropped}`);
    t.diagnostic(`${kind} output CPU (% of one core): ${metrics.map(item => `${item.type} ${item.cpu.toFixed(0)}`).join(', ')}; receiver process ${result.last.cpuPercent.toFixed(0)}`);
    assert.equal(result.last.width, 1920); assert.equal(result.last.height, 1080);
    assert.ok(result.fps >= 55, `received ${result.fps} fps`);
    // Lossless for Spout; NDI compresses.
    const still = receiver.lines.at(-1);
    assert.ok(near(still.center, probe.composition, kind === 'spout' ? 2 : 12), `received centre ${still.center} vs composition ${probe.composition}`);
    // A size whose rows are not 256-byte aligned (WebGPU pads buffer rows) reaches the receiver intact.
    await page.locator('#composition-width').fill('1000');
    await page.locator('#composition-height').fill('600');
    await page.locator('#apply-composition-size').click();
    await until(() => receiver.lines.at(-1)?.width === 1000 && receiver.lines.at(-1)?.height === 600, 'the receiver follows a resize to 1000×600');
    const resized = receiver.lines.length;
    await until(() => receiver.lines.length >= resized + 2, 'stats after resizing', 10000);
    const small = await page.evaluate(() => window.prismOutputProbe());
    assert.ok(near(receiver.lines.at(-1).center, small.composition, kind === 'spout' ? 2 : 12), `resized centre ${receiver.lines.at(-1).center} vs composition ${small.composition}`);
  } finally {
    receiver?.kill();
    await close(application);
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
}

async function shareInputTest(t, kind) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), `prism-${kind}-in-`));
  const name = `PrismVJ test ${process.pid}`;
  let application, sender;
  try {
    sender = peer('send', kind, name, '1920', '1080');
    await until(() => sender.lines.some(line => line.ready), 'the peer sender starts');
    ({ application } = await launch(temporary));
    const page = await application.firstWindow();
    // The Sources browser lists the peer once discovery has seen it.
    const item = page.locator(`.browser-item[data-source="${kind}"]`, { hasText: name });
    await page.locator('#refresh-devices').click();
    await item.first().waitFor({ timeout: 20000 });
    // Only the new clip plays: stop the demo layers, add it and trigger it.
    await page.locator('#clear-all').click();
    await item.first().click();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.prismVideoShare().inputs.some(input => input.uploaded > 0));
    const probe = async () => (await page.evaluate(() => window.prismOutputProbe())).composition;
    let center = await probe();
    const tolerance = kind === 'spout' ? 2 : 12;
    for (let i = 0; i < 50 && !near(center, [200, 40, 90, 255], tolerance); i++) { await page.waitForTimeout(100); center = await probe(); }
    assert.ok(near(center, [200, 40, 90, 255], tolerance), `composition centre ${center}`);
    sender.stdin.write('color 20 180 60\n');
    for (let i = 0; i < 50 && !near(center, [20, 180, 60, 255], tolerance); i++) { await page.waitForTimeout(100); center = await probe(); }
    assert.ok(near(center, [20, 180, 60, 255], tolerance), `composition centre after colour change ${center}`);
    const first = await page.evaluate(() => window.prismVideoShare().inputs[0]);
    await page.waitForTimeout(5000);
    const second = await page.evaluate(() => window.prismVideoShare().inputs[0]);
    const fps = (second.sequence - first.sequence) / 5;
    t.diagnostic(`${kind} input 1080p: ${fps.toFixed(1)} frames/s reached the page, ${second.width}×${second.height}, native receive ${second.info.receiveMs.toFixed(2)} ms/frame`);
    assert.equal(second.width, 1920);
    assert.ok(fps >= 55, `input ${fps} fps`);
  } finally {
    sender?.kill();
    await close(application);
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
}

test('Spout output sends the 1080p composition at 60 fps', { skip: !built || process.platform !== 'win32', timeout: 120000 }, t => shareOutputTest(t, 'spout'));
test('a Spout sender plays in a source clip', { skip: !built || process.platform !== 'win32', timeout: 120000 }, t => shareInputTest(t, 'spout'));
test('NDI® output sends the 1080p composition at 60 fps', { skip: !ndiAvailable && 'NDI runtime not installed', timeout: 120000 }, t => shareOutputTest(t, 'ndi'));
test('an NDI® source plays in a source clip', { skip: !ndiAvailable && 'NDI runtime not installed', timeout: 120000 }, t => shareInputTest(t, 'ndi'));
