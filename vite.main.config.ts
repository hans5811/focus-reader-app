import { defineConfig } from 'vite';
import { alias } from './vite.shared';

// The main process bundles the shared reading engine and its pure-ESM Markdown
// dependencies. Only Electron itself and Node builtins stay external.
export default defineConfig({
  resolve: {
    alias,
    // Prefer real ESM entry points so mdast-util-* bundle cleanly.
    conditions: ['node', 'import', 'module', 'default'],
    mainFields: ['module', 'jsnext:main', 'jsnext'],
  },
  build: {
    rollupOptions: {
      external: ['electron', /^node:/],
      // Both entries are named index.ts, so the output name must be explicit
      // or the main and preload bundles overwrite each other.
      output: { entryFileNames: 'main.js' },
    },
  },
});
