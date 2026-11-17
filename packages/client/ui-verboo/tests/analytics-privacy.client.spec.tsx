// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { AnalyticsChoice, AnalyticsPrompt } from '../src/client/AnalyticsPrivacy.tsx'
import { en, pt, zh } from '../src/client/locales.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ProductAnalyticsSubject } from '@deepseek-ai/dsh-host-verboo-analytics/types'
import type { ProductAnalyticsStatus } from '@deepseek-ai/dsh-host-verboo-analytics/types'
import type { ProductSnapshot } from '../src/client/model.ts'

afterEach(cleanup)

const status: ProductAnalyticsStatus = { consent: {
  subjectId: brandString<ProductAnalyticsSubject>('a'.repeat(64)),
  decision: 'unknown', revision: 0, policyVersion: 1, enabled: true,
  decidedAt: '1970-01-01T00:00:00Z', expiresAt: '1970-01-01T00:00:00Z',
}, pending: 0, lost: 0, failure: 'none' }

function fixture() {
  const choose = vi.fn(async (_decision: 'granted' | 'denied') => true)
  const props: ComponentProps<typeof AnalyticsChoice> = {
    t: (key: string) => (en as Readonly<Record<string, string>>)[key] ?? key,
    useAnalyticsPrivacy: selector => selector(status), chooseProductAnalytics: choose,
  }
  return { props, choose }
}

it('offers explicit acceptance and rejection without bundling advertising', async () => {
  const f = fixture()
  render(<AnalyticsChoice {...f.props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Do not allow' }))
  await waitFor(() => { expect(f.choose).toHaveBeenCalledWith('denied') })
  await waitFor(() => { expect(screen.getByRole('button', { name: 'Allow analytics' }).hasAttribute('disabled')).toBe(false) })
  fireEvent.click(screen.getByRole('button', { name: 'Allow analytics' }))
  await waitFor(() => { expect(f.choose).toHaveBeenLastCalledWith('granted') })
})

it('reports an unsuccessful save without showing acceptance as confirmed', async () => {
  const f = fixture(); f.choose.mockResolvedValue(false)
  render(<AnalyticsChoice {...f.props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Allow analytics' }))
  expect((await screen.findByRole('alert')).textContent).toContain('Could not confirm the preference')
})

it('does not grant when the compact prompt is closed', () => {
  const f = fixture()
  const props = {
    ...f.props,
    useProduct: <T,>(selector: (state: ProductSnapshot) => T) =>
      selector({ initialized: true, profilePreviouslyVerified: true } as ProductSnapshot),
  } as ComponentProps<typeof AnalyticsPrompt>
  render(<AnalyticsPrompt {...props} />)
  expect(screen.getByText('Help improve Verboo Code')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  expect(screen.queryByRole('button', { name: 'Allow analytics' })).toBeNull()
  expect(f.choose).not.toHaveBeenCalled()
})


it('keeps the privacy choice translated in Portuguese and Chinese', () => {
  expect(pt.analyticsAccept).toBe('Permitir analytics')
  expect(pt.analyticsReject).toBe('Não permitir')
  expect(zh.analyticsAccept).toBe('允许分析')
  expect(zh.analyticsReject).toBe('不允许')
})
