/** Product composition uses the Harness's public services and typed slots. */
// The Desktop bridge's global declaration is owned by the link service that routes through it.
import type {} from '@deepseek-ai/dsh-client-external-links/client'
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
import type { OpenAiStatus, ProductInjected, PreferenceSnapshot } from './contracts.ts'
import { en, pt, zh, ja, es, fr, de, ru } from './locales.ts'
import { Config } from '../config.ts'
import type {} from '@deepseek-ai/dsh-host-verboo-analytics/remote'
import type { ProductAnalyticsStatus, ProductFeature, ProductModelDetails } from '@deepseek-ai/dsh-host-verboo-analytics/types'
import { modelDimensions } from './model-dimensions.ts'
import { captureFeatureConsent, type FeatureConsent } from './feature-consent.ts'
export { Config } from '../config.ts'
import { ExternalNavigation, ExternalNavigationError } from './navigation.ts'
import { DesktopQuitHold } from './QuitHold.tsx'
import { ProductModel } from './model.ts'
import { TrialModel } from './trial-model.ts'
import { TrialDock, TrialModal, type TrialInjected } from './Trial.tsx'
import { createStaminaResource } from './stamina-resource.ts'
import { createSubscriptionUsageResource } from './subscription-usage-resource.ts'
import { StaminaButtonFill } from './StaminaLiquid.tsx'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { StaminaModelState } from './stamina-selection.ts'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type {} from '@deepseek-ai/dsh-client-ui-commands/client'
import { StaminaDebug, type StaminaDebugInjected } from './StaminaDebug.tsx'
import { SubscriptionUsage } from './SubscriptionUsage.tsx'
import { OpenAiSignInOverlay as OpenAiSignInDialog } from './OpenAiSignIn.tsx'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { ExecutionStatus } from './Execution.tsx'
import { tokens, icons } from './theme.ts'
import { Sidebar, Leading, PanelIcon } from './Sidebar.tsx'
import { Onboarding } from './Onboarding.tsx'
import { Hero, RunningIndicator } from './Hero.tsx'
import { AssistantMark } from './Brand.tsx'
import { PlanPage } from './Plans.tsx'
import { PreferencesPage, Feedback } from './Pages.tsx'
import { ConnectionsPage } from './Connections.tsx'
import { installPanes } from './panes/install.ts'
import { leaves } from './panes/layout.ts'
import { selectStaminaForModel } from './stamina-selection.ts'
import type { ConversationAppearanceInjected } from './ConversationAppearance.tsx'

/** Product replacement for optional diagnostic readouts. */
function OmittedDiagnostic() { return null }

export const inject = [
  'slots',
  'configForms',
  'modelDirectories',
  'commandUi',
  'layout',
  'uiWorkspace',
  'workspaces',
  'locale',
  'theme',
  'shortcuts',
  'remote',
  'remote.account',
  'remote.openaiAccountLogin',
  'remote.llmOpenaiAccount',
  'remote.session',
  'remote.verboo',
  'remote.verbooMcp',
  'remote.verbooAnalytics',
  'resources',
  'remoteAccess',
  'contextMenus',
  'connection',
  'sessions',
  'conversation',
  'uiConversation',
]
/**
 * Install product UI without changing the engine, Session persistence or chat transport.
 * @param ctx - product-scoped Client context.
 */
