import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// Vite is used in middleware mode by server/index.ts in dev and `vite build` for production.
// Two entry pages: laptop director (index.html) and phone camera (phone.html).
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  appType: 'mpa',
  resolve: { alias: { '@shared': fileURLToPath(new URL('../shared', import.meta.url)) } },
  build: {
    outDir: fileURLToPath(new URL('../dist', import.meta.url)),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL('./index.html', import.meta.url)),
        phone: fileURLToPath(new URL('./phone.html', import.meta.url)),
      },
    },
  },
  server: { middlewareMode: true },
  // e2e runs its own server next to a developer's `pnpm dev`; separate pre-bundle caches keep
  // one from invalidating the other's (which full-reloads open pages mid-test)
  cacheDir: process.env.VITE_CACHE_DIR || undefined,
  // Every browser dependency, so a cold start never discovers one late and full-reloads the page.
  optimizeDeps: {
    include: ['three', 'three/addons/loaders/GLTFLoader.js', '@sparkjsdev/spark', 'qrcode', 'zod'],
  },
});
