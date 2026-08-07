import { defineConfig } from 'vite';
import { alias } from './vite.shared';

export default defineConfig({
  resolve: { alias },
  build: {
    rollupOptions: {
      external: ['electron', /^node:/],
      // Preload runs in a sandboxed context: it must be CommonJS.
      output: { format: 'cjs', entryFileNames: 'preload.js' },
    },
  },
});
