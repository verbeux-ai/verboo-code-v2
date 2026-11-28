import { expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ProductAnalyticsSubject } from '@deepseek-ai/dsh-host-verboo-analytics/types'
import { createUpdateAnalytics } from '../src/client/update-analytics.ts'
import type { FeatureConsent } from '../src/client/feature-consent.ts'

const consent: FeatureConsent = {
  subjectId: brandString<ProductAnalyticsSubject>('a'.repeat(64)), revision: 1, proof: `v1.2.${'b'.repeat(64)}`,
}

it('records phase transitions once and does not infer a successful installation', () => {
  const report = vi.fn()
  const observe = createUpdateAnalytics(() => consent, report)
  observe({ phase: 'ready', percent: 100 }) // A restored snapshot is not a completed download.
  observe({ phase: 'downloading', percent: 0 })
  observe({ phase: 'downloading', percent: 50 })
  observe({ phase: 'ready', percent: 100 })
  observe({ phase: 'installing', percent: null })
  observe({ phase: 'error', percent: null })
  observe({ phase: 'error', percent: null })
  expect(report.mock.calls).toEqual([
    ['desktop_update_download', 'started', consent],
    ['desktop_update_download', 'completed', consent],
    ['desktop_update_install', 'started', consent],
    ['desktop_update_install', 'failed', consent],
  ])
})

it('does not retroactively measure an update that began without a grant', () => {
  let allowed = false
  const report = vi.fn()
  const observe = createUpdateAnalytics(() => allowed ? consent : undefined, report)
  observe({ phase: 'downloading', percent: 0 })
  allowed = true
  observe({ phase: 'error', percent: null })
  expect(report).not.toHaveBeenCalled()
  observe({ phase: 'downloading', percent: 0 })
  observe({ phase: 'error', percent: null })
  expect(report.mock.calls).toEqual([
    ['desktop_update_download', 'started', consent],
    ['desktop_update_download', 'failed', consent],
  ])
})

it('labels an otherwise unattributed updater error without forwarding error text', () => {
  const report = vi.fn()
  const observe = createUpdateAnalytics(() => consent, report)
  observe({ phase: 'error', percent: null })
  expect(report).toHaveBeenCalledExactlyOnceWith('desktop_update_error', 'failed', consent)
})
