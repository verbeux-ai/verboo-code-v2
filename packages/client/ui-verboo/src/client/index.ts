/** Product composition uses the Harness's public services and typed slots. */
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type {} from '@deepseek-ai/dsh-api-remote-access/client'
import type {} from '@deepseek-ai/dsh-client-resources/client'
import type {
  AccountView,
  AccountClientMetadata,
} from '@deepseek-ai/dsh-deepseek-account/types'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-context-menu/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ProductInjected, PreferenceSnapshot } from './contracts.ts'
import { en, pt, zh } from './locales.ts'
import { Config } from '../config.ts'
export { Config } from '../config.ts'
import { ExternalNavigation, ExternalNavigationError } from './navigation.ts'
import { ProductModel } from './model.ts'
import { createStaminaResource } from './stamina-resource.ts'
import { StaminaDock } from './Stamina.tsx'
import { ExecutionStatus } from './Execution.tsx'
import { tokens, icons } from './theme.ts'
import { Sidebar, Leading, PanelIcon } from './Sidebar.tsx'
import { Onboarding } from './Onboarding.tsx'
import { Hero, RunningIndicator } from './Hero.tsx'
import { BrandMark } from './Brand.tsx'
import { PlanPage } from './Plans.tsx'
import {
  ConnectionsPage,
  PreferencesPage,
  Feedback,
} from './Pages.tsx'

/** Product replacement for optional diagnostic readouts. */
function OmittedDiagnostic() { return null }

declare global {
  var __VERBOO_DESKTOP__:
    | { framework: 'tauri'; openExternal(url: string): Promise<void> }
    | undefined
}
export const inject = [
  'slots',
  'layout',
  'uiWorkspace',
  'workspaces',
  'locale',
  'theme',
  'shortcuts',
  'remote',
  'remote.account',
  'remote.session',
  'remote.verboo',
  'resources',
  'remoteAccess',
  'contextMenus',
  'connection',
]
/**
 * Install product UI without changing the engine, Session persistence or chat transport.
 * @param ctx - product-scoped Client context.
 */
