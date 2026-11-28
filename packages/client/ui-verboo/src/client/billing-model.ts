/** Account-scoped state for checkout and subscription management in Plans. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type {
  BillingInterval, BillingQuoteId, BillingSubscriptionId, EmbeddedCardSetup, Plan, PlanChangeId, PlanChangeProgress,
  PlanChangeQuote, PlanId, PurchaseAttemptId, PurchaseProgress, PurchaseQuote, PurchaseRecommendation,
  Result, Subscription, SubscriptionCancellation, SubscriptionCardUpdate, SubscriptionInvoice, SubscriptionLifecycleProgress,
} from '@deepseek-ai/dsh-api-verboo-product/types'
import type { ProductSnapshot } from './model.ts'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { Key } from './locales.ts'

/** Remote calls owned by the account currently presented in Plans. */
export interface BillingApi {
  options(plan: PlanId, interval: BillingInterval): Promise<Result<PurchaseRecommendation>>
  quote(plan: PlanId, interval: BillingInterval): Promise<Result<PurchaseQuote>>
  confirm(quote: BillingQuoteId): Promise<Result<PurchaseProgress>>
  current(signal: AbortSignal): Promise<Result<PurchaseProgress | null>>
  retry(id: PurchaseAttemptId): Promise<Result<PurchaseProgress>>
  abandon(id: PurchaseAttemptId): Promise<Result<PurchaseProgress>>
  terms(): Promise<Result<string>>
  reopen(id: PurchaseAttemptId): Promise<Result<string>>
  dismiss(id: PurchaseAttemptId): Promise<Result<boolean>>
  quoteChange(
    subscription: BillingSubscriptionId, plan: PlanId, interval: BillingInterval, removeTier: boolean,
  ): Promise<Result<PlanChangeQuote>>
  confirmChange(quote: BillingQuoteId): Promise<Result<PlanChangeProgress>>
  currentChange(id: BillingSubscriptionId, signal: AbortSignal): Promise<Result<PlanChangeProgress | null>>
  changeStatus(id: PlanChangeId, signal: AbortSignal): Promise<Result<PlanChangeProgress>>
  update(subscription: BillingSubscriptionId, action: LifecycleAction): Promise<Result<SubscriptionLifecycleProgress>>
  currentLifecycle(
    subscription: BillingSubscriptionId, signal: AbortSignal, checkCancellation: boolean,
  ): Promise<Result<SubscriptionLifecycleProgress | null>>
  invoices(subscription: BillingSubscriptionId): Promise<Result<SubscriptionInvoice[]>>
  portal(subscription: BillingSubscriptionId): Promise<Result<string>>
  startCardUpdate(subscription: BillingSubscriptionId, requestId: string, embedded: boolean): Promise<Result<SubscriptionCardUpdate>>
  currentCardUpdate(subscription: BillingSubscriptionId, signal: AbortSignal): Promise<Result<SubscriptionCardUpdate | null>>
  openCardSetup?(this: void, operation: string, setup: EmbeddedCardSetup, labels: CardSetupLabels, signal: AbortSignal): Promise<boolean>
  open(url: string): Promise<void>
  refreshPlans(): Promise<void>
}

/** An explicit action on an existing subscription. */
export type LifecycleAction = 'cancel' | 'reactivate'
/** Localized labels for the native card setup window. */
export interface CardSetupLabels {
  title: string
  description: string
  close: string
  loading: string
  failed: string
}

/** Data rendered by the checkout and subscription management UI. */
export interface BillingState {
  selectedPlan: Plan | null
  recommendation: PurchaseRecommendation | null
  offer: PurchaseQuote | null
  purchase: PurchaseProgress | null
  selectedSubscription: string | null
  reviewingChange?: boolean
  changeOffer: PlanChangeQuote | null
  change: PlanChangeProgress | null
  invoices: SubscriptionInvoice[] | null
  lifecycle: LifecycleAction | null
  cancellation: SubscriptionCancellation | null
  lifecycleProgress?: SubscriptionLifecycleProgress | null
  portalOpened?: boolean
  cardUpdate?: SubscriptionCardUpdate | null
  cardAwaitingConfirmation?: boolean
  busy: boolean
  notice: Key | null
}

