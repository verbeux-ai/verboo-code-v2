import { expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ProductAnalyticsSubject } from '@deepseek-ai/dsh-host-verboo-analytics/types'
import { createConnectionAnalytics } from '../src/client/connection-analytics.ts'
import type { FeatureConsent } from '../src/client/feature-consent.ts'

const consent: FeatureConsent = {
  subjectId: brandString<ProductAnalyticsSubject>('a'.repeat(64)), revision: 1, proof: `v1.2.${'b'.repeat(64)}`,
}

it('reports only recovered disconnections after an established connection', () => {
  const report = vi.fn()
  const observe = createConnectionAnalytics(() => consent, report)
  observe('disconnected')
  observe('connecting')
  observe('connected') // Initial connection is not an outage recovery.
  observe('connecting') // A reconnect attempt alone is not a disconnected state.
  observe('connected')
  expect(report).not.toHaveBeenCalled()
  observe('connecting')
  observe('disconnected')
  observe('connecting')
  observe('disconnected')
  observe('connected')
  expect(report).toHaveBeenCalledExactlyOnceWith(consent)
})

it('does not measure a disconnection retroactively after authorization appears', () => {
  let granted = false
  const report = vi.fn()
  const observe = createConnectionAnalytics(() => granted ? consent : undefined, report)
  observe('connected')
  observe('disconnected')
  granted = true
  observe('connecting')
  observe('disconnected')
  observe('connected')
  expect(report).not.toHaveBeenCalled()
  observe('disconnected')
  observe('connected')
  expect(report).toHaveBeenCalledExactlyOnceWith(consent)
})
