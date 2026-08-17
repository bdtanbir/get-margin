import { defineWorkspace } from 'vitest/config'

export default defineWorkspace([
  {
    test: {
      name: 'pdf-core',
      root: './packages/pdf-core',
      environment: 'node',
      testTimeout: 30_000,
    },
  },
])
