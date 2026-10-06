import { defineConfig } from 'vite';

// Relative base so the build works on GitHub Pages under /fleet-galaxy/.
export default defineConfig({
  base: './',
  server: { port: 5175 },
  preview: { port: 4175 },
  build: { chunkSizeWarningLimit: 900 },
});
