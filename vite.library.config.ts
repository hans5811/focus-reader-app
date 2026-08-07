import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { alias, projectRoot } from './vite.shared';

export default defineConfig({
  root: path.join(projectRoot, 'src/renderer/library'),
  plugins: [react()],
  resolve: { alias },
  build: {
    // `outDir` resolves against `root`, so it must be absolute here or the
    // bundle lands inside the source tree and never reaches the package.
    outDir: path.join(projectRoot, '.vite/renderer/library'),
    emptyOutDir: true,
  },
});
