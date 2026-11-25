// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SidebarProps } from '../src/client/contracts.ts'
import { ProjectGroup } from '../src/client/Sidebar.tsx'
import { pt } from '../src/client/locales.ts'

const workspace: WorkspaceView = {
  workspaceId: 'project' as WorkspaceView['workspaceId'], path: '/projects/example',
  title: 'Exemplo', sessionIds: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
}
const props = {
  t: (key: keyof typeof pt) => pt[key],
  useWorkspaceAccess: () => true,
  openWorkspace: vi.fn(),
  renameProject: vi.fn(),
  removeProject: vi.fn(),
} as SidebarProps

afterEach(() => { cleanup(); vi.clearAllMocks() })

function renderProject() {
  return render(<ProjectGroup workspace={workspace} sessions={[]} current={undefined} props={props} query="" close={() => {}} />)
}

describe('project conversation disclosure', () => {
  it('retains accessible state and inert content through rapid toggles', () => {
    renderProject()
    const toggle = screen.getByRole('button', { name: 'Exemplo' })
    const content = document.getElementById(toggle.getAttribute('aria-controls') ?? '')!
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const start = screen.getByRole('button', { name: 'Nova conversa' })
    start.focus()
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(content.getAttribute('aria-hidden')).toBe('true')
    expect(content.inert).toBe(true)
    expect(document.activeElement).toBe(toggle)
    expect(screen.queryByRole('button', { name: 'Nova conversa' })).toBeNull()
    fireEvent.click(toggle)
    fireEvent.click(toggle)
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(content.inert).toBe(false)
    expect(screen.getByRole('button', { name: 'Nova conversa' })).toBeTruthy()
  })

  it('opens project actions without toggling the conversations', () => {
    renderProject()
    const toggle = screen.getByRole('button', { name: 'Exemplo' })
    fireEvent.click(screen.getByRole('button', { name: 'Ações do projeto: Exemplo' }))
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Renomear projeto')).toBeTruthy()
  })
})
