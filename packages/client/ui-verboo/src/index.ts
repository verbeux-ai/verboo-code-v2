/** Product settings keep refresh budgets static and diagnostics live on the Host. */
import type { Volatile } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { ConfigFields, type Config as BrowserConfig, type ConversationWidth } from './config.ts'

/** Host diagnostics can change without restarting the product or agent. */
export interface Config extends Omit<BrowserConfig, 'staminaDebug' | 'paneLayout' | 'minimalist' | 'conversationWidth'> {
  /** Changing conversation appearance preserves mounted editors and running work. */
  minimalist: Volatile<boolean>
  /** Share the selected transcript width across panes without reloading them. */
  conversationWidth: Volatile<ConversationWidth>
  /** Pane persistence never reloads the product or its Session views. */
  paneLayout: Volatile<string>
  /** Opt-in diagnostics exposed through the shared configuration form. */
  staminaDebug: Volatile<boolean>
}

/** Host settings expose the diagnostic switch as a live field. */
export const Config = Schema.object({
  ...ConfigFields,
  minimalist: ConfigFields.minimalist.volatile(),
  conversationWidth: ConfigFields.conversationWidth.volatile(),
  staminaDebug: ConfigFields.staminaDebug.volatile(),
  paneLayout: ConfigFields.paneLayout.volatile(),
})
export function apply(): void {}
