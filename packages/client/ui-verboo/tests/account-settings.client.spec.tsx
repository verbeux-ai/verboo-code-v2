// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { AccountSettings } from '../src/client/AccountSettings.tsx'
import { PreferencesPage } from '../src/client/Pages.tsx'
import { pt } from '../src/client/locales.ts'
import { initialProductSnapshot } from '../src/client/model.ts'

const copy: Readonly<Record<string, string>> = pt
afterEach(cleanup)

it('saves a profile change for the displayed account and validates password confirmation', async () => {
  const profile = { id: 'user-a', name: 'Ana', email: 'ana@example.test', hasPassword: true, publicProfile: false }
  const updateProfileSettings = vi.fn().mockResolvedValue({ ok: true, data: { ...profile, name: 'Ana Maria' } })
  const updateAccountPassword = vi.fn().mockResolvedValue({ ok: true })
  const props: ComponentProps<typeof AccountSettings>['props'] = {
    t: key => copy[key] ?? key,
    getProfileSettings: vi.fn().mockResolvedValue({ ok: true, data: profile }),
    updateProfileSettings, updateAccountPassword,
  }
  render(<AccountSettings props={props} owner="user-a" />)
  fireEvent.change(await screen.findByLabelText('Nome'), { target: { value: 'Ana Maria' } })
  fireEvent.click(screen.getByRole('button', { name: 'Salvar alterações' }))
  await waitFor(() => { expect(updateProfileSettings).toHaveBeenCalledWith({ owner: 'user-a', name: 'Ana Maria' }) })
  await screen.findByText('Alterações salvas.')
  expect(screen.queryByLabelText('Senha atual')).toBeNull()
  const trigger = screen.getByRole('button', { name: 'Alterar senha' })
  fireEvent.click(trigger)
  const dialog = within(screen.getByRole('dialog', { name: 'Alterar senha' }))
  fireEvent.change(dialog.getByLabelText('Senha atual'), { target: { value: 'old-password' } })
  fireEvent.change(dialog.getByLabelText('Nova senha (mínimo de 8 caracteres)'), { target: { value: 'password-one' } })
  fireEvent.change(dialog.getByLabelText('Confirme a nova senha'), { target: { value: 'password-two' } })
  fireEvent.click(dialog.getByRole('button', { name: 'Salvar senha' }))
  expect(dialog.getByRole('alert').textContent).toBe('As senhas não coincidem.')
  expect(updateAccountPassword).not.toHaveBeenCalled()
  fireEvent.click(dialog.getByRole('button', { name: 'Cancelar' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(trigger)
  const reopened = within(screen.getByRole('dialog', { name: 'Alterar senha' }))
  const currentPassword = reopened.getByLabelText<HTMLInputElement>('Senha atual')
  expect(currentPassword.value).toBe('')
  expect(reopened.queryByRole('alert')).toBeNull()
  fireEvent.change(currentPassword, { target: { value: 'old-password' } })
  fireEvent.change(reopened.getByLabelText('Nova senha (mínimo de 8 caracteres)'), { target: { value: 'password-one' } })
  fireEvent.change(reopened.getByLabelText('Confirme a nova senha'), { target: { value: 'password-one' } })
  fireEvent.click(reopened.getByRole('button', { name: 'Salvar senha' }))
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  expect(updateAccountPassword).toHaveBeenCalledWith({ owner: 'user-a', currentPassword: 'old-password', newPassword: 'password-one' })
})

it('organizes settings into tabs and lets users preview and change conversation width', async () => {
  const setFontSize = vi.fn()
  const setConversationWidth = vi.fn().mockResolvedValue(false)
  const props: ComponentProps<typeof PreferencesPage> = {
    t: key => copy[key] ?? key,
    useProduct: select => select(initialProductSnapshot()),
    usePreferences: select => select({
      theme: 'dark', fontSizes: { text: 14, code: 11, terminal: 13 }, locale: 'pt',
      conversationWidth: 'standard', canSetConversationWidth: true, languages: [{ id: 'pt', label: 'Português' }],
    }),
    selectPanel: vi.fn(), setTheme: vi.fn(), setLocale: vi.fn(), setFontSize, setConversationWidth, help: vi.fn(),
    openShortcuts: vi.fn(), signOut: vi.fn(), signOutAll: vi.fn(),
    getProfileSettings: vi.fn(), updateProfileSettings: vi.fn(), updateAccountPassword: vi.fn(),
  }
  render(<PreferencesPage {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Geral' }))
  expect(screen.getByLabelText('Idioma')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Aparência' }))
  expect(screen.getByRole('button', { name: 'Escura' })).toBeTruthy()
  const slider = screen.getByRole('slider', { name: 'Tamanho da fonte' })
  expect(slider.getAttribute('aria-valuetext')).toBe('Médio')
  fireEvent.change(slider, { target: { value: '4' } })
  expect(setFontSize).toHaveBeenCalledWith('text', 22)
  expect(setFontSize).toHaveBeenCalledWith('code', 16)
  expect(setFontSize).toHaveBeenCalledWith('terminal', 20)
  expect(screen.queryByLabelText('Idioma')).toBeNull()
  expect(screen.getByRole('heading', { name: 'Prévia ao vivo' })).toBeTruthy()
  const wide = screen.getByRole('button', { name: 'Ampla' })
  fireEvent.click(wide)
  expect(wide.getAttribute('aria-pressed')).toBe('true')
  expect(setConversationWidth).toHaveBeenCalledWith('wide')
  await screen.findByRole('alert')
  expect(screen.getByRole('button', { name: 'Padrão' }).getAttribute('aria-pressed')).toBe('true')
})
