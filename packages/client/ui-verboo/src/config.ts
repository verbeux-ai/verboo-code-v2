import Schema from '@deepseek-ai/schemastery'
/** Browser refresh and reconciliation budgets. */
export interface Config {
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
  refreshIntervalMs: Schema.number().min(1000).max(30000).default(5000),
  staminaRefreshIntervalMs: Schema.number().min(1000).max(30000).default(2000),
  staminaDebug: Schema.boolean().default(false),
  handoffTimeoutMs: Schema.number().min(10000).max(600000).default(180000),
}
export const Config = Schema.object(ConfigFields)
