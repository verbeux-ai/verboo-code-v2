/** Transcript view of the recorded first-party billing tool result. */
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Glyph } from './Glyph.tsx'
import type { Key } from './locales.ts'
import css from './Plans.module.css'

const titles = {
  verboo_plan_status: 'yourSubscriptions',
  verboo_plan_change_preview: 'billingNewPlan',
  verboo_plan_change_request: 'billingChangePlan',
  verboo_plan_cancel: 'billingCancelSubscription',
  verboo_plan_operation: 'billingConversationOperation',
} as const satisfies Record<string, Key>

/** Tool keys matched by the transcript slot in the Verboo product composition. */
export const billingToolNames = Object.keys(titles)

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}

function decode(raw: string | undefined) {
  if (raw === undefined || raw.length > 48_000) return null
  try {
    return record(JSON.parse(raw))
  } catch {
    return null
  }
}

function resultKey(data: Record<string, unknown> | null): Key {
  const operation = record(data?.operation)
  if (operation?.requiresCustomerAction === true) return 'billingConversationPayment'
  switch (operation?.status) {
    case 'scheduled': return 'billingChangeScheduled'
    case 'completed': return 'billingChangeComplete'
    case 'confirmed': return 'billingCancellationConfirmed'
    case 'expired': return 'billingExpired'
    case 'failed': return 'billingChangeFailed'
    case 'cancelled':
    case 'canceled': return 'canceled'
    case 'reconciliation_required': return 'billingReview'
    case 'unconfirmed': return 'billingUnknown'
  }
  if (operation) return 'billingProcessing'
  if (data?.ok === true) return data.operation === null ? 'billingConversationNoOperation' : 'billingConversationReady'
  switch (data?.code) {
    case 'not_approved':
    case 'cancelled': return 'billingConversationDeclined'
    case 'not_allowed':
    case 'not_found': return 'billingNoActions'
    case 'account_changed': return 'billingConversationAccountChanged'
    case 'operation_pending': return 'billingProcessing'
    case 'quote_changed': return 'billingExpired'
    case 'terms_required': return 'billingTermsRequired'
    default: return 'billingUnavailable'
  }
}

/**
 * Show localized progress and outcomes from the normal tool transcript without exposing raw input or output.
 * @param props - projected call stage and current locale.
 * @returns the compact billing row, including its pending and failure states.
 */
export function BillingToolRow({ toolName, phase, block, t }: ToolCallViewProps & PropsLocale<'verboo'>) {
  const title = titles[toolName as keyof typeof titles]
  const settled = phase === 'result'
  const text = settled ? block.content.find(item => item.type === 'text')?.text : undefined
  const detail = settled ? resultKey(decode(text)) : 'loading'
  return <div className={css.billingToolRow} data-tool={toolName} data-state={settled ? 'settled' : 'pending'}>
    <Glyph name="credit-card" size={15} />
    <span><strong>{t(title)}</strong><span>{t(detail)}</span></span>
  </div>
}
