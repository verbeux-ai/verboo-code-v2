import { fileURLToPath } from 'node:url'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin } from '../../../vitest.shared.ts'

const root = fileURLToPath(new URL('../../../', import.meta.url))

/** Explicit runner for this package's opt-in local performance diagnostics. */
export default defineConfig({
  root,
  plugins: [tsconfigPaths({ projects: [`${root}/tsconfig.base.json`] }), standardDecoratorPlugin()],
  test: {
    name: 'ui-trajectory-performance-diagnostic',
    pool: 'forks',
    execArgv: ['--expose-gc'],
    setupFiles: ['./scripts/test-proxy-environment.ts', './scripts/test-dom-environment.ts'],
    include: ['packages/client/ui-trajectory/tests/**/*.perf.{ts,tsx}'],
    disableConsoleIntercept: true,
    testTimeout: 120_000,
  },
})
