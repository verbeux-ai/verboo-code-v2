// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AnalyticsPage, type AnalyticsActions } from '../src/client/Analytics.tsx'
import type { PageProps } from '../src/client/contracts.ts'
import { pt } from '../src/client/locales.ts'

const summary = { timezone: 'America/Sao_Paulo', bucket: 'day' as const, reqTotal: 4, tokensInTotal: 1000, tokensOutTotal: 300, cachedTokens: 250, buckets: [{ bucket: '2026-11-25T00:00:00-03:00', reqCount: 4, tokensIn: 1000, tokensOut: 300, cachedTokens: 250 }] }
const planId = '00000000-0000-4000-8000-000000000001'
const product = { view: { status: 'credential-stored', credentialRevision: 'revision' }, profile: { id: 'account-a' }, plans: { subscriptions: [{ planId, name: 'Pro', status: 'active', renewsAt: null }], catalog: [] }, plansFailed: false }
const copy: Record<string, string> = pt
function fixture() {
  const summaryRead = vi.fn<AnalyticsActions['summary']>().mockResolvedValue({ ok: true, data: summary })
  const activity = vi.fn<AnalyticsActions['activity']>().mockResolvedValue({ ok: true, data: [{ date: '2026-11-25', count: 4 }] })
  const props = {
    t: (key: string, args?: Record<string, string>) => Object.entries(args ?? {}).reduce((value, [name, replacement]) => value.replace(`{${name}}`, replacement), copy[key] ?? key),
    useProduct: (selector: (value: typeof product) => unknown) => selector(product),
    usePreferences: (selector: (value: { locale: string }) => unknown) => selector({ locale: 'pt-BR' }),
    useResource: () => ({ status: 'ready', value: [{ groupId: planId, groupName: 'Pro', remainingPercent: 75, recovering: false, fullAt: null, accountingPending: false }] }),
    loadPlans: vi.fn(), refreshStamina: vi.fn(), summary: summaryRead, activity,
    speed: async function* (signal: AbortSignal) {
      await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
    },
  } as unknown as PageProps & AnalyticsActions
  return { props, summaryRead, activity }
}
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('shows an account speed measurement and marks the last reading', async () => {
  const f = fixture()
  const gate = Promise.withResolvers<undefined>()
  const speed: AnalyticsActions['speed'] = async function* (signal) {
    yield { at: '2026-11-26T12:00:00Z', stale: false, measurement: { value: 123.4, quality: 'estimated', partial: false, at: '2026-11-26T12:00:00Z', previous: false } }
    await gate.promise
    if (!signal.aborted) yield { at: '2026-11-26T12:00:01Z', stale: false, measurement: null }
    await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
  }
  render(<AnalyticsPage {...f.props} speed={speed} />)
  expect(await screen.findByText('123,4')).toBeTruthy()
  expect(screen.getByText('Estimativa atual')).toBeTruthy()
  gate.resolve(undefined)
  expect(await screen.findByText(/Última leitura às/)).toBeTruthy()
  expect(screen.queryByText(/concorrência|simultânea/i)).toBeNull()
})

it('shows the selected subscription metrics and activity', async () => {
  const f = fixture()
  render(<AnalyticsPage {...f.props} />)
  expect(await screen.findByText('1.000')).toBeTruthy()
  expect(screen.getByText('300')).toBeTruthy()
  expect(screen.getByText('250')).toBeTruthy()
  expect(screen.queryByText('Custo equivalente')).toBeNull()
  expect(screen.getByRole('img', { name: 'Atividade diária' }).querySelectorAll('[data-level]').length).toBe(365)
  expect(screen.getByRole('img', { name: 'Tokens por período' })).toBeTruthy()
  expect(screen.queryByText(/concorrência|simultânea/i)).toBeNull()
  expect(f.summaryRead).toHaveBeenCalledWith('30d', null, expect.any(AbortSignal))
  expect(f.summaryRead).toHaveBeenCalledWith('30d', planId, expect.any(AbortSignal))
  fireEvent.change(screen.getByRole('combobox', { name: 'Período' }), { target: { value: '7d' } })
  await waitFor(() => { expect(f.summaryRead).toHaveBeenCalledWith('7d', null, expect.any(AbortSignal)) })
}, 15000)

