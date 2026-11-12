/** Compose the pane workspace through existing Session, Slot and keyboard services. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { Context } from '@deepseek-ai/cordis'
import type { ShortcutBinding, ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { Config } from '../../config.ts'
import { PaneController } from './controller.ts'
import { Pane, PaneControls, Panes } from './Panes.tsx'
import type { PanesInjected } from './Panes.tsx'
import type { PaneAxis } from './layout.ts'

/** Install one product-owned layout controller and its view registrations.
 * @param ctx - product Client context.
 * @param config - pane size constraints. */
export function installPanes(ctx: Context, config: Config): void {
  const form = ctx.configForms.get<Pick<Config, 'paneLayout' | 'minimalist'>>('ui-verboo')
  const saveError = createSnapshotStore(false)
  let pending: string | null = null
  let saving: Promise<void> | undefined
  const flush = (): Promise<void> => {
    if (form.getSnapshot().status !== 'ready') return Promise.resolve()
    saving ??= (async () => {
      while (pending !== null) {
        const value = pending
        pending = null
        try {
          if (!(await form.set('paneLayout', value))) throw new Error('Pane setting write was refused')
          saveError.set(false)
        } catch (error) {
          saveError.set(true)
          console.error('Verboo: pane layout could not be saved', error)
        }
      }
    })().finally(() => {
      saving = undefined
    })
    return saving
  }
  const controller = new PaneController(
    ctx.sessions,
    {
      open: (id) => {
        ctx.layout.beginNavigation()
        ctx.uiWorkspace.openSession(id)
      },
      workspace: id => ctx.workspaces.list.getSnapshot().items.find(w => w.sessionIds.includes(id))?.workspaceId,
    },
    {
      initial: undefined,
      save: (layout) => {
        pending = JSON.stringify(layout)
        void flush()
      },
    },
  )
  const restore = () => {
    if (form.getSnapshot().status !== 'ready' || !controller.state.getSnapshot().restoring) return
    let value: unknown = null
    const saved = form.getSnapshot().value?.paneLayout ?? ''
    try {
      value = JSON.parse(saved || 'null')
    } catch (error) {
      console.error('Verboo: invalid saved pane layout', error)
    }
    controller.restore(value)
  }
  ctx.effect(() => {
    const off = form.subscribe(() => {
      restore()
      if (pending !== null && form.getSnapshot().status === 'ready') void flush()
    })
    restore()
    return async () => {
      off()
      controller.dispose()
      await flush()
    }
  }, 'Verboo: pane references')
  const split = (id: string, axis: PaneAxis) => {
    const element = [...document.querySelectorAll<HTMLElement>('[data-pane-id]')].find(el => el.dataset.paneId === id)
    if (element === undefined) return
    if (
      axis === 'x'
        ? element.clientWidth < config.minimumPaneWidth * 2
        : element.clientHeight < config.minimumPaneHeight * 2
    )
      return
    controller.split(id, axis)
  }
  ctx.effect(() => {
    const closePane = () => {
      if (ctx.layout.panelInfo.getSnapshot().activePanelId === null)
        controller.close(controller.focused().id)
    }
    window.addEventListener('verboo-close-pane', closePane)
    return () => { window.removeEventListener('verboo-close-pane', closePane) }
  }, 'Verboo: native close-pane command')
  const face = (): PanesInjected => ({
    hooks: { panes: controller.state, paneSaveError: saveError, panePreferences: form },
    minimumWidth: config.minimumPaneWidth,
    minimumHeight: config.minimumPaneHeight,
    focusPane: (id) => {
      controller.focus(id)
    },
    focusPaneInput: (id) => {
      controller.focusInput(id)
    },
    focusComposer: (id) => {
      const reference = controller.state.getSnapshot().references.get(id)
      if (reference !== undefined) ctx.conversation.input.for(reference.binding.ctx).focus()
    },
    paneFocusTarget: (ownerId) => {
      const focused = controller.focused().id
      const element = [...document.querySelectorAll<HTMLElement>('[data-pane-id]')].find(
        el => el.dataset.paneId === focused,
      )
      if (element === undefined) return null
      return (
        (focused === ownerId ? undefined : element.querySelector<HTMLElement>('[contenteditable=true], input')) ??
        element.querySelector<HTMLElement>('[data-conversation-selector]')
      )
    },
    splitPane: split,
    closePane: (id) => {
      controller.close(id)
    },
    resizePane: (id, ratio, persist) => {
      controller.resize(id, ratio, persist)
    },
    savePanes: () => {
      controller.save()
    },
    choosePane: (id) => {
      controller.choose(id)
    },
    selectConversation: (id, sessionId) => {
      controller.select(id, sessionId)
    },
    createConversation: (id, workspaceId) => controller.create(id, workspaceId),
  })
  ctx.slots.inject('main', function* () {
    yield ctx.slots.register(
      {
        name: 'main',
        key: 'conversation',
        priority: -100,
        locale: 'verboo',
        inject: face,
        children: { 'verboo.pane': { kind: 'single', scope: 'session-maybe' } },
      },
      Panes,
    )
    yield ctx.slots.register(
      {
        name: 'verboo.pane',
        locale: 'verboo',
        inject: face,
      },
      Pane,
    )
  })
  ctx.slots.inject('conversation.session.header.utilities', () =>
    ctx.slots.register(
      {
        name: 'conversation.session.header.utilities',
        id: 'verboo.panes',
        locale: 'verboo',
        order: 100,
        inject: face,
      },
      PaneControls,
    ),
  )
  // Existing native chrome and sidebar toggle continue to own opening/closing.
  if (window.innerWidth >= 1024) ctx.layout.toggleSidebar()
  const commands: Array<{
    id: string
    label: 'paneSplitRight' | 'paneSplitDown' | 'paneFocusLeft' | 'paneFocusRight' | 'paneFocusUp' | 'paneFocusDown' | 'paneClose'
    binding: ShortcutBinding
    keys: string[]
    run(): void
  }> = [
    {
      id: 'close',
      label: 'paneClose',
      binding: { code: 'KeyW', modifiers: ['primary'] },
      keys: ['W'],
      run: () => { controller.close(controller.focused().id) },
    },
    {
      id: 'split-right',
      label: 'paneSplitRight',
      binding: { code: 'KeyD', modifiers: ['primary'] },
      keys: ['D'],
      run: () => {
        split(controller.focused().id, 'x')
      },
    },
    {
      id: 'split-down',
      label: 'paneSplitDown',
      binding: { code: 'KeyD', modifiers: ['primary', 'shift'] },
      keys: ['Shift', 'D'],
      run: () => {
        split(controller.focused().id, 'y')
      },
    },
    ...(['left', 'right', 'up', 'down'] as const).map(direction => ({
      id: `focus-${direction}`,
      label: ({ left: 'paneFocusLeft', right: 'paneFocusRight', up: 'paneFocusUp', down: 'paneFocusDown' } as const)[
        direction
      ],
      binding: {
        code: `Arrow${direction.slice(0, 1).toUpperCase()}${direction.slice(1)}`,
        modifiers: ['primary', 'alt'] as const,
      },
      keys: ['Alt', ({ left: '←', right: '→', up: '↑', down: '↓' } as const)[direction]],
      run: () => {
        controller.move(direction)
      },
    })),
  ]
  ctx.effect(function* () {
    const primary = ctx.shortcuts.platform === 'macos' ? '⌘' : 'Ctrl'
    for (const command of commands)
      yield ctx.shortcuts.registerFixed({
        id: `verboo.panes.${command.id}` as ShortcutCommandId,
        label: () => ctx.locale.bind('verboo')(command.label),
        keys: [primary, ...command.keys],
        bindings: [command.binding],
        group: 'application',
      })
    yield ctx.shortcuts.observeFixedInput((input) => {
      if (
        input.type !== 'keydown' ||
        input.context.modal !== null ||
        ctx.layout.panelInfo.getSnapshot().activePanelId !== null
      )
        return
      const g = input.gesture
      if (g.composing || g.defaultPrevented) return
      const mac = ctx.shortcuts.platform === 'macos'
      if (mac ? !g.meta || g.control : !g.control || g.meta) return
      const command = commands.find(
        c =>
          c.binding.code === g.code &&
          c.binding.modifiers.includes('shift') === g.shift &&
          c.binding.modifiers.includes('alt') === g.alt,
      )
      if (command === undefined) return
      input.consume()
      if (!g.repeat) command.run()
    })
  }, 'Verboo: pane keyboard navigation')
}
