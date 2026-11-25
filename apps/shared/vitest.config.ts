import { defineConfig } from 'vitest/config'

// 上游仓库用 pnpm + 根级 workspace 配置驱动 vitest；
// 这里独立检出没有那层，补一份最小配置让 `vitest run` 与 CI 同义。
export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
  },
})