it('reports an activity failure rather than showing a fabricated empty calendar', async () => {
  const f = fixture()
  f.activity.mockResolvedValue({ ok: false, code: 'unavailable' })
  render(<AnalyticsPage {...f.props} />)
  expect(await screen.findByText('Não foi possível carregar a atividade.')).toBeTruthy()
  expect(screen.queryByRole('img', { name: 'Atividade diária' })).toBeNull()
})

it('does not show a previous period after a slower request finishes', async () => {
  const f = fixture()
  const delayed = Promise.withResolvers<Awaited<ReturnType<AnalyticsActions['summary']>>>()
  f.summaryRead.mockImplementation(async period => period === '30d' ? delayed.promise : { ok: true, data: { ...summary, tokensInTotal: 7000 } })
  render(<AnalyticsPage {...f.props} />)
  fireEvent.change(screen.getByRole('combobox', { name: 'Período' }), { target: { value: '7d' } })
  expect(await screen.findByText('7.000')).toBeTruthy()
  delayed.resolve({ ok: true, data: summary })
  await waitFor(() => { expect(screen.getByText('7.000')).toBeTruthy() })
  expect(screen.queryByText('1.000')).toBeNull()
})

it('discards results belonging to the previous account', async () => {
  const f = fixture()
  const delayed = Promise.withResolvers<Awaited<ReturnType<AnalyticsActions['summary']>>>()
  let current = product
  f.summaryRead.mockImplementation(async () => current.profile.id === 'account-a' ? delayed.promise : { ok: true, data: { ...summary, tokensInTotal: 9000 } })
  const props = {
    ...f.props, useProduct: (select: (value: typeof product) => unknown) => select(current),
  } as unknown as PageProps & AnalyticsActions
  const view = render(<AnalyticsPage {...props} />)
  current = { ...product, view: { ...product.view, credentialRevision: 'next-revision' }, profile: { id: 'account-b' } }
  view.rerender(<AnalyticsPage {...props} />)
  expect(await screen.findByText('9.000')).toBeTruthy()
  delayed.resolve({ ok: true, data: summary })
  await waitFor(() => { expect(screen.getByText('9.000')).toBeTruthy() })
  expect(screen.queryByText('1.000')).toBeNull()
})

it('keeps the totals when one plan read fails', async () => {
  const f = fixture()
  f.summaryRead.mockImplementation(async (_period, group) => group === null ? { ok: true, data: summary } : { ok: false, code: 'unavailable' })
  render(<AnalyticsPage {...f.props} />)
  expect(await screen.findByText('O uso deste plano está indisponível.')).toBeTruthy()
  expect(screen.getByText('1.000')).toBeTruthy()
})

it('shows totals without waiting for a slow plan read', async () => {
  const f = fixture()
  const delayed = Promise.withResolvers<Awaited<ReturnType<AnalyticsActions['summary']>>>()
  f.summaryRead.mockImplementation(async (_period, group) => group === null ? { ok: true, data: summary } : delayed.promise)
  render(<AnalyticsPage {...f.props} />)
  expect(await screen.findByText('1.000')).toBeTruthy()
  expect(screen.getAllByText('Carregando uso…').length).toBeGreaterThan(0)
  delayed.resolve({ ok: true, data: summary })
  await waitFor(() => { expect(screen.queryByText('Carregando uso…')).toBeNull() })
})

it('offers account retry when the owner cannot be verified', () => {
  const f = fixture()
  const account = { ...product, accountFailed: true, profile: null }
  const retryAccount = vi.fn()
  const props = {
    ...f.props, retryAccount, useProduct: (select: (value: typeof account) => unknown) => select(account),
  } as unknown as PageProps & AnalyticsActions
  render(<AnalyticsPage {...props} />)
  expect(screen.getByText('Não foi possível carregar o uso.')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }))
  expect(retryAccount).toHaveBeenCalledOnce()
  expect(f.summaryRead).not.toHaveBeenCalled()
})

it('offers sign-in when the usage API reports a disconnected account', async () => {
  const f = fixture()
  const start = vi.fn()
  f.summaryRead.mockResolvedValue({ ok: false, code: 'signed_out' })
  render(<AnalyticsPage {...f.props} start={start} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Entrar novamente' }))
  expect(start).toHaveBeenCalledOnce()
})
