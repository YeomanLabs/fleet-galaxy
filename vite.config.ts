import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Relative base so the build works on GitHub Pages under /fleet-galaxy/ and
// from file:// inside the desktop app. Two pages: the landing/download page
// at the root, and the app itself at demo/.
export default defineConfig({
  base: './',
  server: { port: 5175 },
  preview: { port: 4175 },
  build: {
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        demo: resolve(__dirname, 'demo/index.html'),
      },
    },
  },
});
