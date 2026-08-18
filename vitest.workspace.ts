import { defineWorkspace, configDefaults } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineWorkspace([
  {
    test: {
      name: 'pdf-core',
      root: './packages/pdf-core',
      environment: 'node',
      testTimeout: 30_000,
    },
  },
  {
    test: {
      name: 'transform',
      root: './packages/transform',
      environment: 'node',
    },
  },
  {
    plugins: [vue()],
    resolve: {
      alias: { '@': new URL('./apps/web/src/', import.meta.url).pathname },
    },
    test: {
      name: 'web',
      root: './apps/web',
      environment: 'jsdom',
      globals: true,
      // jsdom's Blob/File lacks arrayBuffer() — see test/setup.ts.
      setupFiles: ['./test/setup.ts'],
      // Explicit exclude overrides Vitest's defaults entirely, so merge
      // rather than replace — otherwise node_modules gets scanned too.
      exclude: [...configDefaults.exclude, 'test/workers/**'],
    },
  },
  {
    test: {
      name: 'web-node',
      root: './apps/web',
      environment: 'node',
      include: ['test/workers/**/*.test.ts'],
      testTimeout: 30_000,
    },
  },
])
