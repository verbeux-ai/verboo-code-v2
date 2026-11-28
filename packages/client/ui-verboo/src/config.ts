import Schema from '@deepseek-ai/schemastery'

/** Maximum transcript widths; each pane can shrink to fit its available space. */
export const CONVERSATION_WIDTHS = { narrow: 660, standard: 920, wide: 1200 } as const
export type ConversationWidth = keyof typeof CONVERSATION_WIDTHS

/** Browser refresh and reconciliation budgets. */
export interface Config {
  /** Global conversation appearance, shared by all existing and future panes. */
  minimalist: boolean
  conversationWidth: ConversationWidth
  /** Serialized pane arrangement, persisted in the Host profile across local-origin changes. */
  paneLayout: string
  /** Whether the desktop welcome was dismissed or completed on this profile. */
  firstUseTourSeen: boolean
  /** Minimum width in CSS pixels of a split conversation pane. */
  minimumPaneWidth: number
  /** Minimum height in CSS pixels of a split conversation pane. */
  minimumPaneHeight: number
  /** Interval in milliseconds between visible account reconciliation reads. */
  refreshIntervalMs: number
  /** Interval in milliseconds between visible Stamina reads. */
  staminaRefreshIntervalMs: number
  /** Interval in milliseconds between visible Plans allowance reads. */
  usageWindowsRefreshIntervalMs: number
  /** Opt-in raw stamina percentage and server timestamp; never generation rates. */
  staminaDebug?: boolean
  /** Maximum duration in milliseconds of a browser authorization or billing handoff. */
  handoffTimeoutMs: number
}
/** Shared defaults; the Host exposes only diagnostics as a live preference. */
export const ConfigFields = {
  minimalist: Schema.boolean().default(true),
  conversationWidth: Schema.union(['narrow', 'standard', 'wide']).default('standard'),
  paneLayout: Schema.string().default(''),
  firstUseTourSeen: Schema.boolean().default(false),
  minimumPaneWidth: Schema.number().min(320).max(800).default(360),
  minimumPaneHeight: Schema.number().min(240).max(600).default(280),
  refreshIntervalMs: Schema.number().min(1000).max(30000).default(5000),
  staminaRefreshIntervalMs: Schema.number().min(1000).max(30000).default(2000),
  usageWindowsRefreshIntervalMs: Schema.number().min(1000).max(60000).default(15000),
  staminaDebug: Schema.boolean().default(false),
  handoffTimeoutMs: Schema.number().min(10000).max(600000).default(180000),
}
export const Config = Schema.object(ConfigFields)
