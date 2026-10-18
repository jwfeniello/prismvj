import { defineConfig } from 'vite';
// Keep hashed assets from the previous build available to a window that is
// already loading them. Clearing dist during startup caused ERR_FAILED (-2).
export default defineConfig({ base: './', build: { target: 'chrome132', sourcemap: true, emptyOutDir: false } });
