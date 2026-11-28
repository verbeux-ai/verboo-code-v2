/** Durable product preferences and immutable queued event bytes. */
import { randomBytes, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ProductAnalyticsSubject } from './types.ts'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'

/** Stored preference response is checked before it can authorize collection. */
export const consentSchema = z.object({
  subjectId: z.string().regex(/^[a-f0-9]{64}$/).transform(value => brandString<ProductAnalyticsSubject>(value)),
  decision: z.enum(['unknown', 'granted', 'denied']), revision: z.number().int().nonnegative(), policyVersion: z.literal(1),
  decisionOrder: z.string().regex(/^(0|[1-9][0-9]{0,18})$/).optional(),
  referenceProof: z.string().regex(/^v1\.[1-9][0-9]{0,18}\.[a-f0-9]{64}$/).optional(),
  decidedAt: z.iso.datetime({ offset: true }), expiresAt: z.iso.datetime({ offset: true }), enabled: z.boolean(),
}).strict()

/** Queue JSON is validated again before transmission, without reconstructing it. */
export const eventSchema = z.object({
  schemaVersion: z.literal(1), eventId: z.uuid(),
  name: z.enum(['product_response_completed', 'product_first_text_observed', 'product_first_open_observed', 'product_opened', 'product_login_completed', 'product_authenticated_observed', 'product_feature_used']),
  consentRevision: z.number().int().positive(), occurredAt: z.iso.datetime({ offset: true }),
  consentProof: z.string().regex(/^v1\.[1-9][0-9]{0,18}\.[a-f0-9]{64}$/),
  surface: z.enum(['desktop', 'cli', 'dashboard']), os: z.enum(['macos', 'windows', 'linux', 'other']),
  appVersion: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/),
  operationId: z.uuid().optional(), modality: z.enum(['verboo_gateway', 'external']).optional(),
  outcome: z.enum(['started', 'completed', 'failed', 'cancelled']).optional(),
  feature: z.enum(['conversation', 'model_switch', 'tool', 'browser', 'mcp', 'plan', 'goal', 'checkout', 'pane_split_right', 'pane_split_down', 'stop_button', 'project_add',
    'message_enter', 'message_button', 'message_queue_enter', 'message_queue_button', 'message_steer_enter', 'message_steer_button',
    'preference_busy_queue', 'preference_busy_steer', 'model_choice', 'queue_steer_button',
    'preference_coding_tools_on', 'preference_coding_tools_off',
    'preference_preset_cordis', 'preference_preset_ptc', 'preference_preset_minimal', 'preference_preset_standard', 'preference_preset_other',
    'preference_theme_light', 'preference_theme_dark', 'preference_theme_system', 'preference_minimalist_on', 'preference_minimalist_off',
    'preference_language_en', 'preference_language_pt', 'preference_language_zh', 'preference_language_ja',
    'preference_language_es', 'preference_language_fr', 'preference_language_de', 'preference_language_ru', 'preference_language_other',
    'desktop_update_download', 'desktop_update_install', 'desktop_update_error', 'desktop_response_attempt', 'desktop_response_error', 'desktop_connection_recovered',
    'desktop_first_use_guide', 'desktop_first_use_task',
    'desktop_first_use_step_project', 'desktop_first_use_step_model', 'desktop_first_use_step_message',
    'desktop_first_use_step_split', 'desktop_first_use_step_tools',
    'terminal_open', 'files_open', 'document_open', 'attachment_image', 'attachment_file', 'attachment_folder',
    'attachment_upload_image', 'attachment_upload_file', 'attachment_retry_image', 'attachment_retry_file',
    'schedule_create', 'schedule_edit', 'schedule_pause', 'schedule_resume', 'schedule_delete', 'schedule_run',
    'schedule_after', 'schedule_at', 'schedule_every', 'schedule_daily', 'schedule_weekly', 'schedule_cron', 'schedule_rrule',
    'conversation_new', 'conversation_open', 'conversation_search', 'command_submit', 'integration_connect', 'mcp_connect', 'mcp_configure', 'mcp_probe']).optional(),
  errorCategory: z.enum(['authentication', 'quota', 'rate_limit', 'connection', 'timeout', 'service',
    'request', 'empty_response', 'tools', 'unknown']).optional(),
  durationMs: z.number().int().min(0).max(604800000).optional(),
  modelProvider: z.enum(['verboo', 'openai', 'deepseek', 'other']).optional(),
  modelName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/).optional(),
  modelEffort: z.enum(['default', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'other']).optional(),
}).strict()

