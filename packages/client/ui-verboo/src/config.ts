import Schema from '@deepseek-ai/schemastery'
/** Browser refresh and reconciliation budgets. */
export interface Config {
  /** Global conversation appearance, shared by all existing and future panes. */
  minimalist: boolean
  /** Serialized pane arrangement, persisted in the Host profile across local-origin changes. */
  paneLayout: string
  /** Minimum width in CSS pixels of a split conversation pane. */
  minimumPaneWidth: number
  /** Minimum height in CSS pixels of a split conversation pane. */
  minimumPaneHeight: number
  /** Interval in milliseconds between visible account reconciliation reads. */
  refreshIntervalMs: number
  /** Interval in milliseconds between visible Stamina reads. */
  staminaRefreshIntervalMs: number
  /** Opt-in raw stamina percentage and server timestamp; never generation rates. */
  staminaDebug?: boolean
  /** Maximum duration in milliseconds of a browser authorization or billing handoff. */
  handoffTimeoutMs: number
}
/** Shared defaults; the Host exposes only diagnostics as a live preference. */
export const ConfigFields = {
  minimalist: Schema.boolean().default(false),
  paneLayout: Schema.string().default(''),
  minimumPaneWidth: Schema.number().min(320).max(800).default(360),
  minimumPaneHeight: Schema.number().min(240).max(600).default(280),
  refreshIntervalMs: Schema.number().min(1000).max(30000).default(5000),
  staminaRefreshIntervalMs: Schema.number().min(1000).max(30000).default(2000),
  staminaDebug: Schema.boolean().default(false),
  handoffTimeoutMs: Schema.number().min(10000).max(600000).default(180000),
}
export const Config = Schema.object(ConfigFields)
