import { defineConfig } from 'vitest/config';
import { alias } from './vite.shared';

export default defineConfig({
  resolve: {
    alias: {
      ...alias,
      // Modules under test only need Electron's shape, not a live runtime.
      electron: new URL('./test/stubs/electron.ts', import.meta.url).pathname,
    },
  },
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
  },
});
