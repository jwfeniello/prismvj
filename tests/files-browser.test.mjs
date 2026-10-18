import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

let server, browser, baseURL;
before(async () => {
  const files = new Map(await Promise.all(['files-browser.js', 'style.css', 'workspace.css'].map(async name => [name, await readFile(new URL(`../src/${name}`, import.meta.url))])));
  server = createServer((request, response) => {
    const name = request.url.slice(1);
    response.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : name.endsWith('.js') ? 'text/javascript' : 'text/html');
    response.end(files.get(name) || '<link rel="stylesheet" href="/style.css"><div id="browser" class="browser-content"></div>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
});
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); });

test('failed thumbnails stop retrying and late folder/preview replies cannot resurrect a detached browser', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(baseURL);
    const result = await page.evaluate(async () => {
      const { FilesBrowser } = await import('/files-browser.js');
      let imports = 0, previews = 0, releaseFolder, releaseImport;
      const errors = [], container = document.querySelector('#browser');
      const entries = [{ name: 'broken.png', path: 'C:/broken.png', kind: 'image' }];
      const desktop = {
        browseRoots: async () => entries,
        browseDirectory: async () => new Promise(resolve => { releaseFolder = resolve; }),
        importPaths: async paths => { imports++; return paths.map(path => ({ path, error: 'missing file' })); },
      };
      const files = new FilesBrowser({ desktop, onImport: () => {}, onPreview: () => previews++, onRelink: () => {}, onError: error => errors.push(error) });
      files.thumbnails = true; files.render(container);
      await new Promise(resolve => setTimeout(resolve, 80));
      for (let i = 0; i < 5; i++) files.paint();
      await new Promise(resolve => setTimeout(resolve, 30));
      const failures = { imports, count: files.thumbnailFailures.size };
      files.thumbnailFailures.clear();
      desktop.importPaths = async () => { imports++; return new Promise(resolve => { releaseImport = resolve; }); };
      files.paint(); files.paint(); files.paint();
      const concurrentImports = imports;
      files.detach(); container.innerHTML = '<p>Sources tab</p>';
      releaseImport([{ path: entries[0].path, url: '/image.png' }]);
      await new Promise(resolve => setTimeout(resolve, 30));
      const afterThumbnail = container.textContent;
      files.render(container); files.navigate('C:/pending');
      files.detach(); container.innerHTML = '<p>Effects tab</p>';
      releaseFolder({ path: 'C:/pending', parent: null, entries: [] });
      await new Promise(resolve => setTimeout(resolve, 30));
      const afterFolder = container.textContent;
      files.render(container);
      files.preview(entries[0]); files.detach(); container.innerHTML = '<p>Controls tab</p>';
      releaseImport([{ path: entries[0].path, url: '/image.png' }]);
      await new Promise(resolve => setTimeout(resolve, 30));
      return { failures, concurrentImports, afterThumbnail, afterFolder, afterPreview: container.textContent, previews, loading: files.loading, errors };
    });
    assert.deepEqual(result.failures, { imports: 1, count: 1 });
    assert.equal(result.concurrentImports, 2);
    assert.equal(result.afterThumbnail, 'Sources tab');
    assert.equal(result.afterFolder, 'Effects tab');
    assert.equal(result.afterPreview, 'Controls tab');
    assert.equal(result.previews, 0);
    assert.equal(result.loading, false);
    assert.deepEqual(result.errors, []);
  } finally { await page.close(); }
});

test('16 columns scroll with aligned headers and files remain usable at 1360 by 900', async () => {
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  try {
    await page.goto(baseURL);
    const result = await page.evaluate(async () => {
      document.documentElement.style.setProperty('--columns', 16);
      const columns = Array.from({ length: 16 }, (_, i) => `<button>Column ${i+1}</button>`).join('');
      const clips = Array.from({ length: 16 }, (_, i) => `<button class="clip-slot">Clip ${i+1}</button>`).join('');
      document.body.innerHTML = `<div id="app"><header class="topbar"></header><section class="workspace"><div class="layer-label">Layers</div><div id="column-viewport"><div class="column-heads">${columns}</div></div><div class="layer-bank">${Array.from({length:4},()=>`<div class="layer-row"><div class="layer-head">Layer</div><div class="clips">${clips}</div></div>`).join('')}</div></section><nav class="deckbar"></nav><div class="layout-splitter horizontal"></div><div class="toolbar"></div><main class="bottom"><section class="monitor-panel"></section><div class="layout-splitter vertical"></div><section class="inspector-panel"><div class="inspector-content"><div class="section"><div class="field"><label>Rotation</label><input type="range"><input class="number-value" type="number" value="-180.00"></div></div></div></section><div class="layout-splitter vertical"></div><section class="inspector-panel"></section><div class="layout-splitter vertical"></div><section class="browser-panel"><div class="browser-tabs">Files</div><div id="browser" class="browser-content"></div></section></main><footer class="statusbar"></footer></div>`;
      const { FilesBrowser } = await import('/files-browser.js');
      const files = new FilesBrowser({ desktop: { browseRoots: async () => Array.from({length:30}, (_, i) => ({ name: `Long filename for performance footage ${i}.mp4`, path: `C:/media/${i}.mp4`, kind: 'video' })) }, onImport: () => {}, onPreview: () => {}, onRelink: () => {}, onError: () => {} });
      files.render(document.querySelector('#browser'));
      await new Promise(resolve => setTimeout(resolve, 30));
      const bank = document.querySelector('.layer-bank'), header = document.querySelector('#column-viewport');
      bank.scrollLeft = 350; header.scrollLeft = bank.scrollLeft;
      const head = document.querySelector('.column-heads button:nth-child(5)').getBoundingClientRect();
      const clip = document.querySelector('.clips button:nth-child(5)').getBoundingClientRect();
      const list = document.querySelector('.file-entries'), number = document.querySelector('.number-value');
      return { horizontal: bank.scrollWidth > bank.clientWidth, aligned: Math.abs(head.x-clip.x), layerLeft: document.querySelector('.layer-head').getBoundingClientRect().x, listHeight: list.clientHeight, scrolling: list.scrollHeight > list.clientHeight, noOverflow: document.documentElement.scrollWidth === 1360, numberWidth: number.clientWidth };
    });
    assert.equal(result.horizontal, true);
    assert.ok(result.aligned < 1, JSON.stringify(result));
    assert.equal(result.layerLeft, 0);
    assert.ok(result.listHeight > 120, JSON.stringify(result));
    assert.equal(result.scrolling, true);
    assert.equal(result.noOverflow, true);
    assert.ok(result.numberWidth >= 60);
  } finally { await page.close(); }
});
