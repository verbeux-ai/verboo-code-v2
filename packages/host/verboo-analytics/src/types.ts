import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque server-issued identity for a product consent scope. */
export type ProductAnalyticsSubject = Branded<'ProductAnalyticsSubject'>

/** Explicit product measurement; these values never contain editor content. */
export type ProductDecision = 'unknown' | 'granted' | 'denied'

/** Preference confirmed by the collector for the current identity. */
export interface ProductConsent {
  subjectId: ProductAnalyticsSubject
  decision: ProductDecision
  revision: number
  policyVersion: 1
  decidedAt: string
  expiresAt: string
  enabled: boolean
  /** Signed order reference returned before a product action. */
  referenceProof?: string | undefined
}

/** Safe preference and delivery state available to local product UI. */
export interface ProductAnalyticsStatus {
  consent: ProductConsent | null
  pending: number
  lost: number
  failure: 'none' | 'unavailable' | 'storage' | 'rejected'
}

/** Surfaces assigned by the application composition, never inferred from a UA. */
export type ProductSurface = 'desktop' | 'cli' | 'dashboard'

/** Fixed feature dimensions; tool names, arguments and URLs are excluded. */
export type ProductFeature = 'conversation' | 'model_switch' | 'tool' | 'browser' | 'mcp' | 'plan' | 'goal' | 'checkout'

/** Safe result for preference changes; no upstream messages cross Remote. */
export type ProductConsentResult = { ok: true; status: ProductAnalyticsStatus } | { ok: false; code: 'unavailable' | 'storage' | 'account_changed' }
