// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import { BillingToolRow } from '../src/client/BillingToolRow.tsx'
import { pt } from '../src/client/locales.ts'

afterEach(cleanup)

function show(value: Record<string, unknown>) {
  const toolName = 'verboo_plan_operation'
  const block: ToolResultNode = {
    kind: 'tool-result', seq: 2, time: 2, callId: 'plan-result', name: toolName,
    args: PartialArguments.fromText('{}'), call: { name: toolName, argsRaw: '{}' },
    callTime: 1, content: [{ type: 'text', text: JSON.stringify(value) }],
    isError: false, subCalls: [],
  }
  const props = { phase: 'result', callId: 'plan-result', toolName, block, t: (key: keyof typeof pt) => pt[key] } as ComponentProps<typeof BillingToolRow>
  return render(<BillingToolRow {...props} />)
}

it('replays the scheduled response with localized status and omits raw provider content', () => {
  const view = show({ ok: true, operation: { status: 'scheduled', private: 'https://checkout.stripe.com/never-render' } })
  expect(view.container.textContent).toMatchInlineSnapshot('"Consultar operação de cobrançaTroca de plano agendada."')
  expect(view.container.querySelector('a')).toBeNull()
})

it('makes an unconfirmed operation and an invalidated account distinct', () => {
  const pending = show({ ok: true, operation: { status: 'unconfirmed' } })
  expect(screen.getByText(pt.billingUnknown)).toBeTruthy()
  pending.unmount()
  show({ ok: false, code: 'account_changed' })
  expect(screen.getByText(pt.billingConversationAccountChanged)).toBeTruthy()
})