const initial: BillingState = {
  selectedPlan: null, recommendation: null, offer: null, purchase: null, selectedSubscription: null,
  changeOffer: null, change: null, invoices: null, lifecycle: null, cancellation: null, busy: false, notice: null,
}
const terminalPurchase = new Set(['succeeded', 'failed', 'expired', 'reactivated', 'abandoned'])
const settledChange = new Set(['completed', 'failed', 'canceled', 'cancelled', 'expired', 'reconciliation_required'])

function intervalFor(plan: Plan): BillingInterval {
  return plan.interval === 'year' ? 'year' : 'month'
}

/** Coordinate one account's billing presentation and fence all late replies. */
export class BillingModel {
  /** Observable presentation for the authenticated Plans page. */
  readonly state = createSnapshotStore(initial)
  private owner: string | null = null
  private revision: string | null = null
  private generation = 0
  private read: AbortController | undefined
  private portalReturnPending = false
  private cardUpdateRequestId: string | undefined
  private cardSetup: AbortController | undefined

  /**
   * Create the presenter for one mounted account source.
   * @param api - account-scoped commerce and navigation.
   * @param account - product account state.
   */
  constructor(private readonly api: BillingApi, private readonly account: HostObservable<ProductSnapshot>) {}

  private patch(values: Partial<BillingState>) {
    this.state.set({ ...this.state.getSnapshot(), ...values })
  }

  /** Drop presentation and abort reconciliation when the owning login changes. */
  adopt(): void {
    const { view, profile } = this.account.getSnapshot()
    const owner = view?.status === 'credential-stored' ? profile?.id ?? null : null
    const revision = view?.credentialRevision ?? null
    if (this.owner === owner && this.revision === revision) return
    this.pause()
    this.cardSetup?.abort()
    this.portalReturnPending = false
    this.cardUpdateRequestId = undefined
    this.generation++
    this.owner = owner
    this.revision = revision
    this.state.set(initial)
  }

  /** Pause the current polling read without losing the last server state. */
  pause(): void {
    this.read?.abort()
  }

  /** Prevent any in-flight action from updating an unloaded presenter. */
  dispose(): void {
    this.pause()
    this.cardSetup?.abort()
    this.generation++
    this.owner = null
  }

  private async perform(work: (owns: () => boolean) => Promise<void>): Promise<void> {
    if (!this.owner || this.state.getSnapshot().busy) return
    const generation = this.generation
    const owns = () => this.generation === generation
    this.pause()
    this.patch({ busy: true, notice: null })
    try {
      await work(owns)
    } catch (_error) {
      if (owns()) this.patch({ notice: 'billingUnavailable' })
    } finally {
      if (owns()) this.patch({ busy: false })
    }
  }

  /**
   * Route a selected plan according to the server's account-specific decision.
   * @param plan - selected catalog entry.
   * @returns after the plan's available action has been presented.
   */
  choose(plan: Plan): Promise<void> {
    return this.perform(async (owns) => {
      const state = this.state.getSnapshot()
      if (state.purchase !== null) return
      this.patch({ selectedPlan: plan, offer: null, recommendation: null })
      const interval = intervalFor(plan)
      const result = await this.api.options(plan.id, interval)
      if (!owns()) return
      if (!result.ok) { this.patch({ notice: 'billingUnavailable' }); return }
      if (result.data.action !== 'checkout') {
        this.patch({ recommendation: result.data })
        return
      }
      const quote = await this.api.quote(plan.id, interval)
      if (owns()) this.patch(quote.ok ? { offer: quote.data } : { notice: 'billingQuoteUnavailable' })
    })
  }

  /**
   * Present a particular subscription and its outstanding plan change.
   * @param subscription - record selected from the current account's list, or null to close the panel.
   */
  manage(subscription: Subscription | null): void {
    if (!this.owner || this.state.getSnapshot().busy) return
    this.pause()
    this.portalReturnPending = false
    this.cardUpdateRequestId = undefined
    this.generation++
    this.patch({
      selectedPlan: null, offer: null, recommendation: null,
      selectedSubscription: subscription?.id ?? null, reviewingChange: false, changeOffer: null, invoices: null,
      cancellation: subscription?.cancellation ?? null,
      lifecycle: null, lifecycleProgress: null, portalOpened: false, cardUpdate: null, cardAwaitingConfirmation: false, notice: null,
      change: subscription?.activeChangeId ? { id: subscription.activeChangeId, status: 'verifying', effectiveAt: null, url: null } : null,
    })
  }

