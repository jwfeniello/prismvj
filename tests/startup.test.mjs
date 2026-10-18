import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import electronBinary from 'electron';
import startup from '../electron/startup.cjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const { isAutomatedLaunch, validateBuiltPage } = startup;

test('test and debugging launches are hidden without depending on one environment flag', () => {
  assert.equal(isAutomatedLaunch({ env: {}, argv: ['electron', '.'] }), false);
  assert.equal(isAutomatedLaunch({ env: { PRISM_HEADLESS: '0', CI: 'false' }, argv: [] }), false);
  for (const env of [{ PRISM_HEADLESS: '1' }, { PRISM_TEST_DATA: 'isolated-profile' }, { NODE_TEST_CONTEXT: 'child-v8' }, { CI: '1' }]) {
    assert.equal(isAutomatedLaunch({ env, argv: [] }), true, JSON.stringify(env));
  }
  for (const flag of ['--inspect=0', '--inspect-brk=9230', '--remote-debugging-port=0', '--remote-debugging-pipe', '--headless']) {
    assert.equal(isAutomatedLaunch({ env: {}, argv: ['electron', flag, '.'] }), true, flag);
  }
  assert.equal(isAutomatedLaunch({ env: {}, argv: [], hasSwitch: name => name === 'remote-debugging-port' }), true);
});

test('build preflight identifies missing pages and incomplete assets in a disposable folder', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-startup-preflight-'));
  try {
    await assert.rejects(validateBuiltPage(temporary), /build is missing or incomplete/);
    await writeFile(path.join(temporary, 'index.html'), '<script type="module" src="./assets/app.js"></script>');
    await assert.rejects(validateBuiltPage(temporary), /build is incomplete/);
    await mkdir(path.join(temporary, 'assets'));
    await writeFile(path.join(temporary, 'assets', 'app.js'), 'document.body.textContent = "Ready";');
    assert.equal(await validateBuiltPage(temporary), path.join(temporary, 'index.html'));
    await writeFile(path.join(temporary, 'index.html'), '<script src="../escape.js"></script>');
    await assert.rejects(validateBuiltPage(temporary), /invalid asset path/);
  } finally {
    const resolved = path.resolve(temporary);
    assert.ok(path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('prism-startup-preflight-'));
    await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

function runFixture(folder, profile) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PRISM_FIXTURE_PROFILE: profile };
    for (const key of ['PRISM_HEADLESS', 'PRISM_TEST_DATA', 'PRISM_DEV_URL', 'ELECTRON_RUN_AS_NODE', 'NODE_TEST_CONTEXT', 'CI']) delete env[key];
    const child = spawn(electronBinary, [folder, '--remote-debugging-port=0'], { cwd: folder, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Startup fixture did not exit within 20 seconds.')); }, 20000);
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-65536); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-65536); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}

test('Electron startup failure stays silent and debugger-launched windows never show', { timeout: 60000 }, async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-startup-native-'));
  const profile = path.join(temporary, 'profile');
  const lifecycle = path.join(temporary, 'lifecycle.log');
  try {
    await mkdir(profile);
    await writeFile(path.join(temporary, 'package.json'), JSON.stringify({ name: 'prism-startup-fixture', main: 'bootstrap.cjs' }));
    // Use the real application main module with a disposable app root. Instrument
    // every route to a native popup before startup can reach Electron's ready event.
    await writeFile(path.join(temporary, 'bootstrap.cjs'), `
      const fs = require('node:fs');
      const electron = require('electron');
      const record = value => fs.appendFileSync(${JSON.stringify(lifecycle)}, value + '\\n');
      electron.app.setPath('userData', process.env.PRISM_FIXTURE_PROFILE);
      electron.app.on('browser-window-created', (_event, window) => {
        record('window-created');
        window.webContents.once('did-finish-load', () => setTimeout(() => {
          record('visible=' + window.isVisible());
          electron.app.quit();
        }, 50));
      });
      electron.BrowserWindow.prototype.show = () => { record('show-attempted'); throw new Error('Fixture prevents visible windows'); };
      electron.BrowserWindow.prototype.showInactive = () => { record('show-attempted'); throw new Error('Fixture prevents visible windows'); };
      require(${JSON.stringify(path.join(root, 'electron', 'main.cjs'))});
      for (const name of ['showErrorBox', 'showMessageBox', 'showOpenDialog', 'showSaveDialog']) {
        electron.dialog[name] = () => { record('dialog-attempted:' + name); throw new Error('Fixture prevents native dialogs'); };
      }
    `);
    await t.test('missing dist exits nonzero, logs the cause and creates no window or dialog', async () => {
      const result = await runFixture(temporary, profile);
      assert.equal(result.code, 1, JSON.stringify(result));
      assert.match(result.stderr, /Prism Live could not start:.*build is missing or incomplete/);
      assert.equal(await readFile(lifecycle, 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error)), '');
      const log = await readFile(path.join(profile, 'prism.log'), 'utf8');
      assert.match(log, /Startup failed:.*index\.html/);
    });
    await t.test('debugging flag alone hides a successfully loaded application', async () => {
      await mkdir(path.join(temporary, 'dist', 'assets'), { recursive: true });
      await writeFile(path.join(temporary, 'dist', 'index.html'), '<!doctype html><body><script src="./assets/app.js"></script></body>');
      await writeFile(path.join(temporary, 'dist', 'assets', 'app.js'), 'document.body.textContent = "Startup fixture";');
      const result = await runFixture(temporary, profile);
      assert.equal(result.code, 0, JSON.stringify(result));
      assert.equal(await readFile(lifecycle, 'utf8'), 'window-created\nvisible=false\n');
    });
  } finally {
    const resolved = path.resolve(temporary);
    assert.ok(path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('prism-startup-native-'));
    await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
