import { brandString } from '@deepseek-ai/dsh-brand'
import type { ProductAnalyticsStatus, ProductAnalyticsSubject } from '@deepseek-ai/dsh-host-verboo-analytics/types'
import { expect, it } from 'vitest'
import { captureFeatureConsent } from '../src/client/feature-consent.ts'

it('captures only a current grant and preserves its original subject and revision', () => {
  const now = Date.parse('2026-11-17T12:00:00Z')
  const status: ProductAnalyticsStatus = {
    consent: { subjectId: brandString<ProductAnalyticsSubject>('a'.repeat(64)), decision: 'granted', revision: 1,
      policyVersion: 1, decidedAt: '2026-11-17T11:00:00Z', expiresAt: '2026-11-17T13:00:00Z', enabled: true },
    pending: 0, lost: 0, failure: 'none',
  }
  expect(captureFeatureConsent(null, now)).toBeUndefined()
  expect(captureFeatureConsent({ ...status, consent: null }, now)).toBeUndefined()
  expect(captureFeatureConsent({ ...status, consent: { ...status.consent!, decision: 'denied' } }, now)).toBeUndefined()
  expect(captureFeatureConsent({ ...status, consent: { ...status.consent!, enabled: false } }, now)).toBeUndefined()
  expect(captureFeatureConsent({ ...status, consent: { ...status.consent!, decidedAt: '2026-11-17T12:01:00Z' } }, now)).toBeUndefined()
  expect(captureFeatureConsent({ ...status, consent: { ...status.consent!, decidedAt: 'invalid' } }, now)).toBeUndefined()
  expect(captureFeatureConsent({ ...status, consent: { ...status.consent!, expiresAt: 'invalid' } }, now)).toBeUndefined()
  expect(captureFeatureConsent(status, Date.parse('2026-11-17T13:00:00Z'))).toBeUndefined()
  const captured = captureFeatureConsent(status, now)
  status.consent!.revision = 3
  expect(captured).toEqual({ subjectId: status.consent!.subjectId, revision: 1 })
})