  /** Confirm the exact card quote, then leave the provider handoff ready to open. */
  confirm(): Promise<void> {
    return this.perform(async (owns) => {
      const { offer } = this.state.getSnapshot()
      if (offer === null) return
      const result = await this.api.confirm(offer.id)
      if (!owns()) return
      if (!result.ok) {
        this.patch({ offer: null, notice: result.code === 'terms_required' ? 'billingTermsRequired' :
          result.code === 'quote_changed' ? 'billingQuoteUnavailable' :
            result.code === 'checkout_rejected' ? 'billingCheckoutRejected' :
              result.code === 'unavailable' ? 'billingCheckoutUnavailable' : 'billingUnavailable' })
        return
      }
      this.patch({ offer: null, purchase: result.data })
      if (result.data.status === 'reactivated') await this.api.refreshPlans()
      if (owns() && result.data.url) await this.api.open(result.data.url)
    })
  }

  /**
   * Reopen the original secure provider session after an explicit click.
   * @param attempt - saved attempt, or one selected from the server recommendation.
   * @returns after opening or reporting an unavailable link.
   */
  reopen(attempt: PurchaseAttemptId): Promise<void> {
    return this.perform(async (owns) => {
      const { purchase } = this.state.getSnapshot()
      if (purchase?.id === attempt && purchase.url !== null) {
        await this.api.open(purchase.url)
        return
      }
      const result = await this.api.reopen(attempt)
      if (!owns()) return
      if (result.ok) await this.api.open(result.data)
      else this.patch({ notice: 'billingReopenUnavailable' })
    })
  }

  /**
   * Reconcile before resending an unresolved purchase with the original authorization.
   * @param attempt - original checkout attempt.
   * @returns after the result or provider action is available.
   */
  retryPurchase(attempt: PurchaseAttemptId): Promise<void> {
    return this.perform(async (owns) => {
      const result = await this.api.retry(attempt)
      if (!owns()) return
      if (!result.ok) { this.patch({ notice: 'billingUnavailable' }); return }
      this.patch({ purchase: result.data })
      if (result.data.status === 'succeeded' || result.data.status === 'reactivated') await this.api.refreshPlans()
      if (owns() && result.data.url) await this.api.open(result.data.url)
    })
  }

  /** Open the official acceptance page before another reviewed confirmation. */
  openTerms(): Promise<void> {
    return this.perform(async (owns) => {
      const result = await this.api.terms()
      if (!owns()) return
      this.patch({ notice: 'billingTermsRequired' })
      if (result.ok) await this.api.open(result.data)
    })
  }

  /**
   * Close the exact hosted checkout and wait for persisted confirmation.
   * @param attempt - current open checkout.
   * @returns after settlement or an unconfirmed result.
   */
  abandonPurchase(attempt: PurchaseAttemptId): Promise<void> {
    return this.perform(async (owns) => {
      const result = await this.api.abandon(attempt)
      if (!owns()) return
      this.patch(result.ok ? { purchase: result.data } : { notice: 'billingUnknown' })
    })
  }

  /** Close a quote, or dismiss the server-verified result of a resolved purchase. */
  closePurchase(): Promise<void> {
    return this.perform(async (owns) => {
      const { purchase } = this.state.getSnapshot()
      if (purchase !== null && purchase.status !== 'reactivated') {
        const result = await this.api.dismiss(purchase.id)
        if (!owns()) return
        if (!result.ok || !result.data) { this.patch({ notice: 'billingUnavailable' }); return }
      }
      this.patch({ purchase: null, selectedPlan: null, offer: null, recommendation: null })
    })
  }

  /**
   * Review a subscription's target offer.
   * @param subscription - exact subscription to change.
   * @param plan - target plan from the catalog.
   * @param removeTier - optional selection to remove the current extra tier.
   * @returns when a preview or an actionable notice is shown.
   */
  preview(subscription: BillingSubscriptionId, plan: Plan, removeTier = false): Promise<void> {
    return this.perform(async (owns) => {
      this.patch({ reviewingChange: true, changeOffer: null, lifecycle: null })
      const quote = await this.api.quoteChange(subscription, plan.id, intervalFor(plan), removeTier)
      if (owns()) this.patch(quote.ok ? { changeOffer: quote.data } : { notice: 'billingChangeUnavailable' })
    })
  }

