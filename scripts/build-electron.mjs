// Bundles the Electron main process and preload into dist-electron/.
// The page itself is built by Vite into dist/.

import { build } from 'esbuild';

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  external: ['electron'],
  sourcemap: 'linked',
  logLevel: 'warning',
};

await build({ ...common, entryPoints: ['desktop/main.ts'], outfile: 'dist-electron/main.cjs' });
await build({ ...common, entryPoints: ['desktop/preload.ts'], outfile: 'dist-electron/preload.cjs' });
console.log('built dist-electron/');
