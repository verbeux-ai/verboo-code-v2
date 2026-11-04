import Schema from '@deepseek-ai/schemastery'
/** Browser refresh and reconciliation budgets. */
export interface Config {
  /** Interval in milliseconds between visible account reconciliation reads. */
  refreshIntervalMs: number
  /** Interval in milliseconds between visible Stamina reads. */
  staminaRefreshIntervalMs: number
  /** Maximum duration in milliseconds of a browser authorization or billing handoff. */
  handoffTimeoutMs: number
}
export const Config = Schema.object({
  refreshIntervalMs: Schema.number().min(1000).max(30000).default(5000),
  staminaRefreshIntervalMs: Schema.number().min(1000).max(30000).default(2000),
  handoffTimeoutMs: Schema.number().min(10000).max(600000).default(180000),
})