  /** Confirm the selected preview and retain the exact change for reconciliation. */
  confirmChange(): Promise<void> {
    return this.perform(async (owns) => {
      const { changeOffer } = this.state.getSnapshot()
      if (changeOffer === null) return
      const result = await this.api.confirmChange(changeOffer.id)
      if (!owns()) return
      this.patch(result.ok ? { changeOffer: null, change: result.data } : {
        changeOffer: null, notice: result.code === 'terms_required' ? 'billingTermsRequired' : 'billingChangeUnavailable',
      })
      if (result.ok && ['completed', 'scheduled'].includes(result.data.status)) await this.api.refreshPlans()
    })
  }

  /**
   * Present a cancellation or reactivation confirmation.
   * @param action - action to review, or null to close it.
   */
  reviewLifecycle(action: LifecycleAction | null): void {
    const { busy, lifecycleProgress } = this.state.getSnapshot()
    if (!busy && (!lifecycleProgress || lifecycleProgress.status === 'confirmed'))
      this.patch({ lifecycle: action, reviewingChange: false, changeOffer: null, notice: null })
  }

  /**
   * Apply the reviewed lifecycle action to the selected subscription.
   * @param subscription - exact server subscription.
   * @returns after reconciliation has refreshed the server projection.
   */
  update(subscription: BillingSubscriptionId): Promise<void> {
    return this.perform(async (owns) => {
      const { lifecycle } = this.state.getSnapshot()
      if (lifecycle === null) return
      this.patch({ lifecycle: null })
      const result = await this.api.update(subscription, lifecycle)
      if (!owns()) return
      if (!result.ok) {
        this.patch({ notice: result.code === 'terms_required' ? 'billingTermsRequired' : 'billingUnavailable' })
        return
      }
      this.applyLifecycle(result.data)
      if (result.data.status === 'confirmed') await this.api.refreshPlans()
    })
  }

  private applyLifecycle(progress: SubscriptionLifecycleProgress) {
    this.patch({
      lifecycleProgress: progress,
      ...(progress.cancellation || (progress.action === 'reactivate' && progress.status === 'confirmed')
        ? { cancellation: progress.cancellation } : {}),
    })
  }

  /**
   * Load invoice history for the visible subscription.
   * @param subscription - exact server subscription.
   * @returns after the invoice list is loaded.
   */
  loadInvoices(subscription: BillingSubscriptionId): Promise<void> {
    return this.perform(async (owns) => {
      const result = await this.api.invoices(subscription)
      if (owns()) this.patch(result.ok ? { invoices: result.data } : { notice: 'billingUnavailable' })
    })
  }

  /**
   * Open the secure provider portal for the selected subscription.
   * @param subscription - exact server subscription.
   * @returns after the URL is opened or a notice is recorded.
   */
  portal(subscription: BillingSubscriptionId): Promise<void> {
    return this.perform(async (owns) => {
      const result = await this.api.portal(subscription)
      if (!owns()) return
      if (result.ok) {
        await this.api.open(result.data)
        if (owns()) this.patch({ portalOpened: true })
      } else this.patch({ notice: 'billingUnavailable' })
    })
  }

  /** Open the card setup for the selected subscription, reusing any pending request.
   * @param subscription - exact subscription selected in Plans.
   * @param labels - localized native payment dialog copy.
   * @returns after the native dialog closes or the hosted page is opened.
   */
  async updateCard(subscription: BillingSubscriptionId, labels?: CardSetupLabels): Promise<void> {
    const openCardSetup = this.api.openCardSetup
    const embedded = openCardSetup !== undefined && labels !== undefined
    await this.perform(async (owns) => {
      const state = this.state.getSnapshot()
      if (state.selectedSubscription !== subscription) return
      const requestId = state.cardUpdate?.status === 'pending' ? state.cardUpdate.id :
        this.cardUpdateRequestId ?? randomUUID()
      this.cardUpdateRequestId = requestId
      const result = await this.api.startCardUpdate(subscription, requestId, embedded)
      if (!owns()) return
      if (!result.ok) { this.patch({ notice: 'billingCardUpdateUnavailable' }); return }
      this.cardUpdateRequestId = result.data.status === 'pending' ? result.data.id : undefined
      const { embedded: setup, ...card } = result.data
      this.patch({ cardUpdate: card, cardAwaitingConfirmation: false })
      if (!embedded) {
        if (card.url) await this.api.open(card.url)
        return
      }
      if (card.status !== 'pending') return
      if (setup === undefined) {
        this.patch({ notice: 'billingCardUpdateUnavailable' })
        return
      }
      const controller = new AbortController()
      this.cardSetup = controller
      try {
        const submitted = await openCardSetup(card.id, setup, labels, controller.signal)
        if (owns() && submitted) this.patch({ cardAwaitingConfirmation: true })
      } catch (_error) {
        if (owns()) this.patch({ notice: 'billingCardUpdateUnavailable' })
      } finally {
        if (this.cardSetup === controller) this.cardSetup = undefined
      }
    })
    if (embedded) await this.refresh()
  }

