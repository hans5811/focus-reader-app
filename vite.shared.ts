import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Path aliases shared by every Vite build (main, preload, both renderers). */
export const alias = {
  '@shared': path.join(here, 'src/shared'),
  '@main': path.join(here, 'src/main'),
  '@renderer': path.join(here, 'src/renderer'),
};

export const projectRoot = here;
