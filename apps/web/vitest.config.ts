import { mergeConfig, defineConfig } from 'vitest/config';

import viteConfig from './vite.config.js';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      pool: 'threads',
      maxWorkers: 2,
    },
  }),
);