  /**
   * Open a provider URL already present in the current verified projection.
   * @param url - projected provider link.
   * @returns after completion or a navigation failure.
   */
  open(url: string): Promise<void> {
    return this.perform(async () => { await this.api.open(url) })
  }

  /** Reconcile pending billing with a single cancellable read in flight.
   * @param returned - a focus or visibility event after leaving the app.
   */
  async refresh(returned = false): Promise<void> {
    const state = this.state.getSnapshot()
    if (returned && state.portalOpened) this.portalReturnPending = true
    if (!this.owner || this.read !== undefined || state.busy) return
    const read = new AbortController()
    this.read = read
    const owns = () => !read.signal.aborted
    try {
      if (state.purchase?.status !== 'reactivated' && (state.purchase === null || !terminalPurchase.has(state.purchase.status))) {
        const result = await this.api.current(read.signal)
        if (!owns()) return
        if (result.ok && result.data !== null) {
          const saved = result.data
          this.patch({ purchase: {
            ...saved,
            url: saved.id === state.purchase?.id && saved.status === 'requires_action' ? state.purchase.url : null,
          }, offer: null })
          if (saved.status === 'succeeded') await this.api.refreshPlans()
        }
      }
      if (!owns()) return
      if (state.change === null && state.selectedSubscription !== null) {
        const result = await this.api.currentChange(state.selectedSubscription as BillingSubscriptionId, read.signal)
        if (!owns()) return
        if (result.ok && result.data) this.patch({ change: result.data })
      }
      if (state.change !== null && !settledChange.has(state.change.status)) {
        const result = await this.api.changeStatus(state.change.id, read.signal)
        if (!owns()) return
        if (result.ok) {
          this.patch({ change: result.data })
          if (result.data.status !== state.change.status && ['completed', 'scheduled'].includes(result.data.status))
            await this.api.refreshPlans()
        }
      }
      if (!owns() || state.selectedSubscription === null) return
      const subscription = state.selectedSubscription as BillingSubscriptionId
      const selected = this.account.getSnapshot().plans?.subscriptions.find(row => row.id === subscription)
      if (selected?.permissions?.cardUpdate || state.cardUpdate || this.cardUpdateRequestId !== undefined) {
        const card = await this.api.currentCardUpdate(subscription, read.signal)
        if (!owns()) return
        if (card.ok && card.data) {
          this.cardUpdateRequestId = card.data.status === 'pending' ? card.data.id : undefined
          this.patch({
            cardUpdate: card.data,
            cardAwaitingConfirmation: card.data.status === 'pending' && state.cardAwaitingConfirmation === true,
          })
        }
      }
      const checkCancellation = state.cancellation != null &&
        (state.cancellation.localStatus === 'pending' || state.cancellation.collectionStatus !== 'stopped')
      const lifecycle = await this.api.currentLifecycle(subscription, read.signal, checkCancellation)
      if (!owns()) return
      const progress = lifecycle.ok ? lifecycle.data : null
      if (progress) {
        this.applyLifecycle(progress)
        if (progress.status === 'confirmed' && state.lifecycleProgress?.status !== 'confirmed')
          await this.api.refreshPlans()
      }
      if (owns() && this.portalReturnPending && state.portalOpened) {
        await this.api.refreshPlans()
        if (!owns()) return
        this.portalReturnPending = false
        this.patch({ portalOpened: false })
        if (state.invoices !== null) {
          const invoices = await this.api.invoices(subscription)
          if (owns() && invoices.ok) this.patch({ invoices: invoices.data })
        }
      }
    } catch (_error) {
      if (owns() && (state.purchase !== null || state.change !== null)) this.patch({ notice: 'billingUnavailable' })
    } finally {
      if (this.read === read) this.read = undefined
    }
  }
}
