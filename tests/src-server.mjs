// Serves files from ../src for browser-based tests, so modules can import
// their dependencies (e.g. ./fx/registry.js) without per-test file lists.
import { existsSync, readFileSync, statSync } from 'node:fs';

const root = new URL('../src/', import.meta.url);

export function sourceFile(url) {
  const path = String(url || '').split('?')[0];
  if (!/^\/[\w./-]+\.(js|css)$/.test(path) || path.includes('..')) return null;
  const file = new URL(path.slice(1), root);
  return existsSync(file) && statSync(file).isFile() ? { body: readFileSync(file), type: path.endsWith('.css') ? 'text/css' : 'text/javascript' } : null;
}
