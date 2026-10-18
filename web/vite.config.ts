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
  optimizeDeps: { include: ['three', '@sparkjsdev/spark'] },
});
