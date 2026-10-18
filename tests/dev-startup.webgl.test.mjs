// The production bundle can hide module-ordering mistakes (for example a
// top-level const read during startup) that crash the unbundled source.
// Load the app through the Vite dev server and require a clean startup.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';

const chrome = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const options = { skip: !existsSync(chrome), timeout: 90000 };
let server, browser;

before(async () => {
  if (!existsSync(chrome)) return;
  server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), logLevel: 'silent', server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
});
after(async () => { await browser?.close(); await server?.close(); });

test('unbundled source starts without errors and renders', options, async () => {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => typeof window.prismDiagnostics === 'function' && window.prismDiagnostics().stats.frames > 2, null, { timeout: 30000 }).catch(() => {});
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => typeof window.prismDiagnostics), 'function');
  await page.close();
});
