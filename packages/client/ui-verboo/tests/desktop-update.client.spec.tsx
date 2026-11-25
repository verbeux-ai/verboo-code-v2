// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { DesktopUpdate } from '../src/client/DesktopUpdate.tsx'
import { createUpdateSource, type DesktopUpdateState } from '../src/client/update-source.ts'
import { pt } from '../src/client/locales.ts'
import type { ProductProps } from '../src/client/contracts.ts'

const t = ((key: keyof typeof pt) => pt[key]) as ProductProps['t']
afterEach(() => { cleanup(); vi.restoreAllMocks(); globalThis.__VERBOO_UPDATE__ = undefined })

describe('desktop update indicator', () => {
  it('announces a completed download when the sidebar mounts after it finished', () => {
    render(<DesktopUpdate state={{ phase: 'ready', percent: 100 }} t={t} install={vi.fn()} />)
    expect(screen.getByRole('status').textContent).toBe('Atualização baixada com sucesso')
    expect(screen.getByRole('button', { name: 'Atualização baixada com sucesso' })).toBeTruthy()
  })

  it('keeps progress small, announces completion and opens a speech bubble', () => {
    const install = vi.fn().mockResolvedValue(undefined)
    const view = render(<DesktopUpdate state={{ phase: 'downloading', percent: 42 }} t={t} install={install} />)
    const button = screen.getByRole('button', { name: 'Baixando atualização' })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(button.querySelector('circle[stroke-dashoffset="58"]')).not.toBeNull()
    fireEvent.click(button)
    expect(screen.queryByRole('dialog')).toBeNull()
    view.rerender(<DesktopUpdate state={{ phase: 'ready', percent: 100 }} t={t} install={install} />)
    expect(screen.getByRole('status').textContent).toBe('Atualização baixada com sucesso')
    fireEvent.click(screen.getByRole('button', { name: 'Atualização baixada com sucesso' }))
    expect(screen.getByRole('dialog').textContent).toContain('Será instalada'.toLocaleLowerCase())
    expect(screen.queryByRole('button', { name: 'Mais tarde' })).toBeNull()
    expect(screen.getByRole('dialog').textContent).toContain('Conversas ou tarefas em andamento serão interrompidas.')
    fireEvent.click(screen.getByRole('button', { name: 'Reiniciar agora' }))
    expect(install).not.toHaveBeenCalled()
    const confirmation = screen.getByRole('dialog', { name: 'Reiniciar agora?' })
    expect(confirmation.textContent).toContain('Conversas ou tarefas em andamento serão interrompidas')
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Reiniciar agora' }))
    expect(install).toHaveBeenCalledOnce()
  })

  it('keeps the failure visible if the restart request is rejected', async () => {
    const install = vi.fn().mockRejectedValue(new Error('unavailable'))
    render(<DesktopUpdate state={{ phase: 'ready', percent: 100 }} t={t} install={install} />)
    fireEvent.click(screen.getByRole('button', { name: 'Atualização baixada com sucesso' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reiniciar agora' }))
    const confirmation = screen.getByRole('dialog', { name: 'Reiniciar agora?' })
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Reiniciar agora' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('Não foi possível concluir a atualização.') })
    expect(screen.getByRole('button', { name: 'Reiniciar agora' }).hasAttribute('disabled')).toBe(false)
  })

  it('keeps the update ready without an error when the native confirmation is cancelled', async () => {
    const install = vi.fn().mockRejectedValue('update_confirmation_cancelled')
    render(<DesktopUpdate state={{ phase: 'ready', percent: 100 }} t={t} install={install} />)
    fireEvent.click(screen.getByRole('button', { name: 'Atualização baixada com sucesso' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reiniciar agora' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Reiniciar agora?' })).getByRole('button', { name: 'Reiniciar agora' }))
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Reiniciar agora' }).hasAttribute('disabled')).toBe(false) })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: 'Atualização baixada com sucesso' }).getAttribute('aria-expanded')).toBe('true')
  })

  it('explains that another instance must close and permits a retry', async () => {
    const install = vi.fn().mockRejectedValueOnce(new Error('update_other_instance_active')).mockResolvedValueOnce(undefined)
    render(<DesktopUpdate state={{ phase: 'ready', percent: 100 }} t={t} install={install} />)
    fireEvent.click(screen.getByRole('button', { name: 'Atualização baixada com sucesso' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reiniciar agora' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Reiniciar agora?' })).getByRole('button', { name: 'Reiniciar agora' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('Feche a outra janela do Verboo Code e tente novamente.') })
    fireEvent.click(screen.getByRole('button', { name: 'Reiniciar agora' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Reiniciar agora?' })).getByRole('button', { name: 'Reiniciar agora' }))
    await waitFor(() => { expect(install).toHaveBeenCalledTimes(2) })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('closes the speech bubble on Escape and does not render without an update', () => {
    const install = vi.fn()
    const view = render(<DesktopUpdate state={{ phase: 'ready', percent: 100 }} t={t} install={install} />)
    fireEvent.click(screen.getByRole('button', { name: 'Atualização baixada com sucesso' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    view.rerender(<DesktopUpdate state={{ phase: 'idle', percent: null }} t={t} install={install} />)
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('desktop update source', () => {
  it('does not overwrite a newer event with an older initial snapshot', async () => {
    let listener: ((state: DesktopUpdateState) => void) | undefined
    let resolve!: (state: DesktopUpdateState) => void
    const pending = new Promise<DesktopUpdateState>((done) => { resolve = done })
    const unsubscribe = vi.fn()
    globalThis.__VERBOO_UPDATE__ = {
      getState: () => pending,
      subscribe: (callback) => { listener = callback; return unsubscribe },
      install: async () => {},
    }
    const source = createUpdateSource()
    const stop = source.start()
    listener?.({ phase: 'ready', percent: 100 })
    resolve({ phase: 'downloading', percent: 23 })
    await pending
    await Promise.resolve()
    expect(source.state.getSnapshot()).toEqual({ phase: 'ready', percent: 100 })
    stop()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
  it('ignores a snapshot and disposer from an earlier activation', async () => {
    const snapshots: Array<(state: DesktopUpdateState) => void> = []
    const subscriptions: Array<{ listener: (state: DesktopUpdateState) => void; stop: ReturnType<typeof vi.fn> }> = []
    globalThis.__VERBOO_UPDATE__ = {
      getState: () => new Promise((resolve) => { snapshots.push(resolve) }),
      subscribe: (listener) => { const stop = vi.fn(); subscriptions.push({ listener, stop }); return stop },
      install: async () => {},
    }
    const source = createUpdateSource()
    const stopFirst = source.start()
    stopFirst()
    const stopSecond = source.start()
    snapshots[1]?.({ phase: 'ready', percent: 100 })
    await Promise.resolve()
    snapshots[0]?.({ phase: 'idle', percent: null })
    await Promise.resolve()
    stopFirst()
    expect(source.state.getSnapshot()).toEqual({ phase: 'ready', percent: 100 })
    expect(subscriptions[1]?.stop).not.toHaveBeenCalled()
    subscriptions[1]?.listener({ phase: 'downloading', percent: 42 })
    expect(source.state.getSnapshot()).toEqual({ phase: 'downloading', percent: 42 })
    stopSecond()
    expect(subscriptions[0]?.stop).toHaveBeenCalledOnce()
    expect(subscriptions[1]?.stop).toHaveBeenCalledOnce()
  })

})
