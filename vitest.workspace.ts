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
      name: 'shared',
      root: './packages/shared',
      environment: 'node',
    },
  },
  {
    test: {
      name: 'api',
      root: './apps/api',
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
      // 'e2e/**' excludes Playwright specs (Task 15a) — configDefaults
      // doesn't cover it, and Playwright's own `*.spec.ts` naming matches
      // Vitest's default include glob, so without this Vitest would try to
      // collect and run Playwright tests as unit tests.
      exclude: [...configDefaults.exclude, 'test/workers/**', 'e2e/**'],
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
