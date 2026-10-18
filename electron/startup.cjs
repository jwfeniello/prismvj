'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

function isAutomatedLaunch({ env = process.env, argv = process.argv, hasSwitch = () => false } = {}) {
  return env.PRISM_HEADLESS === '1' || Boolean(env.PRISM_TEST_DATA) || Boolean(env.NODE_TEST_CONTEXT)
    || (Boolean(env.CI) && !['0', 'false'].includes(String(env.CI).toLowerCase()))
    || ['inspect', 'inspect-brk', 'remote-debugging-port', 'remote-debugging-pipe', 'headless'].some(name => hasSwitch(name))
    || argv.some(argument => /^--(?:inspect(?:-brk)?|remote-debugging-(?:port|pipe)|headless)(?:=|$)/.test(argument));
}

async function validateBuiltPage(directory) {
  const folder = path.resolve(directory);
  const page = path.join(folder, 'index.html');
  let html;
  try {
    const stat = await fs.stat(page);
    if (!stat.isFile() || !stat.size || stat.size > 1024 * 1024) throw new Error('invalid entry page');
    html = await fs.readFile(page, 'utf8');
  } catch (error) {
    throw new Error(`PrismVJ's application build is missing or incomplete: ${page}. Finish npm run build before launching. (${error.code || error.message})`);
  }
  const references = [...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)].map(match => match[1]);
  if (!references.some(reference => /\.js(?:[?#]|$)/i.test(reference))) throw new Error(`PrismVJ's application build has no compiled JavaScript: ${page}. Run npm run build.`);
  for (const reference of references) {
    if (/^(?:data:|https?:\/\/)/i.test(reference)) continue;
    let asset;
    try { asset = path.resolve(folder, decodeURIComponent(reference.split(/[?#]/)[0])); }
    catch { throw new Error(`The application build has an invalid asset path: ${reference}`); }
    if (!asset.startsWith(folder + path.sep)) throw new Error(`The application build has an invalid asset path: ${reference}`);
    try {
      const stat = await fs.stat(asset);
      if (!stat.isFile() || !stat.size) throw new Error('empty asset');
    } catch (error) {
      throw new Error(`PrismVJ's application build is incomplete: ${asset}. Finish npm run build before launching. (${error.code || error.message})`);
    }
  }
  return page;
}

module.exports = { isAutomatedLaunch, validateBuiltPage };