export function apply(ctx: Context, config: Config = Config({})): void {
  ctx.effect(
    () => ctx.locale.register('verboo', { en, pt, zh, ja, es, fr, de, ru }),
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
  const panes = installPanes(ctx, config, (axis) => {
    const consent = captureProductConsent()
    observeFeature(axis === 'x' ? 'pane_split_right' : 'pane_split_down', 'started', consent)
  })
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
  // Account handoffs reserve their destination inside the click and then open
  // the Host-issued URL; the product link service owns both steps.
  const navigation = new ExternalNavigation(() => ctx.get('externalLinks'))
  const open = (url: string) => navigation.open(url)
  ctx.effect(() => () =>{  navigation.release() }, 'Verboo: browser reservations')
  // Fixed categories only: never send a provider label, server name, or URL.
  const captureProductConsent = (): FeatureConsent | undefined => captureFeatureConsent(analyticsStatus.getSnapshot())
  const observeFeature = (feature: ProductFeature, outcome: 'started' | 'completed' | 'failed' | 'cancelled', consent: FeatureConsent | undefined, model?: ProductModelDetails): void => {
    if (!consent) return
    try {
      const request = ctx.remote.verbooAnalytics.feature(feature, outcome, consent.subjectId, consent.revision, consent.proof, model)
      void request.catch(() => {})
    } catch (_error) { /* Optional measurement cannot interrupt the product action. */ }
  }
  const trackFeatureOperation = async <T>(
    feature: 'mcp' | 'checkout', request: () => Promise<T>, completed: (value: T) => boolean, enabled = true,
  ): Promise<T> => {
    if (!enabled) return request()
    const owner = model.state.getSnapshot().profile?.id
    const consent = captureProductConsent()
    const revision = analyticsRevision
    if (!owner || !consent) return request()
    const sameOwner = () => owner === model.state.getSnapshot().profile?.id && revision === analyticsRevision
    try {
      const value = await request()
      if (sameOwner()) observeFeature(feature, completed(value) ? 'completed' : 'failed', consent)
      return value
    } catch (error) {
      if (sameOwner()) observeFeature(feature, 'failed', consent)
      throw error
    }
  }
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
        const r = await trackFeatureOperation('mcp', () => ctx.remote.verboo.connect(slug, label), result => result.ok && result.value.ok)
        return r.ok ? r.value : { ok: false, code: 'request_failed' }
      },
      disconnect: async (id) => {
        const r = await ctx.remote.verboo.disconnect(id)
        return r.ok ? r.value : { ok: false, code: 'request_failed' }
      },
      mcpServers: async () => {
        const r = await ctx.remote.verbooMcp.list()
        return r.ok ? r.value : { ok: false, code: 'contract_error' as const, message: r.error.message }
      },
      saveMcpServer: async (input) => {
        const r = await trackFeatureOperation('mcp', () => ctx.remote.verbooMcp.save(input), result => result.ok && result.value.ok)
        return r.ok ? r.value : { ok: false, code: 'contract_error' as const, message: r.error.message }
      },
      deleteMcpServer: async (name) => {
        const r = await ctx.remote.verbooMcp.removeServer(name)
        return r.ok ? r.value : { ok: false, code: 'contract_error' as const, message: r.error.message }
      },
      setMcpEnabled: async (name, enabled) => {
        const r = await ctx.remote.verbooMcp.setEnabled(name, enabled)
        return r.ok ? r.value : { ok: false, code: 'contract_error' as const, message: r.error.message }
      },
      signInMcpServer: async (name) => {
        const r = await ctx.remote.verbooMcp.signIn(name)
        return r.ok ? r.value : { ok: false, code: 'contract_error' as const, message: r.error.message }
      },
      setMcpToken: async (name, token) => {
        const r = await ctx.remote.verbooMcp.setToken(name, token)
        return r.ok ? r.value : { ok: false, code: 'contract_error' as const, message: r.error.message }
      },
      signOutMcpServer: async (name) => {
        const r = await ctx.remote.verbooMcp.signOut(name)
        return r.ok ? r.value : { ok: false, code: 'contract_error' as const, message: r.error.message }
      },
      probeMcpServer: async (input, signal) => {
        const r = await ctx.remote.verbooMcp.probe(input, signal)
        return r.ok ? r.value : { ok: false, code: 'contract_error' as const, message: r.error.message }
      },
      billing: async (id, purchase) => {
        const r = await trackFeatureOperation('checkout', () => ctx.remote.verboo.billingURL(id, purchase), result => result.ok && result.value.ok, purchase)
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
  let trialStorage: Storage | undefined
  try { trialStorage = globalThis.localStorage } catch { /* Reading remains available when storage is blocked. */ }
  const trial = new TrialModel({
    status: async (signal) => { const r = await ctx.remote.verboo.getTrialStatus(signal); return r.ok ? r.value : { ok: false, code: 'request_failed' } },
    offer: async (id, plan, method) => { const r = await ctx.remote.verboo.trialOffer(id, plan, method); return r.ok ? r.value : { ok: false, code: 'request_failed' } },
    confirm: async (id, method, request) => { const r = await ctx.remote.verboo.confirmTrialOffer(id, method, request); return r.ok ? r.value : { ok: false, code: 'request_failed' } },
    resume: async (id, trialId) => { const r = await ctx.remote.verboo.resumeTrialPayment(id, trialId); return r.ok ? r.value : { ok: false, code: 'request_failed' } },
    payment: async (id) => { const r = await ctx.remote.verboo.trialPaymentStatus(id); return r.ok ? r.value : { ok: false, code: 'request_failed' } },
    open, refreshPlans: () => { void model.loadPlans() },
  }, model.state, trialStorage)
  ctx.effect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = () => {
      trial.adopt()
      if (document.visibilityState !== 'visible' || !navigator.onLine) { trial.pause(); return }
      void trial.refresh()
    }
    const tick = () => {
      if (stopped) return
      refresh()
      timer = setTimeout(tick, config.refreshIntervalMs)
    }
    const stop = model.state.subscribe(refresh)
    document.addEventListener('visibilitychange', refresh)
    window.addEventListener('online', refresh)
    window.addEventListener('offline', refresh)
    window.addEventListener('focus', refresh)
    tick()
    return () => {
      stopped = true; clearTimeout(timer); stop(); trial.dispose()
      document.removeEventListener('visibilitychange', refresh)
      window.removeEventListener('online', refresh); window.removeEventListener('offline', refresh); window.removeEventListener('focus', refresh)
    }
  }, 'Verboo: trial attention')
  ctx.effect(() => {
    let selectedSession: SessionId | null = null
    let stopModel: (() => void) | undefined
    const sync = () => {
      const layout = panes.getSnapshot().layout
      const session = leaves(layout.root).find(pane => pane.id === layout.focused)?.sessionId ?? null
      if (session !== selectedSession) {
        stopModel?.()
        selectedSession = session
        stopModel = session === null ? undefined : ctx.modelDirectories.directoryFor(session).store.subscribe(sync)
      }
      const selected = session === null ? null : ctx.modelDirectories.directoryFor(session).store.getSnapshot().current
      const group = selectStaminaForModel(model.state.getSnapshot().plans, selected, undefined).group
      trial.selectGroup(group?.id ?? null)
    }
    const stopPanes = panes.subscribe(sync)
    const stopAccount = model.state.subscribe(sync)
    sync()
    return () => { stopPanes(); stopAccount(); stopModel?.() }
  }, 'Verboo: focused trial group')
  const stamina = createStaminaResource(
    signal => ctx.remote.verboo.getStamina(signal),
    model.state,
    config.staminaRefreshIntervalMs,
  )
  ctx.effect(() => ctx.resources.register(stamina.provider), 'Verboo: account stamina')
  const subscriptionUsage = createSubscriptionUsageResource(
    signal => ctx.remote.llmOpenaiAccount.usage(signal),
    model.state,
    config.staminaRefreshIntervalMs,
  )
  ctx.effect(() => ctx.resources.register(subscriptionUsage.provider), 'Verboo: subscription usage')
  // The Host serves the callback on its own loopback origin, so the reader never
  // copies a code between windows: the browser returns there and the exchange
  // finishes without leaving the dialog.
  const openAiCallbackUrl = (): string => `${location.origin}/auth/callback`
  const openAiSignIn = async (): Promise<{ url: string; handle: string } | undefined> => {
    try {
      const started = await ctx.remote.openaiAccountLogin.beginLogin(openAiCallbackUrl())
      if (!started.ok) return undefined
      await ctx.get('externalLinks')?.open(started.value.url)
      return started.value
    } catch (_error) { return undefined } // The dialog reports an unsuccessful start inline.
  }
  const completeOpenAiSignIn = async (handle: string): Promise<boolean> => {
    try {
      const finished = await ctx.remote.openaiAccountLogin.awaitLogin(handle)
      if (!finished.ok) return false
      externalStatus.set(finished.value)
      subscriptionUsage.refresh()
      // Which models this account serves is the provider's answer, not the
      // catalog's. The sweep spends one small request per model, so it runs in
      // the background and never holds the dialog open.
      void ctx.remote.llmOpenaiAccount.discoverModels().then(() => {
        // A finished sweep changes the menu, so the model directory re-reads it.
        void ctx.remote.session.initializeDefaultModel()
      }).catch(() => {
        // Discovery is an enhancement; a failed sweep leaves the catalog intact.
      })
      return true
    } catch (_error) { return false } // The dialog reports an unsuccessful exchange inline.
  }
  const openAiStatus = async (): Promise<OpenAiStatus> => {
    try {
      const status = await ctx.remote.openaiAccountLogin.status()
      return status.ok ? status.value : { signedIn: false }
    } catch (_error) { return { signedIn: false } } // An unreadable status reports no session.
  }
  const signOutOpenAi = async (): Promise<void> => {
    try { await ctx.remote.openaiAccountLogin.signOut() } catch (_error) {
      // A refused sign-out leaves the stored session in place; the dialog
      // re-reads the status, so the reader sees the session that remains.
      return
    }
    subscriptionUsage.refresh()
  }
  const externalStatus = createSnapshotStore<OpenAiStatus>({ signedIn: false })
  const analyticsStatus = createSnapshotStore<ProductAnalyticsStatus | null>(null)
  let analyticsOwner: string | undefined
  let analyticsRevision = 0
  let analyticsReading = false
  let analyticsDisposed = false
  const featureObserver = (feature: 'model_switch' | 'plan' | 'goal' | 'mcp' | 'checkout') => {
    const owner = model.state.getSnapshot().profile?.id
    const consent = captureProductConsent()
    const revision = analyticsRevision
    if (!owner || !consent) return undefined
    return (outcome: 'completed' | 'failed') => {
      if (!analyticsDisposed && owner === model.state.getSnapshot().profile?.id && revision === analyticsRevision) {
        observeFeature(feature, outcome, consent)
      }
    }
  }
  ctx.effect(() => ctx.modelDirectories.observeModelSwitch(() => featureObserver('model_switch')), 'Verboo: model switch analytics')
  ctx.effect(() => ctx.modelDirectories.observeModelChoices((selected) => {
    const owner = model.state.getSnapshot().profile?.id
    const consent = captureProductConsent()
    const revision = analyticsRevision
    const dimensions = modelDimensions(selected)
    if (!owner || !consent || !dimensions) return undefined
    return () => {
      if (!analyticsDisposed && owner === model.state.getSnapshot().profile?.id && revision === analyticsRevision) {
        observeFeature('model_choice', 'completed', consent, dimensions)
      }
    }
  }), 'Verboo: model choice analytics')
  ctx.effect(() => ctx.commandUi.observeFeatureCommands(featureObserver), 'Verboo: command feature analytics')
  ctx.effect(() => ctx.uiConversation.observeControlClicks((control) => {
    observeFeature(control, 'started', captureProductConsent())
  }), 'Verboo: conversation control analytics')
  ctx.effect(() => ctx.uiConversation.observeMessageSubmissions((feature, selected) => {
    const owner = model.state.getSnapshot().profile?.id
    const consent = captureProductConsent()
    const revision = analyticsRevision
    const dimensions = modelDimensions(selected)
    if (!owner || !consent) return undefined
    return () => {
      if (!analyticsDisposed && owner === model.state.getSnapshot().profile?.id && revision === analyticsRevision) {
        observeFeature(feature, 'started', consent, dimensions)
      }
    }
  }), 'Verboo: message submission analytics')
  const analyticsStateMatches = (revision: number): boolean => revision === analyticsRevision && !analyticsDisposed
  const refreshAnalytics = async (): Promise<void> => {
    const snapshot = model.state.getSnapshot()
    const owner = snapshot.profile?.id ?? undefined
    if (owner !== analyticsOwner) {
      analyticsOwner = owner
      analyticsRevision++
      analyticsStatus.set(null)
    }
    if (owner === undefined || analyticsReading || analyticsDisposed) return
    const revision = analyticsRevision
    analyticsReading = true
    try {
      const result = await ctx.remote.verbooAnalytics.status()
      if (analyticsStateMatches(revision)) analyticsStatus.set(result.ok ? result.value : null)
    } catch (_error) {
      if (analyticsStateMatches(revision)) analyticsStatus.set(null)
    } finally { analyticsReading = false }
  }
  ctx.effect(() => {
    const unsubscribe = model.state.subscribe(() => { void refreshAnalytics() })
    const timer = setInterval(() => { void refreshAnalytics() }, 15000)
    void refreshAnalytics()
    return () => { analyticsDisposed = true; analyticsRevision++; clearInterval(timer); unsubscribe() }
  }, 'Verboo: analytics status')
  ctx.effect(() => {
    const busyForm = ctx.configForms.get<{ busyEnter: 'queue' | 'steer' }>('ui-conversation')
    const appearanceForm = ctx.configForms.get<Pick<Config, 'minimalist'>>('ui-verboo')
    const toolsForm = ctx.configForms.get<{ enabled: boolean }>('ui-settings')
    const presetForm = ctx.configForms.get<{ selectedDefault: string }>('agent-preset-registry')
    const last = new Map<string, string>()
    const languages: Readonly<Record<string, ProductFeature>> = {
      en: 'preference_language_en', pt: 'preference_language_pt', zh: 'preference_language_zh', ja: 'preference_language_ja',
      es: 'preference_language_es', fr: 'preference_language_fr', de: 'preference_language_de', ru: 'preference_language_ru',
    }
    const themes: Readonly<Record<string, ProductFeature>> = {
      light: 'preference_theme_light', dark: 'preference_theme_dark', system: 'preference_theme_system',
    }
    const presets = new Map<string, ProductFeature>([
      ['cordis', 'preference_preset_cordis'], ['ptc', 'preference_preset_ptc'],
      ['minimal', 'preference_preset_minimal'], ['standard', 'preference_preset_standard'],
    ])
    const report = () => {
      const owner = model.state.getSnapshot().profile?.id
      const consent = captureProductConsent()
      if (!owner || !consent) return
      const emit = (dimension: string, feature: ProductFeature | undefined) => {
        if (feature === undefined) return
        const key = `${owner}:${consent.revision}:${feature}`
        if (last.get(dimension) === key) return
        last.set(dimension, key)
        observeFeature(feature, 'completed', consent)
      }
      const busy = busyForm.getSnapshot()
      if (busy.status === 'ready') {
        if (busy.value?.busyEnter === 'queue') emit('busy', 'preference_busy_queue')
        else if (busy.value?.busyEnter === 'steer') emit('busy', 'preference_busy_steer')
      }
      const appearance = appearanceForm.getSnapshot()
      if (appearance.status === 'ready' && typeof appearance.value?.minimalist === 'boolean') {
        emit('minimalist', appearance.value.minimalist ? 'preference_minimalist_on' : 'preference_minimalist_off')
      }
      const tools = toolsForm.getSnapshot()
      if (tools.status === 'ready' && typeof tools.value?.enabled === 'boolean') {
        emit('coding_tools', tools.value.enabled ? 'preference_coding_tools_on' : 'preference_coding_tools_off')
      }
      const preset = presetForm.getSnapshot()
      if (preset.status === 'ready' && typeof preset.value?.selectedDefault === 'string') {
        emit('preset', presets.get(preset.value.selectedDefault) ?? 'preference_preset_other')
      }
      const preference = preferences.getSnapshot()
      emit('theme', themes[preference.theme])
      emit('language', languages[preference.locale.toLowerCase().split('-')[0] ?? ''] ?? 'preference_language_other')
    }
    const unsubscribeBusy = busyForm.subscribe(report)
    const unsubscribeAppearance = appearanceForm.subscribe(report)
    const unsubscribeTools = toolsForm.subscribe(report)
    const unsubscribePreset = presetForm.subscribe(report)
    const unsubscribePreferences = preferences.subscribe(report)
    const unsubscribeStatus = analyticsStatus.subscribe(report)
    const unsubscribeModel = model.state.subscribe(report)
    report()
    return () => {
      unsubscribeBusy(); unsubscribeAppearance(); unsubscribeTools(); unsubscribePreset()
      unsubscribePreferences(); unsubscribeStatus(); unsubscribeModel()
    }
  }, 'Verboo: preference analytics')
  const externalDialogOpen = createSnapshotStore({ open: false })
  const reloadExternalStatus = async (): Promise<void> => {
    externalStatus.set(await openAiStatus())
  }
  const face = (): ProductInjected => ({
    hooks: { product: model.state, preferences, navigation: navigationEntries, externalStatus },
    refreshStamina: () => { stamina.refresh() },
    beginOpenAiSignIn: openAiSignIn,
    completeOpenAiSignIn,
    openAiStatus,
    signOutOpenAi,
    refreshSubscriptionUsage: () => { subscriptionUsage.refresh() },
    openOpenAiDialog: () => {
      externalDialogOpen.set({ open: true })
      void reloadExternalStatus()
    },
    closeOpenAiDialog: () => { externalDialogOpen.set({ open: false }) },
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
      const consent = captureProductConsent()
      observeFeature('project_add', 'started', consent)
      const picker = globalThis as typeof globalThis & {
        __DSH_DIRECTORY_PICKER__?: { pick(): Promise<string | null> }
      }
      let created = false
      try {
        const path = picker.__DSH_DIRECTORY_PICKER__
          ? await picker.__DSH_DIRECTORY_PICKER__.pick()
          : await ctx.uiWorkspace.pickDirectory()
        if (path === null) { observeFeature('project_add', 'cancelled', consent); return }
        const workspace = await ctx.workspaces.create({ path })
        created = true
        observeFeature('project_add', 'completed', consent)
        await ctx.uiWorkspace.openWorkspace(workspace.workspaceId)
      } catch (error) {
        if (!created) observeFeature('project_add', 'failed', consent)
        throw error
      }
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
    loadMcpServers: () => {
      void model.loadMcpServers()
    },
    saveMcpServer: input => model.saveMcpServer(input),
    deleteMcpServer: name => model.deleteMcpServer(name),
    setMcpEnabled: (name, enabled) => model.setMcpEnabled(name, enabled),
    probeMcpServer: input => model.probeMcpServer(input),
    signInMcpServer: name => model.signInMcpServer(name),
    setMcpToken: (name, token) => model.setMcpToken(name, token),
    signOutMcpServer: name => model.signOutMcpServer(name),
    clearMcpProbe: () =>{  model.clearMcpProbe() },
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
  const noStaminaModel = createSnapshotStore<StaminaModelState>({ current: null })
  const trialFace = (): ProductInjected & TrialInjected => {
    const product = face()
    return { ...product, hooks: { ...product.hooks, trial: trial.state },
      selectTrialGroup: (group) => { trial.selectGroup(group) },
      showTrial: () => { trial.show() }, closeTrial: () => { trial.close() },
      quoteTrial: (id, method) => { void trial.quote(id, method) },
      confirmTrial: (method) => {
        try {
          navigation.reserve()
          void trial.confirm(method).finally(() => { navigation.release() })
        } catch { model.reportNavigationFailure(true) }
      },
      refreshTrial: () => { void trial.refresh() },
      reopenTrial: () => {
        try {
          navigation.reserve()
          void trial.reopen().finally(() => { navigation.release() })
        } catch { model.reportNavigationFailure(true) }
      },
    }
  }
  const trialDockFace = (sessionId?: SessionId) => {
    const product = trialFace()
    const staminaModel = sessionId === undefined ? noStaminaModel : ctx.modelDirectories.directoryFor(sessionId).store
    return { ...product, hooks: { ...product.hooks, staminaModel } }
  }
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      { name: 'shell.overlay', id: 'verboo.trial', order: 105, locale: 'verboo', inject: trialFace },
      TrialModal,
    ),
  )
  ctx.slots.inject('conversation.composer.dock', () =>
    ctx.slots.register(
      { name: 'conversation.composer.dock', id: 'verboo.trial-notice', order: -20, locale: 'verboo', inject: trialDockFace },
      TrialDock,
    ),
  )
  const staminaFace = (sessionId?: SessionId) => {
    const product = face()
    const staminaModel = sessionId === undefined ? noStaminaModel : ctx.modelDirectories.directoryFor(sessionId).store
    return { ...product, hooks: { ...product.hooks, staminaModel } }
  }
  const debugConfig = ctx.configForms.get<Pick<Config, 'staminaDebug'>>('ui-verboo')
  const debugActions: StaminaDebugInjected = {
    hooks: { staminaDebug: debugConfig },
    refreshStamina: () => { stamina.refresh() },
    async setStaminaDebug(enabled) {
      try { return await debugConfig.set('staminaDebug', enabled) }
      catch (_error) { return false } // The toggle reports an unsuccessful Host write inline.
    },
  }
  const debugFace = (sessionId?: SessionId) => {
    const product = staminaFace(sessionId)
    return { ...product, ...debugActions, ...appearanceActions,
      hooks: { ...product.hooks, ...debugActions.hooks, ...appearanceActions.hooks } }
  }
  // The pill reads the external subscription's own record; a Verboo route
  // leaves it absent, so the dock never shows a borrowed number.
  const subscriptionUsageFace = (sessionId?: SessionId) => {
    const product = staminaFace(sessionId)
    return {
      ...product,
      hooks: { ...product.hooks, subscriptionUsageAddress: model.state },
    }
  }
  const appearanceConfig = ctx.configForms.get<Pick<Config, 'minimalist'>>('ui-verboo')
  const appearanceActions: ConversationAppearanceInjected = {
    hooks: { conversationAppearance: appearanceConfig },
    async setMinimalist(enabled) {
      try { return await appearanceConfig.set('minimalist', enabled) }
      catch (_error) { return false } // The preference reports an unsuccessful write inline.
    },
  }
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
      { name: 'sidebar', locale: 'verboo',
        // The product footer seat: rows such as the desktop update indicator
        // sit above the plan shortcut.
        children: { 'sidebar.footer.row': { kind: 'single', scope: 'root' } },
        inject: () => {
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
        name: 'shell.overlay', id: 'verboo.openai-signin', order: 130, locale: 'verboo',
        inject: () => {
          const product = face()
          return {
            ...product,
            hooks: { ...product.hooks, externalDialogOpen },
            openAiSignIn: {
              begin: product.beginOpenAiSignIn.bind(product),
              complete: product.completeOpenAiSignIn.bind(product),
              signOut: product.signOutOpenAi.bind(product),
              close: product.closeOpenAiDialog.bind(product),
            },
          }
        },
      },
      OpenAiSignInDialog,
    )
    yield ctx.slots.register({ name: 'shell.overlay', id: 'verboo.quit-hold', order: 120, locale: 'verboo' }, DesktopQuitHold)
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
    ctx.slots.register({ name: 'conversation.chat.assistant.mark' }, AssistantMark),
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
  ctx.slots.inject('conversation.input.primary.background', () =>
    ctx.slots.register(
      { name: 'conversation.input.primary.background', locale: 'verboo', inject: staminaFace },
      StaminaButtonFill,
    ),
  )
  ctx.slots.inject('conversation.composer.dock', () =>
    ctx.slots.register(
      {
        name: 'conversation.composer.dock', id: 'verboo.stamina-debug', order: 20, locale: 'verboo',
        inject: debugFace,
      },
      StaminaDebug,
    ),
  )
  // The external subscription's reading stays absent until it has something to
  // say, so the dock keeps its resting height on a healthy window.
  ctx.slots.inject('conversation.composer.dock', () =>
    ctx.slots.register(
      {
        name: 'conversation.composer.dock', id: 'verboo.subscription-usage', order: 10, locale: 'verboo',
        inject: subscriptionUsageFace,
      },
      SubscriptionUsage,
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
        inject: debugFace,
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
        if (
          state.mcpServers?.some(
            server =>
              server.status.state === 'connecting' ||
              server.status.state === 'reconnecting',
          ) === true
        )
          void model.loadMcpServers()
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
