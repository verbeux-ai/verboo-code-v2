import type { ProductAnalyticsStatus, ProductAnalyticsSubject } from '@deepseek-ai/dsh-host-verboo-analytics/types'

/** Consent evidence captured at the start of an explicit feature action. */
export interface FeatureConsent {
  subjectId: ProductAnalyticsSubject
  revision: number
}

/**
 * A later grant cannot retroactively authorize an earlier action.
 * @param status - last locally observed product preference.
 * @param now - action start time in milliseconds.
 * @returns the subject and revision of a current grant, or undefined.
 */
export function captureFeatureConsent(status: ProductAnalyticsStatus | null, now = Date.now()): FeatureConsent | undefined {
  const consent = status?.consent
  const expiresAt = Date.parse(consent?.expiresAt ?? '')
  const decidedAt = Date.parse(consent?.decidedAt ?? '')
  if (!consent?.enabled || consent.decision !== 'granted' || !Number.isFinite(decidedAt) || decidedAt > now
    || !Number.isFinite(expiresAt) || expiresAt <= now) return undefined
  return { subjectId: consent.subjectId, revision: consent.revision }
}
