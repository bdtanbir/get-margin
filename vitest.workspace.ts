import { defineWorkspace } from 'vitest/config'
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
    },
  },
])
