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
export type ProductFeature = 'conversation' | 'model_switch' | 'tool' | 'browser' | 'mcp' | 'plan' | 'goal' | 'checkout' | 'pane_split_right' | 'pane_split_down' | 'stop_button' | 'project_add'
  | 'message_enter' | 'message_button' | 'message_queue_enter' | 'message_queue_button' | 'message_steer_enter' | 'message_steer_button'
  | 'preference_busy_queue' | 'preference_busy_steer' | 'model_choice' | 'queue_steer_button'
  | 'preference_coding_tools_on' | 'preference_coding_tools_off'
  | 'preference_preset_cordis' | 'preference_preset_ptc' | 'preference_preset_minimal' | 'preference_preset_standard' | 'preference_preset_other'
  | 'preference_theme_light' | 'preference_theme_dark' | 'preference_theme_system' | 'preference_minimalist_on' | 'preference_minimalist_off'
  | 'preference_language_en' | 'preference_language_pt' | 'preference_language_zh' | 'preference_language_ja'
  | 'preference_language_es' | 'preference_language_fr' | 'preference_language_de' | 'preference_language_ru' | 'preference_language_other'
  | 'desktop_update_download' | 'desktop_update_install' | 'desktop_update_error'
  | 'desktop_response_error' | 'desktop_connection_recovered'
  | 'terminal_open' | 'files_open' | 'document_open'
  | 'attachment_image' | 'attachment_file' | 'attachment_folder' | 'attachment_upload_image' | 'attachment_upload_file'
  | 'attachment_retry_image' | 'attachment_retry_file'
  | 'schedule_create' | 'schedule_edit' | 'schedule_pause' | 'schedule_resume' | 'schedule_delete' | 'schedule_run'
  | 'schedule_after' | 'schedule_at' | 'schedule_every' | 'schedule_daily' | 'schedule_weekly' | 'schedule_cron' | 'schedule_rrule'
  | 'conversation_new' | 'conversation_open' | 'conversation_search' | 'command_submit' | 'integration_connect' | 'mcp_connect' | 'mcp_configure' | 'mcp_probe'

/** Bounded model dimensions from first-party or official account catalogs. */
export interface ProductModelDetails {
  provider: 'verboo' | 'openai' | 'deepseek' | 'other'
  model: string
  effort: 'default' | 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' | 'other'
}

/** Safe result for preference changes; no upstream messages cross Remote. */
export type ProductConsentResult = { ok: true; status: ProductAnalyticsStatus } | { ok: false; code: 'unavailable' | 'storage' | 'account_changed' }
