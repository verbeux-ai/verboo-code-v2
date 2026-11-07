/** Product settings keep refresh budgets static and diagnostics live on the Host. */
import type { Volatile } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { ConfigFields, type Config as BrowserConfig } from './config.ts'

/** Host diagnostics can change without restarting the product or agent. */
export interface Config extends Omit<BrowserConfig, 'staminaDebug'> {
  /** Opt-in diagnostics exposed through the shared configuration form. */
  staminaDebug: Volatile<boolean>
}

/** Host settings expose the diagnostic switch as a live field. */
export const Config = Schema.object({
  ...ConfigFields,
  staminaDebug: ConfigFields.staminaDebug.volatile(),
})
export function apply(): void {}
