import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerZIP } from '@electron-forge/maker-zip';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const BIN_DIR = path.join(__dirname, 'bin');

/**
 * Build the Go capture helper into `bin/readerctl` so it can be shipped as an
 * extra resource at `Contents/Resources/bin/readerctl` (SPEC 10.1).
 */
function buildReaderctl() {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  execFileSync('go', ['build', '-trimpath', '-o', path.join(BIN_DIR, 'readerctl'), '.'], {
    cwd: path.join(__dirname, 'readerctl'),
    stdio: 'inherit',
    env: { ...process.env, CGO_ENABLED: '0' },
  });
}

const config: ForgeConfig = {
  packagerConfig: {
    name: 'Focus Reader',
    appBundleId: 'com.focusreader.app',
    asar: true,
    // The Go helper lives outside the asar so hooks can exec it directly.
    extraResource: [BIN_DIR],
    extendInfo: {
      // Menu-bar-first: no Dock icon, no window at launch (SPEC 4.1).
      LSUIElement: true,
      CFBundleDocumentTypes: [
        {
          CFBundleTypeName: 'Markdown or plain text document',
          CFBundleTypeRole: 'Viewer',
          LSHandlerRank: 'Alternate',
          LSItemContentTypes: ['net.daringfireball.markdown', 'public.plain-text'],
        },
      ],
    },
  },
  rebuildConfig: {},
  makers: [new MakerZIP({}, ['darwin'])],
  hooks: {
    generateAssets: async () => {
      buildReaderctl();
    },
  },
  plugins: [
    new VitePlugin({
      build: [
        { entry: 'src/main/index.ts', config: 'vite.main.config.ts', target: 'main' },
        { entry: 'src/preload/index.ts', config: 'vite.preload.config.ts', target: 'preload' },
      ],
      renderer: [
        { name: 'overlay', config: 'vite.overlay.config.ts' },
        { name: 'library', config: 'vite.library.config.ts' },
      ],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