export function apply(ctx: Context, config: Config = Config({})): void {
  ctx.effect(
    () => ctx.locale.register('verboo', { en, pt, zh }),
    'Verboo: dictionaries',
  )
  ctx.effect(
    () => ctx.theme.overrideTokens('verboo-code', tokens),
    'Verboo: palette',
  )
  ctx.effect(
    () => ctx.theme.overrideIcons('verboo-code', icons),
    'Verboo: icon family',
  )
  const navigationEntries = createSnapshotStore<
    readonly { id: MainPanelId; label: string }[]
  >([])
  ctx.slots.inject('sidebar.panellist', () => {
    const sync = () =>{
      navigationEntries.set(
        ctx.slots
          .entriesOfSlot('sidebar.panellist')
          .map(({ options }) => ({
            id: options.id as MainPanelId,
            label: resolveSlotLabel(options.label) ?? options.id ?? '',
          })),
      ) }
    sync()
    const off = ctx.slots.subscribe('sidebar.panellist', sync)
    const localeOff = ctx.locale.subscribe(sync)
    return () => {
      off()
      localeOff()
      navigationEntries.set([])
    }
  })
  const preferenceValue = (): PreferenceSnapshot => ({
    theme: ctx.theme.getTheme().preference,
    locale: ctx.locale.getLocale().active,
    languages: ctx.locale
      .getLocale()
      .locales.map(l => ({ id: l.id, label: l.label })),
  })
  const preferences = createSnapshotStore(preferenceValue())
  ctx.on('theme/change', () =>{  preferences.set(preferenceValue()) })
  ctx.on('locale/change', () =>{  preferences.set(preferenceValue()) })
  const metadata = (): AccountClientMetadata => ({
    version: process.env.DSH_CLIENT_VERSION ?? 'development',
    locale: ctx.locale.getLocale().active,
    timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
  })
  const navigation = new ExternalNavigation(
    () => globalThis.__VERBOO_DESKTOP__,
    () => window.open('about:blank', '_blank'),
  )
  const open = (url: string) => navigation.open(url)
  ctx.effect(() => () =>{  navigation.release() }, 'Verboo: browser reservations')
  const model = new ProductModel(
    {
      profile: async () => {
        const r = await ctx.remote.account.getProfile(metadata())
        if (!r.ok || r.value?.status !== 'ready') return null
        return r.value.value
      },
      start: async () => {
        const r = await ctx.remote.account.startSignIn(
          metadata(),
          location.origin,
          globalThis.__VERBOO_DESKTOP__ ? 'desktop' : 'web',
        )
        if (!r.ok) throw new Error('sign_in_failed')
        return r.value
      },
      cancel: async (id) => {
        const r = await ctx.remote.account.cancelSignIn(id)
        if (!r.ok) throw new Error('cancel_failed')
        return r.value
      },
      signOut: async () => {
        const r = await ctx.remote.account.signOut(metadata())
        if (!r.ok) throw new Error('sign_out_failed')
        return r.value
      },
      plans: async () => {
        const r = await ctx.remote.verboo.getPlans()
        return r.ok ? r.value : { ok: false, code: 'request_failed' }
      },
      connections: async () => {
        const r = await ctx.remote.verboo.getConnections()
        return r.ok ? r.value : { ok: false, code: 'request_failed' }
      },
      connect: async (slug, label) => {
        const r = await ctx.remote.verboo.connect(slug, label)
        return r.ok ? r.value : { ok: false, code: 'request_failed' }
      },
      disconnect: async (id) => {
        const r = await ctx.remote.verboo.disconnect(id)
        return r.ok ? r.value : { ok: false, code: 'request_failed' }
      },
      billing: async (id, purchase) => {
        const r = await ctx.remote.verboo.billingURL(id, purchase)
        return r.ok ? r.value : { ok: false, code: 'request_failed' }
      },
      open,
      initializeModel: async () => {
        const result = await ctx.remote.session.initializeDefaultModel()
        return result.ok
      },
    },
    config.handoffTimeoutMs,
  )
  ctx.effect(() => () =>{  model.dispose() }, 'Verboo: presenter lifetime')
  const stamina = createStaminaResource(
    signal => ctx.remote.verboo.getStamina(signal),
    model.state,
    config.staminaRefreshIntervalMs,
  )
  ctx.effect(() => ctx.resources.register(stamina.provider), 'Verboo: account stamina')
  const face = (): ProductInjected => ({
    hooks: { product: model.state, preferences, navigation: navigationEntries },
    refreshStamina: () => { stamina.refresh() },
    start: () => {
      try {
        navigation.reserve()
        void model.start().then(() => {
          if (model.state.getSnapshot().actionFailed) navigation.release()
        })
      } catch (error) {
        if (error instanceof ExternalNavigationError)
          model.reportNavigationFailure(true)
        else model.reportActionFailure()
      }
    },
    reopen: () => {
      void model.reopen()
    },
    cancel: () => {
      void model.cancel()
    },
    retryAccount: () => {
      void (async () => {
        if (model.state.getSnapshot().view === null) {
          const r = await ctx.remote.account.getState()
          if (!r.ok) {
            model.failAccount()
            return
          }
          model.adopt(r.value)
        } else await model.refreshProfile()
      })().catch(() =>{  model.failAccount() })
    },
    signOut: () => model.signOut(),
    startSession: () =>{  ctx.uiWorkspace.startSession() },
    openSession: (id) =>{  ctx.uiWorkspace.openSession(id) },
    openWorkspace: (id) => {
      void ctx.uiWorkspace.openWorkspace(id)
    },
    addProject: async () => {
      const picker = globalThis as typeof globalThis & {
        __DSH_DIRECTORY_PICKER__?: { pick(): Promise<string | null> }
      }
      const path = picker.__DSH_DIRECTORY_PICKER__
        ? await picker.__DSH_DIRECTORY_PICKER__.pick()
        : await ctx.uiWorkspace.pickDirectory()
      if (path === null) return
      const workspace = await ctx.workspaces.create({ path })
      await ctx.uiWorkspace.openWorkspace(workspace.workspaceId)
    },
    renameProject: async (id, title) => {
      await ctx.workspaces.rename(id, title)
    },
    removeProject: async (id) => {
      await ctx.workspaces.delete(id)
    },
    sessionMenu: (id, title, point) =>{
      ctx.contextMenus.open(
        { kind: 'session', value: { sessionId: id, displayTitle: title } },
        point,
      ) },
    selectPanel: (id) => {
      model.dismiss()
      ctx.layout.selectPanel(id)
    },
    toggleSidebar: () =>{  ctx.layout.toggleSidebar() },
    loadPlans: () => {
      void model.loadPlans()
    },
    loadConnections: () => {
      void model.loadConnections()
    },
    connect: async (slug, label) => {
      try {
        if (model.state.getSnapshot().busy !== null) return false
        navigation.reserve()
        return await model.connect(slug, label)
      } catch (error) {
        if (error instanceof ExternalNavigationError)
          model.reportNavigationFailure(true)
        else model.reportActionFailure()
        return false
      } finally {
        navigation.release()
      }
    },
    disconnect: id => model.disconnect(id),
    reopenConnection: (id) => {
      void model.reopenConnection(id)
    },
    billing: (id, purchase) => {
      try {
        if (model.state.getSnapshot().busy !== null) return
        navigation.reserve()
        void model.billing(id, purchase).finally(() =>{  navigation.release() })
      } catch (error) {
        if (error instanceof ExternalNavigationError)
          model.reportNavigationFailure(true)
        else model.reportActionFailure()
      }
    },
    dismiss: () =>{  model.dismiss() },
    setTheme: (theme) =>{  ctx.theme.setTheme(theme) },
    setLocale: (locale) =>{  ctx.locale.setLocale(locale) },
    retryModel: () => {
      void model.initializeModel()
    },
    help: () => {
      void open('https://code.verboo.ai/pt/docs').catch(() =>{
        model.reportActionFailure() },
      )
    },
  })
  ctx.remoteAccess.whenAccess('account/watch', function* () {
    const stream = ctx.remote.$stream<AccountView>({
      name: 'verboo-account',
      open: signal => ctx.remote.account.watch(signal),
      ended: () => new Error('account_stream_ended'),
    })
    const reader = { ended: false }
    yield () => {
      reader.ended = true
      model.reset()
      return stream.dispose()
    }
    void (async () => {
      for await (const frame of stream) {
        if (reader.ended) return
        const was = model.state.getSnapshot().view
        model.adopt(frame.value)
        frame.accept()
        if (
          frame.value.attempt &&
          ['cancelled', 'expired', 'failed', 'succeeded'].includes(
            frame.value.attempt.phase,
          )
        )
          navigation.release()
        if (
          frame.value.status === 'credential-stored' &&
          frame.value.attempt?.phase === 'succeeded' &&
          was?.attempt?.phase !== 'succeeded'
        )
          void model.initializeModel()
      }
    })().catch(() => {
      if (!reader.ended) model.failAccount()
    })
  })
  ctx.slots.inject('sidebar', () =>
    ctx.slots.register(
      { name: 'sidebar', locale: 'verboo', inject: () => {
        const product = face()
        return { ...product, hooks: { ...product.hooks, executionConnection: (ctx.get('connection') as ConnectionHandle).state } }
      } },
      Sidebar,
    ),
  )
  ctx.effect(
    () =>
      ctx.slots.registerFactory(
        {
          name: 'sidebar.panel.icon',
          scope: 'root',
          children: { 'sidebar.panellist': { kind: 'list', scope: 'root' } },
        },
        PanelIcon,
      ),
    'Verboo: panel icon extension',
  )
  ctx.slots.inject('shell.leading', () =>
    ctx.slots.register(
      { name: 'shell.leading', locale: 'verboo', inject: face },
      Leading,
    ),
  )
  ctx.slots.inject('shell.overlay', function* () {
    yield ctx.slots.register(
      {
        name: 'shell.overlay',
        id: 'verboo.onboarding',
        order: 100,
        locale: 'verboo',
        inject: face,
      },
      Onboarding,
    )
    yield ctx.slots.register(
      {
        name: 'shell.overlay',
        id: 'verboo.feedback',
        order: 110,
        locale: 'verboo',
        inject: face,
      },
      Feedback,
    )
  })
  ctx.slots.inject('conversation.hero.intro', () =>
    ctx.slots.register(
      { name: 'conversation.hero.intro', locale: 'verboo', inject: face },
      Hero,
    ),
  )
  ctx.slots.inject('conversation.chat.running.indicator', () =>
    ctx.slots.register(
      { name: 'conversation.chat.running.indicator' },
      RunningIndicator,
    ),
  )
  ctx.slots.inject('conversation.chat.assistant.mark', () =>
    ctx.slots.register({ name: 'conversation.chat.assistant.mark' }, BrandMark),
  )
  ctx.slots.inject('conversation.input.context', () =>
    ctx.slots.register({ name: 'conversation.input.context' }, OmittedDiagnostic),
  )
  ctx.slots.inject('conversation.composer.dock', function* () {
    for (const id of ['activity', 'usage']) {
      yield ctx.slots.register({ name: 'conversation.composer.dock', id, priority: -100 }, OmittedDiagnostic)
    }
  })
  ctx.slots.inject('conversation.composer.dock', () =>
    ctx.slots.register(
      { name: 'conversation.composer.dock', id: 'verboo.execution', order: -10, locale: 'verboo', inject: () => ({ hooks: { executionConnection: (ctx.get('connection') as ConnectionHandle).state } }) },
      ExecutionStatus,
    ),
  )
  ctx.slots.inject('conversation.composer.dock', () =>
    ctx.slots.register(
      { name: 'conversation.composer.dock', id: 'verboo.stamina', order: 10, locale: 'verboo', inject: face },
      StaminaDock,
    ),
  )
  ctx.slots.inject('main', function* () {
    yield ctx.slots.register(
      {
        name: 'main',
        key: 'verboo.connections',
        locale: 'verboo',
        inject: face,
      },
      ConnectionsPage,
    )
    yield ctx.slots.register(
      { name: 'main', key: 'verboo.plan', locale: 'verboo', inject: face },
      PlanPage,
    )
    yield ctx.slots.register(
      {
        name: 'main',
        key: 'verboo.preferences',
        locale: 'verboo',
        inject: face,
      },
      PreferencesPage,
    )
  })
  ctx.effect(
    () =>
      ctx.shortcuts.register({
        id: 'verboo.preferences' as ShortcutCommandId,
        label: () => ctx.locale.bind('verboo')('preferences'),
        aliases: ['preferences', 'settings'],
        defaults: {
          'desktop:macos': { code: 'Comma', modifiers: ['primary'] },
          'desktop:windows': { code: 'Comma', modifiers: ['primary'] },
          'desktop:linux': { code: 'Comma', modifiers: ['primary'] },
          'web:macos': { code: 'Comma', modifiers: ['primary', 'alt'] },
        },
        regions: ['page', 'editable', 'terminal'],
        modals: [],
        resolve: ({ modal }) =>
          modal !== null
            ? { status: 'blocked', reason: 'modal' }
            : {
              status: 'handled',
              run: () =>{
                ctx.layout.selectPanel('verboo.preferences' as MainPanelId) },
            },
      }),
    'Verboo: preferences shortcut',
  )
  // One read in flight per resource; background/hidden/offline windows do not poll.
  ctx.effect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = () => {
      if (stopped) return
      const state = model.state.getSnapshot()
      if (
        document.visibilityState === 'visible' &&
        navigator.onLine &&
        state.profile &&
        model.shouldPoll(Date.now())
      ) {
        if (
          state.handoff === 'connection' ||
          state.connections?.accounts.some(a => a.status === 'pending')
        )
          void model.loadConnections()
        if (state.handoff === 'billing') void model.loadPlans()
      }
      timer = setTimeout(tick, config.refreshIntervalMs)
    }
    const resume = () => {
      if (document.visibilityState === 'visible' && navigator.onLine) {
        const state = model.state.getSnapshot()
        if (state.profile) {
          void model.loadPlans()
          void model.loadConnections()
        }
      }
    }
    window.addEventListener('focus', resume)
    window.addEventListener('online', resume)
    document.addEventListener('visibilitychange', resume)
    tick()
    return () => {
      stopped = true
      clearTimeout(timer)
      window.removeEventListener('focus', resume)
      window.removeEventListener('online', resume)
      document.removeEventListener('visibilitychange', resume)
    }
  }, 'Verboo: visible-window refresh')
}