const identitySchema = z.object({
  owner: z.string().max(100), secret: z.string().regex(/^[a-f0-9]{64}$/),
  consent: consentSchema.nullable(), pendingDecision: z.enum(['granted', 'denied']).nullable(),
  pendingRevision: z.number().int().nonnegative().nullable(),
  firstOpenEventId: z.uuid().nullable(),
  anonymousLink: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  linked: z.boolean(),
  observedLogin: z.string().max(100).nullable(),
}).strict()

const itemSchema = z.object({
  eventId: z.uuid(), owner: z.string().max(100), json: z.string().max(4096),
  attempts: z.number().int().nonnegative(), nextAttemptAt: z.number().nonnegative(),
}).strict()

const storageSchema = z.object({
  version: z.literal(1), activeOwner: z.string().max(100),
  installationSecret: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  installationFirstOpenEventId: z.uuid().nullable().optional(),
  contexts: z.array(identitySchema).max(32), pending: z.array(itemSchema).max(1000), lost: z.number().int().nonnegative(),
}).strict()

/** Account/session-independent queue owner. Secrets remain in Host storage. */
export type AnalyticsIdentity = z.infer<typeof identitySchema>
/** Immutable event bytes plus discardable delivery scheduling metadata. */
export type AnalyticsItem = z.infer<typeof itemSchema>
/** Versioned local persistence, separate from released session formats. */
export type AnalyticsStorage = z.infer<typeof storageSchema>

const key = credentialKey('verboo-product-analytics', 'state')

/** Credentials-backed mutation serializes preference and queue changes. */
export class AnalyticsStorageStore {
  /** @param credentials - Host-owned durable record provider. */
  constructor(private readonly credentials: CredentialProvider) {}

  /**
   * Read the versioned analytics state from the credentials provider.
   * @returns validated durable state; malformed state never enables collection.
   */
  async read(): Promise<AnalyticsStorage> {
    const record = await this.credentials.readRecord(key)
    return record?.kind === 'grant' ? storageSchema.parse(record.payload) : {
      version: 1, activeOwner: '', contexts: [], pending: [], lost: 0,
    }
  }

  /**
   * Apply one serialized mutation without re-encoding pending event JSON.
   * @param change - synchronous mutation of the validated local state.
   */
  async update(change: (state: AnalyticsStorage) => void): Promise<void> {
    await this.credentials.modifyRecord(key, (current) => {
      const state: AnalyticsStorage = current?.kind === 'grant' ? storageSchema.parse(current.payload) : {
        version: 1, activeOwner: '', contexts: [], pending: [], lost: 0,
      }
      change(state)
      return Promise.resolve({ kind: 'grant' as const, payload: storageSchema.parse(state) })
    })
  }

  /**
   * Select one canonical account, or mint a fresh anonymous context after logout.
   * @param userId - validated current account ID, absent while signed out.
   * @returns the selected durable identity and an account-independent installation secret.
   */
  async select(userId: string | undefined): Promise<{ identity: AnalyticsIdentity; installationSecret: string }> {
    let selected: AnalyticsIdentity | undefined
    let installationSecret: string | undefined
    await this.update((state) => {
      state.installationSecret ??= randomBytes(32).toString('hex')
      if (state.installationFirstOpenEventId === undefined) {
        state.installationFirstOpenEventId = state.contexts.find(context => context.firstOpenEventId !== null)?.firstOpenEventId ?? null
      }
      installationSecret = state.installationSecret
      const owner = userId ?? (state.activeOwner.startsWith('anonymous:') ? state.activeOwner : `anonymous:${randomUUID()}`)
      selected = state.contexts.find(context => context.owner === owner)
      if (selected === undefined) {
        if (state.contexts.length === 32) throw new Error('product_analytics_context_capacity')
        selected = { owner, secret: randomBytes(32).toString('hex'), consent: null, pendingDecision: null, pendingRevision: null, firstOpenEventId: null, anonymousLink: null, linked: false, observedLogin: null }
        state.contexts.push(selected)
      }
      // Keep legacy fields readable while discarding any previously staged
      // anonymous-to-account link; product measurement does not identify users.
      selected.anonymousLink = null
      selected.linked = false
      state.activeOwner = owner
    })
    if (selected === undefined || installationSecret === undefined) throw new Error('product_analytics_identity_unavailable')
    return { identity: selected, installationSecret }
  }
}
