# User Credentials

English | [中文](credentials.zh.md)

The credential seam of [dsh-credentials](../../packages/credentials/credentials) keeps secrets out of configuration: settings sections and `cordis.yml` entries carry *references* (environment-variable names), providers such as [dsh-credentials-local](../../packages/credentials/credentials-local) own the values, and consumers resolve a reference once per operation — the LLM adapters resolve once per model request, so a rotated credential reaches the very next request without any restart. One seam-wide rule binds every provider: an empty stored value is absent everywhere.

Source: [`packages/credentials/credentials/src/index.ts`](../../packages/credentials/credentials/src/index.ts)

## Identity

A reference names one credential as a POSIX-style environment-variable name. The brand prevents callers from mixing credential references with other strings passed between packages or processes; construction validates the shell-identifier syntax.

```ts type-equiv
/** Nominal reference to one credential: a POSIX-style environment-variable name. */
type CredentialRef = Branded<'CredentialRef'>
```

<a id="resolution"></a>
## Resolution

`resolve(ref)` returns the value with the provider-defined source layer that supplied it, or `undefined` while unconfigured. Consumers re-resolve at each operation and never cache across operations — that per-operation read is the hot-update mechanism.

```ts type-equiv
/** One resolved credential value and the source layer that supplied it. */
interface ResolvedCredential {
  /** The non-empty secret value. */
  value: string
  /** Provider-defined source layer id (the local provider uses `env`, `file`, `project-env`, and `user-env`). */
  source: string
}
```

## Description

`describe(ref)` answers configuration surfaces without ever exposing a value: whether the reference resolves, from which layer, and whether `set` would currently succeed. The local provider ranks its managed file above the launch environment, so saving a value always creates the effective writable layer; removing it reveals the launch environment or `.env` fallback again.

```ts type-equiv
/**
 * Source and writability facts for one reference, safe for configuration UIs —
 * never the value. The view has no slot a value could ride in, which is what
 * lets the whole read half cross the Remote wire.
 */
interface CredentialInfo {
  /** Whether resolving the reference would currently return a value. */
  configured: boolean
  /** Source layer currently supplying the value; absent while unconfigured. */
  source?: string
  /** Whether the active provider can write this reference. */
  writable: boolean
}
```

## Change commits

`credentials/reference-updated (ref)` fires after a committed change to a provider-managed source — a `set`, an `unset`, or an external edit observed in storage. Ambient process-environment changes are not observable and never emit. Consumers do not need the event (they re-resolve per operation); it exists for configuration surfaces refreshing a "configured" badge.

## Embedded Platform credentials

PlatformSession is a Host-only snapshot from getPlatformSession: origin names the configured Platform issuer and token contains its stored account credential. userId repeats the stable account ID from the most recent successful getProfile, and is null until one succeeds or when that profile carries no ID. The snapshot reuses that ID without issuing a profile request of its own, so an unknown ID leaves userId null instead of delaying the caller; a profile read whose stable ID first becomes available or changes notifies only Host subscribers using `watch(signal, true)`, which lets identity consumers re-read the snapshot. Consumers key persistent browser storage by origin and userId and fall back to temporary storage for null. Signed-out accounts and credentials changed during the credential read return no snapshot; a mismatched issuer fails. Native consumers own document invalidation when credentials change. This snapshot is excluded from account-controller RPC, AccountView, and AccountDetails.

AccountDetails.balance projects recharge wallets in value and promotional wallets in bonusWallets, with independent currency and decimal balance strings. Failed queries contain no wallet arrays.

Bonus notification queries return an AccountBonusBatch with the current Platform account id and eligible orders in server order. AccountBonusNotification retains the server message and expiry without projecting credentials. Acknowledgment carries the expected account id and order id; the Host refuses it after an account change. Both notification operations use the initiating UI language through x-client-locale, without a language query parameter.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxauthorization--authorizationservice"></a>

### `ctx.authorization` — `AuthorizationService`

`ctx.authorization`: a registry of credential-obtaining flows, one attempt at a time per key.

```ts cordis-catalog
/**
 * Offer a way to obtain one credential. One flow per key: two plugins
 * claiming the same key would each write a record in their own format, and
 * whichever ran last would leave the other reading a payload it cannot parse.
 *
 * @param flow - the key it writes, its label, its methods, and its runner.
 * @returns Disposer that withdraws this flow.
 * @throws {AuthorizationError} code `DUPLICATE_FLOW` when the key is already claimed.
 */
registerFlow(flow: AuthorizationFlow): () => void

/**
 * Every registered flow, for a surface listing what can be authorized.
 * @returns one entry per flow, in registration order.
 */
list(): readonly AuthorizationEntry[]

/**
 * One registered flow.
 * @param key - the credential record to ask about.
 * @returns the entry, or undefined when no flow claims that key.
 */
describe(key: CredentialKey): AuthorizationEntry | undefined

/**
 * Withdraw the attempt running for a key, if any. Separate from the
 * request's own signal because a request/response transport answers a Cancel
 * button on a second call, with no handle on the first one's signal.
 * @param key - the credential record whose attempt should stop.
 */
cancel(key: CredentialKey): void

/**
 * Run one attempt to authorize a key, and report how it ended.
 *
 * One attempt per key at a time. A second caller is refused rather than
 * joined: the two would be prompting different humans through the same flow,
 * and the second would answer questions the first was asked.
 *
 * @param request - the key, the method, the surface, and the cancel signal.
 * @returns `authorized` once the flow's record is committed during this
 *   attempt and observed, or `cancelled` when the human declined or the
 *   caller withdrew.
 * @throws {AuthorizationError} code `NO_FLOW` when nothing claims the key,
 *   `UNKNOWN_METHOD` when the named method is not one the flow offers,
 *   `ALREADY_IN_FLIGHT` when an attempt is already running for the key, or
 *   `NOT_COMMITTED` when the flow resolved without committing a record
 *   during the attempt.
 */
async begin(request: AuthorizationRequest): Promise<AuthorizationOutcome>
```

Source: [`packages/credentials/authorization/src/index.ts`](../../packages/credentials/authorization/src/index.ts)

<a id="ctxcredentials--credentialprovider-abstract-seam"></a>

### `ctx.credentials` — `CredentialProvider` (abstract seam)

Abstract credential service over two key spaces that answer two questions.

A CredentialRef answers "what is behind this environment-variable name": the provider-managed store first, then ambient fallbacks such as the process environment and `.env` files. One seam-wide rule binds that half: an empty stored value is absent everywhere — `resolve` skips it, `describe` reports it unconfigured — so a blank never masquerades as a configured secret.

A CredentialKey answers "what credential does this plugin hold for this id". Nothing can layer here — an authorization grant has no environment to be read from — so presence of the record is the whole fact, and modifyRecord is the only write path because a correct write depends on the current value (a token refresh is read-decide-replace under one lock).

```ts cordis-catalog
/**
 * Resolve one reference to its current value. Resolution is per call:
 * consumers re-resolve at each operation and must not cache across
 * operations — that per-operation read is what makes a changed credential
 * reach the next operation without a restart.
 * @param ref - the reference to resolve.
 * @returns the value and its source, or `undefined` while unconfigured.
 */
abstract resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined>

/**
 * Describe one reference for configuration surfaces without exposing the
 * value.
 * @param ref - the reference to describe.
 * @returns configured state, supplying source, and writability.
 */
abstract describe(ref: CredentialRef): Promise<CredentialInfo>

/**
 * Durably store one value in the provider-managed writable source. The stored
 * value takes precedence over ambient fallbacks, and empty values are
 * rejected (use {@link unset}).
 * @param ref - the reference to store.
 * @param value - the non-empty secret value.
 */
abstract set(ref: CredentialRef, value: string): Promise<void>

/**
 * Remove one reference from the provider-managed writable source; removing
 * an absent reference is a no-op. Ambient fallback layers may become
 * effective again after removal.
 * @param ref - the reference to remove.
 */
abstract unset(ref: CredentialRef): Promise<void>

/**
 * Read one stored record. The value is returned as its owner wrote it; a
 * {@link GrantRecord} payload is not interpreted on the way out.
 * @param key - the record to read.
 * @returns the record, or `undefined` while none is stored.
 */
abstract readRecord(key: CredentialKey): Promise<CredentialRecord | undefined>

/**
 * Describe one record for configuration surfaces without exposing its value.
 * @param key - the record to describe.
 * @returns presence, discriminant, and writability.
 */
abstract describeRecord(key: CredentialKey): Promise<CredentialRecordInfo>

/**
 * Enumerate every stored record's address and tag. Unlike the reference
 * half, which has no enumeration because configuration surfaces learn which
 * references exist from settings schemas, records have no such discovery
 * path: a surface that cannot list them cannot show what a user is
 * authorized for, nor find an orphan left by an uninstalled plugin.
 * @returns every stored record, values excluded.
 */
abstract listRecords(): Promise<readonly CredentialRecordEntry[]>

/**
 * Serialized read-modify-write over one record — the only write path.
 * `mutate` sees the record as it stands at the moment the write is
 * exclusive, and returning `undefined` leaves the entry untouched. Exclusion
 * holds across processes where the backing store supports it, which is what
 * makes a token refresh safe: two processes rotating one refresh token
 * concurrently would otherwise lose whichever wrote first.
 * @param key - the record to modify.
 * @param mutate - receives the current record and returns its replacement, or `undefined` to leave it.
 * @returns the record after the write, or the current one when `mutate` declined.
 */
abstract modifyRecord( key: CredentialKey, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>, ): Promise<CredentialRecord | undefined>

/**
 * Remove one record; removing an absent record is a no-op.
 * @param key - the record to remove.
 */
abstract deleteRecord(key: CredentialKey): Promise<void>
```

Source: [`packages/credentials/credentials/src/index.ts`](../../packages/credentials/credentials/src/index.ts)

<a id="ctxcredentialscontroller--credentialscontroller"></a>

### `ctx.credentialsController` — `CredentialsController`

Host service backing the generated `ctx.remote.credentials` namespace. It carries every wire obligation the credential seam itself does not: the batch fan-out bound, the field-by-field view projection, the reference-grammar guard, and the refusal mapping. Secret values cross in one direction only — no method here returns one.

```ts cordis-catalog
/**
 * Describe several references for one configuration surface. Batched because
 * a settings page describes every reference its rows name at once, and one
 * round trip keeps those rows from settling separately.
 * @param refs - reference names, at most {@link MAX_DESCRIBE_REFS}; a name outside the grammar
 *   rejects the whole call as `gateway/bad-request`.
 * @returns one view per requested name, keyed by that name.
 * @throws RemoteError when the request is invalid or no credential provider is mounted.
 */
@Remote async describe(refs: string[]): Promise<Record<string, CredentialInfo>>

/**
 * Store one value from a configuration surface. The value crosses the wire in
 * this direction only: no read path returns it.
 * @param ref - reference name to store under.
 * @param value - the non-empty secret value.
 * @throws RemoteError when the request is invalid, no provider is mounted, or the provider refuses the write.
 */
@Remote async set(ref: string, value: string): Promise<void>

/**
 * Remove one reference from a configuration surface.
 * @param ref - reference name to remove.
 * @throws RemoteError when the request is invalid, no provider is mounted, or the provider refuses the write.
 */
@Remote async unset(ref: string): Promise<void>
```

Source: [`packages/api/settings-controller/src/credentials.ts`](../../packages/api/settings-controller/src/credentials.ts)

<a id="ctxdeepseekaccount--deepseekaccount-abstract-seam"></a>

### `ctx.deepseekAccount` — `DeepSeekAccount` (abstract seam)

Account operations; only Host consumers can obtain a request credential.

```ts cordis-catalog
/**
 * Read stored-account presence and the latest login attempt.
 * @returns a snapshot without credentials or PKCE secrets.
 */
abstract getState(): Promise<AccountView>

/**
 * Query Platform profile independently of wallet balances.
 * A ready result whose stable profile ID first becomes available or changes notifies identity-enabled watch
 * consumers, so they re-read getPlatformSession; repeated IDs stay silent.
 * @param client - identity of the requesting UI for this call.
 * @returns profile outcome, or null if signed out or the grant changed during the query.
 */
abstract getProfile(client: AccountClientMetadata): Promise<AccountDetails['profile'] | null>

/**
 * Query Platform recharge and bonus wallet balances independently of profile data.
 * @param client - identity of the requesting UI for this call.
 * @returns balance outcome, or null if signed out or the grant changed during the query.
 */
abstract getBalance(client: AccountClientMetadata): Promise<AccountDetails['balance'] | null>

/**
 * Query the granted bonuses Platform has not yet recorded as displayed.
 * @param client - identity of the requesting UI for this call; its language selects the server-authored message.
 * @returns bonuses with their account, or null if signed out or the grant changed during the query.
 */
abstract getUnnotifiedBonuses(client: AccountClientMetadata): Promise<AccountBonusBatch | null>

/**
 * Record one displayed bonus as notified for the account it belongs to.
 * @param accountId - account the notification was read for; a different current account is never acknowledged.
 * @param orderId - granted bonus order the user saw.
 * @param client - identity of the requesting UI for this call.
 * @returns true once Platform records the acknowledgement; false if signed out or the account changed.
 */
abstract ackBonusNotified(accountId: AccountUserId, orderId: AccountBonusOrderId, client: AccountClientMetadata): Promise<boolean>

/**
 * Join an active attempt or start browser authorization.
 * @param client - identity of the requesting UI; a new attempt captures it, and joining retains the original attempt's identity.
 * @param callbackOrigin - browser-accessible loopback HTTP origin, including any SSH local port.
 * @param loginSource - initiating UI, used to return from a failed exchange.
 * @returns the initial snapshot without waiting for browser approval.
 */
abstract startSignIn(client: AccountClientMetadata, callbackOrigin: string, loginSource: 'web' | 'desktop'): Promise<AccountView>

/**
 * Cancel only the named attempt; committing attempts settle before returning.
 * @param id - attempt identity from this Host.
 * @returns state after cancellation or an already-started commit.
 */
abstract cancelSignIn(id: SignInAttemptId): Promise<AccountView>

/**
 * Remove the local grant while retaining API keys; the provider revokes it in the background.
 * @param client - identity of the requesting UI, captured for the background revocation retries.
 * @returns the signed-out state after local removal; remote failures never restore the grant.
 */
abstract signOut(client: AccountClientMetadata): Promise<AccountView>

/**
 * Subscribe to snapshots including a complete initial state.
 * @param signal - subscription lifetime; ending it never cancels login.
 * @param includeIdentityChanges - also notify when cached Platform identity changes; defaults to false.
 * @returns complete snapshots as account state changes.
 */
abstract watch(signal: AbortSignal, includeIdentityChanges?: boolean): AsyncIterable<AccountView>

/**
 * Resolve a credential only for the inference origin allowed by the provider.
 * @param url - actual request destination or API base URL.
 * @returns stored token, or undefined for other origins or a signed-out account.
 */
abstract resolveToken(url: string): Promise<string | undefined>

/**
 * Refresh one inference-rejected token when the provider supports refresh.
 * A provider without refresh support returns undefined. Implementations must compare the exact rejected token
 * before changing credentials, return a newer current token when another operation already refreshed it, and
 * preserve the stored grant when refresh fails for a transient or local reason.
 * @param _url - actual request destination that rejected the token.
 * @param _rejectedToken - exact token sent by that request.
 * @param _signal - optional caller cancellation for the refresh request.
 * @returns a current replacement token, or undefined when no replacement is available.
 */
refreshRejectedToken( _url: string, _rejectedToken: string, _signal?: AbortSignal, ): Promise<string | undefined>

/**
 * Remove an inference-rejected token only while it still matches the stored login.
 * @param token - token captured by the rejected inference request.
 * @returns after matching credentials are removed and the expiry notification is emitted.
 */
abstract rejectToken(token: string): Promise<void>

/**
 * Read credentials for the configured Platform origin, bound to their issuing environment, and
 * pair them with the account ID from the last successful profile read; no profile request is made.
 * @returns a Host-only snapshot, or null while signed out or when the credential changed during the read.
 */
abstract getPlatformSession(): Promise<PlatformSession | null>

/**
 * Read existing login identity without creating a device or returning credentials.
 * @returns optional device/account identifiers and the provider's OS version string.
 */
abstract getDeviceIdentity(): Promise<{ deviceId?: string; userId?: AccountUserId; osVersion: string }>
```

Source: [`packages/credentials/deepseek-account/src/index.ts`](../../packages/credentials/deepseek-account/src/index.ts)

<a id="ctxopenaiaccount--openaiaccount"></a>

### `ctx.openaiAccount` — `OpenAiAccount`

The [OI] account service: login, token renewal, and the status the Client reads.

A stored grant is the only claim this service makes about being signed in; it never asserts that the provider currently accepts the token.

```ts cordis-catalog
/**
 * Start one browser login and return the URL the system browser opens.
 * @param redirectUri - loopback callback the Host serves.
 * @param signal - caller's cancellation signal.
 * @returns the authorization URL and the verifier the callback must present.
 */
begin(redirectUri: string, signal: AbortSignal): { url: string; verifier: string; state: string }

/**
 * Exchange one authorization code for a grant and persist it.
 * @param code - authorization code the callback received.
 * @param verifier - PKCE verifier kept from {@link begin}.
 * @param redirectUri - the exact redirect the authorization request used.
 * @param signal - caller's cancellation signal.
 * @returns the status the new grant reports.
 * @throws AccountRequestError when the exchange fails.
 */
async complete(code: string, verifier: string, redirectUri: string, signal: AbortSignal): Promise<OpenAiAccountStatus>

/**
 * Report the stored session's plan facts.
 * @returns the status; presence means a grant is stored, not that it is still accepted.
 */
async status(): Promise<OpenAiAccountStatus>

/**
 * Produce a token the route may send, renewing an expired one.
 * @param signal - caller's cancellation signal.
 * @returns a usable access token, or `undefined` when no session is stored.
 */
async accessToken(signal: AbortSignal): Promise<string | undefined>

/** Remove the stored grant and tell the tree no session remains. */
async signOut(): Promise<void>
```

Source: [`packages/credentials/openai-account/src/account.ts`](../../packages/credentials/openai-account/src/account.ts)

<a id="ctxverbooproduct--verbooproduct"></a>

### `ctx.verbooProduct` — `VerbooProduct`

Every request captures its owning login before I/O and fences its response.

```ts cordis-catalog
/**
 * Read account-scoped connections for an Agent tool.
 * @param signal - tool cancellation.
 * @returns safe JSON text recorded by the tool pipeline.
 */
async listAgentConnections(signal: AbortSignal): Promise<string>

/**
 * Discover pinned tool definitions for one owned connection.
 * @param connectionId - opaque account identity.
 * @param query - capability description.
 * @param signal - tool cancellation.
 * @returns public tool schema JSON.
 */
async searchAgentConnections( connectionId: string, query: string, signal: AbortSignal, ): Promise<string>

/**
 * Execute exactly one provider action; never retry a write or expose service credentials.
 * @param input - discovered tool, version, owned connection and arguments.
 * @param signal - tool cancellation.
 * @returns the provider's exact JSON text, including wide integers.
 */
async executeAgentConnection( input: { connectionId: string slug: string version: string arguments: Record<string, unknown> }, signal: AbortSignal, ): Promise<string>

/**
 * Read subscriptions and available recurring plans from the authoritative API.
 * @returns display-safe plan projections.
 */
@Remote getPlans(): Promise<Result<Plans>>

/**
 * Read owned subscriptions independently of the commercial catalog.
 * @param signal - cancellation of the owning Client read.
 * @returns display-safe subscriptions for the current account.
 */
@Remote getUsageSubscriptions(signal: AbortSignal): Promise<Result<Subscription[]>>

/**
 * Read historical subscription usage without exposing account credentials.
 * @param period - selected reporting period.
 * @param groupId - plan group to read, or null for the account total.
 * @param signal - cancellation of the owning Client read.
 * @returns validated request and token totals for the chosen scope.
 */
@Remote getUsageSummary(period: UsagePeriod, groupId: PlanId | null, signal: AbortSignal): Promise<Result<UsageSummary>>

/**
 * Read the subscription activity calendar independently of historical totals.
 * @param signal - cancellation of the owning Client read.
 * @returns validated daily activity counts for the past year.
 */
@Remote getUsageActivity(signal: AbortSignal): Promise<Result<UsageActivityDay[]>>

/**
 * Stream account generation speed from the same service as the web dashboard.
 * @param signal - lifetime of the authenticated speed stream.
 * @returns server measurements without private credentials or concurrency data.
 */
@Remote({ mode: 'stream' }) async *watchUsageSpeed(signal: AbortSignal): AsyncIterable<SpeedFrame>

/**
 * Read stamina only for plans where the server has enrolled this account.
 * @param signal - cancellation of the owning Client read.
 * @returns public percentages and next-request ceilings; older APIs without stamina return an empty list.
 */
@Remote getStamina(signal: AbortSignal): Promise<Result<StaminaStatus[]>>

/**
 * Read server-decided trial attention; an unavailable API never means expired.
 * @param signal - cancellation for the owning visible-window read.
 * @returns persisted attention, remaining tokens and paid group access.
 */
@Remote getTrialStatus(signal: AbortSignal): Promise<Result<TrialStatus>>

/**
 * Quote one eligible plan without authorizing payment.
 * @param trialId - the server's current trial notice identifier.
 * @param planId - an eligible USD catalog plan.
 * @param method - requested method; absent selects card.
 * @returns display-only offer data; signed authorizations remain on the Host.
 */
@Remote trialOffer(trialId: TrialId, planId: PlanId, method?: 'card' | 'pix'): Promise<Result<TrialOffer>>

/**
 * Authorize only the displayed quote, using an account-bound stable request identity.
 * @param offerId - opaque Host quote identifier.
 * @param method - the payment method displayed in the offer.
 * @param requestId - original purchase identity retained for recovery.
 * @returns confirmation or a pending provider step, never browser-derived success.
 */
@Remote confirmTrialOffer(offerId: TrialOfferId, method: 'card' | 'pix', requestId: TrialAttemptId): Promise<Result<TrialPayment>>

/**
 * Check the original purchase attempt; browser returns never prove completion.
 * @param attemptId - original local purchase attempt identifier.
 * @returns its persisted server status.
 */
@Remote trialPaymentStatus(attemptId: TrialAttemptId): Promise<Result<{ status: string }>>

/**
 * Reopen only the authenticated user's original provider checkout, without another purchase.
 * @param attemptId - original local purchase attempt identifier.
 * @param trialId - subscription notice for legacy invoice recovery; absent uses checkout recovery only.
 * @returns the existing handoff or persisted completion of that same attempt.
 */
@Remote resumeTrialPayment(attemptId: TrialAttemptId, trialId?: TrialId): Promise<Result<TrialPayment>>

/**
 * Open the canonical billing operations for the current host login.
 * The capability is Host-only and all of its I/O uses the same login.
 * @returns operations bound to the current authenticated account, or a safe refusal.
 */
agentBilling(): Promise<Result<AgentBilling>>

/** Verify the next action for a plan under the current login.
 * @param plan - selected catalog plan.
 * @param interval - selected billing period.
 * @returns server-authorized actions for the account.
 */
@Remote billingOptions(plan: PlanId, interval: BillingInterval): Promise<Result<PurchaseRecommendation>>

/** Prepare a card quote without starting a purchase.
 * @param plan - selected catalog plan.
 * @param interval - selected billing period.
 * @returns the amounts and currency to review.
 */
@Remote quotePurchase(plan: PlanId, interval: BillingInterval): Promise<Result<PurchaseQuote>>

/** Confirm one reviewed card quote and retain its identity before sending it.
 * @param quoteId - identifier of the reviewed Host offer.
 * @returns the attempt and any provider handoff.
 */
@Remote confirmPurchase(quoteId: BillingQuoteId): Promise<Result<PurchaseProgress>>

/** Retry the identical authorization only when no server attempt is visible.
 * @param attempt - exact unresolved operation owned by the signed-in account.
 * @returns the reconciliation result or the repeated original request.
 */
@Remote retryPurchase(attempt: PurchaseProgress['id']): Promise<Result<PurchaseProgress>>

/** Reconcile the account's original checkout against the server record.
 * @param signal - lifetime of the visible account read.
 * @returns the original purchase, or null if no local operation exists.
 */
@Remote currentPurchase(signal: AbortSignal): Promise<Result<PurchaseProgress | null>>

/** Open the provider's existing session for an eligible original checkout.
 * @param attempt - exact attempt owned by the current account.
 * @returns a validated provider URL.
 */
@Remote resumePurchase(attempt: PurchaseProgress['id']): Promise<Result<string>>

/** Close the saved provider attempt after the user explicitly requests it.
 * @param attempt - exact open card checkout to abandon.
 * @returns persisted status after the provider closes the attempt.
 */
@Remote abandonPurchase(attempt: PurchaseProgress['id']): Promise<Result<PurchaseProgress>>

/** Clear a resolved operation after verifying that exact attempt.
 * @param attempt - completed or terminal attempt being dismissed.
 * @returns whether its durable recovery record was removed.
 */
@Remote dismissPurchase(attempt: PurchaseProgress['id']): Promise<Result<boolean>>

/** Quote an exact change for one owned subscription.
 * @param subscription - existing subscription.
 * @param plan - target plan.
 * @param interval - target billing period.
 * @param removeTier - explicit acceptance that the existing add-on is removed.
 * @returns amounts, effective date, and the opaque confirmation handle.
 */
@Remote quotePlanChange( subscription: BillingSubscriptionId, plan: PlanId, interval: BillingInterval, removeTier: boolean, ): Promise<Result<PlanChangeQuote>>

/** Confirm only the last reviewed change for the current login.
 * @param quoteId - opaque handle of the reviewed change.
 * @returns the exact operation, even when acceptance is unconfirmed.
 */
@Remote confirmPlanChange(quoteId: BillingQuoteId): Promise<Result<PlanChangeProgress>>

/** Read the status of the exact change previously requested.
 * @param change - issued plan-change operation.
 * @param signal - lifetime of the visible account read.
 * @returns persisted progress and any safe continuation URL.
 */
@Remote billingChangeStatus(change: PlanChangeId, signal: AbortSignal): Promise<Result<PlanChangeProgress>>

/** Restore a change submitted through this Host, including lost responses.
 * @param subscription - exact subscription that was updated.
 * @param signal - lifetime of the visible account read.
 * @returns persisted progress for the exact submitted operation.
 */
@Remote currentBillingChange(subscription: BillingSubscriptionId, signal: AbortSignal): Promise<Result<PlanChangeProgress | null>>

/** Request one lifecycle action and persist its identity before sending it.
 * @param subscription - exact subscription to mutate.
 * @param action - explicit lifecycle action.
 * @param locale - current presentation locale for cancellation notices.
 * @returns immediate progress, including an unconfirmed response.
 */
@Remote updateSubscription( subscription: BillingSubscriptionId, action: 'cancel' | 'reactivate', locale?: string, ): Promise<Result<SubscriptionLifecycleProgress>>

/** Reconcile the saved lifecycle action against the exact subscription.
 * @param subscription - exact subscription selected in Plans.
 * @param signal - lifetime of the visible account read.
 * @param checkCancellation - also refresh a pending cancellation started elsewhere.
 * @returns authoritative progress or null if nothing is being reconciled.
 */
@Remote currentSubscriptionLifecycle( subscription: BillingSubscriptionId, checkCancellation: boolean, signal: AbortSignal, ): Promise<Result<SubscriptionLifecycleProgress | null>>

/** Read invoices scoped to the selected subscription.
 * @param subscription - exact subscription whose invoices are requested.
 * @returns display fields and an optional safe invoice link.
 */
@Remote billingInvoices(subscription: BillingSubscriptionId): Promise<Result<SubscriptionInvoice[]>>

/** Open the current published terms for an account that needs to accept them.
 * @returns the official acceptance page for this deployment.
 */
@Remote async billingTermsURL(): Promise<Result<string>>

/** Start or resume the secure card setup for one subscription.
 * @param subscription - exact subscription whose renewal card will change.
 * @param requestId - retry identity for this explicit action.
 * @param embedded - use the isolated native card form.
 * @returns the operation and its account-bound Stripe setup.
 */
@Remote startBillingCardUpdate( subscription: BillingSubscriptionId, requestId: string, embedded?: boolean, ): Promise<Result<SubscriptionCardUpdate>>

/** Read the latest card setup result proved by the server.
 * @param subscription - exact subscription selected in Plans.
 * @param signal - lifetime of the visible account read.
 * @returns the operation or null when this subscription has no card update.
 */
@Remote currentBillingCardUpdate(subscription: BillingSubscriptionId, signal: AbortSignal): Promise<Result<SubscriptionCardUpdate | null>>

/** Request the payment portal for one subscription.
 * @param subscription - exact subscription to manage.
 * @returns a validated provider URL.
 */
@Remote billingPortal(subscription: BillingSubscriptionId): Promise<Result<string>>

/**
 * Read only this authenticated user's connections.
 * @returns credential-free states and configured toolkits.
 */
@Remote getConnections(): Promise<Result<Connections>>

/**
 * Begin hosted authorization for one enabled toolkit.
 * @param toolkit - provider catalog slug.
 * @param label - user-facing name for this service account.
 * @returns short-lived browser link, never a service key.
 */
@Remote connect( toolkit: string, label: string, ): Promise< Result<{ url: string; expiresAt: string; id: ConnectionId | null }> >

/**
 * Disconnect only an account owned by the authenticated user.
 * @param id - opaque connection ID.
 * @returns after server confirmation.
 */
@Remote disconnect(id: ConnectionId): Promise<Result<null>>

/**
 * Construct a trusted official checkout handoff. Payment and upgrades remain owned by the Verboo website.
 * @param planId - catalog or owned plan.
 * @param purchase - open the website's subscribe flow.
 * @returns public URL without credentials.
 */
@Remote billingURL( planId: PlanId | null, purchase: boolean, ): Promise<Result<string>>
```

Source: [`packages/api/verboo-product/src/index.ts`](../../packages/api/verboo-product/src/index.ts)

<a id="authorization-events"></a>

### `authorization/*` events

<a id="authorizationsettled--emit"></a>

#### `authorization/settled` — emit

One authorization attempt has finished and released its key. Fires for every terminal outcome, failures included, so a surface watching a key it did not start (a second browser tab) learns the attempt is over.

```ts cordis-catalog
/**
 * One authorization attempt has finished and released its key. Fires for
 * every terminal outcome, failures included, so a surface watching a key it
 * did not start (a second browser tab) learns the attempt is over.
 * @mode emit
 * @param key - the credential record the finished attempt was authorizing.
 * @param settlement - how it ended, including the `failed` case its caller sees as a thrown error.
 */
'authorization/settled'(key: CredentialKey, settlement: AuthorizationSettlement): void
```

Source: [`packages/credentials/authorization/src/index.ts`](../../packages/credentials/authorization/src/index.ts)

<a id="credentials-events"></a>

### `credentials/*` events

<a id="credentialsrecord-updated--emit"></a>

#### `credentials/record-updated` — emit

Committed change to a stored credential record: a `modifyRecord` that wrote, a `deleteRecord` that removed, or an external edit observed in storage. Separate from `credentials/reference-updated` because the two key grammars are disjoint — a listener that received both on one event could not tell which space a subject belongs to. Listener failures are contained on the same terms as `credentials/reference-updated`.

```ts cordis-catalog
/**
 * Committed change to a stored credential record: a `modifyRecord` that
 * wrote, a `deleteRecord` that removed, or an external edit observed in
 * storage. Separate from `credentials/reference-updated` because the two key
 * grammars are disjoint — a listener that received both on one event could
 * not tell which space a subject belongs to. Listener failures are
 * contained on the same terms as `credentials/reference-updated`.
 * @param key - the record whose stored value changed.
 * @mode emit
 */
'credentials/record-updated'(key: CredentialKey): void
```

Source: [`packages/credentials/credentials/src/types.ts`](../../packages/credentials/credentials/src/types.ts)

<a id="credentialsreference-updated--emit"></a>

#### `credentials/reference-updated` — emit

Committed change to a provider-managed credential source: a `set`, an `unset`, or an external edit observed in storage. Ambient process-environment changes are not observable and never emit. Listener failures are contained and logged — a sync throw and an async rejection alike — without changing the committed operation's outcome.

```ts cordis-catalog
/**
 * Committed change to a provider-managed credential source: a `set`, an
 * `unset`, or an external edit observed in storage. Ambient
 * process-environment changes are not observable and never emit. Listener
 * failures are contained and logged — a sync throw and an async rejection
 * alike — without changing the committed operation's outcome.
 * @param ref - the reference whose stored value changed.
 * @mode emit
 */
'credentials/reference-updated'(ref: CredentialRef): void
```

Source: [`packages/credentials/credentials/src/types.ts`](../../packages/credentials/credentials/src/types.ts)

<a id="deepseek-account-events"></a>

### `deepseek-account/*` events

<a id="deepseek-accountmodel-sign-in-required--emit"></a>

#### `deepseek-account/model-sign-in-required` — emit

An account model request requires the user to sign in.

```ts cordis-catalog
/** An account model request requires the user to sign in.
 * @mode emit
 */
'deepseek-account/model-sign-in-required'(): void
```

Source: [`packages/credentials/deepseek-account/src/types.ts`](../../packages/credentials/deepseek-account/src/types.ts)

<a id="deepseek-accountsession-expired--emit"></a>

#### `deepseek-account/session-expired` — emit

Server rejection removed the current account credential; this notification is not replayed.

```ts cordis-catalog
/** Server rejection removed the current account credential; this notification is not replayed.
 * @mode emit
 */
'deepseek-account/session-expired'(): void
```

Source: [`packages/credentials/deepseek-account/src/types.ts`](../../packages/credentials/deepseek-account/src/types.ts)

<a id="deepseek-accountsigned-out--emit"></a>

#### `deepseek-account/signed-out` — emit

Local grant removal has completed.

```ts cordis-catalog
/** Local grant removal has completed.
 * @mode emit
 */
'deepseek-account/signed-out'(): void
```

Source: [`packages/credentials/deepseek-account/src/index.ts`](../../packages/credentials/deepseek-account/src/index.ts)

<a id="openai-account-events"></a>

### `openai-account/*` events

<a id="openai-accountsign-in-required--emit"></a>

#### `openai-account/sign-in-required` — emit

A provider call needs the user to sign in again; emitted once per cleared session.

```ts cordis-catalog
/**
 * A provider call needs the user to sign in again; emitted once per cleared session.
 * @mode emit
 */
'openai-account/sign-in-required'(): void
```

Source: [`packages/credentials/openai-account/src/types.ts`](../../packages/credentials/openai-account/src/types.ts)

<a id="openai-accountsigned-out--emit"></a>

#### `openai-account/signed-out` — emit

The stored session was removed locally, whether by sign-out or by a rejected refresh grant.

```ts cordis-catalog
/**
 * The stored session was removed locally, whether by sign-out or by a rejected refresh grant.
 * @mode emit
 */
'openai-account/signed-out'(): void
```

Source: [`packages/credentials/openai-account/src/types.ts`](../../packages/credentials/openai-account/src/types.ts)

<a id="verboo-account-events"></a>

### `verboo-account/*` events

<a id="verboo-accountlogin-completed--emit"></a>

#### `verboo-account/login-completed` — emit

A local OAuth grant was committed; the opaque session ID stays in the Host.

```ts cordis-catalog
/**
 * A local OAuth grant was committed; the opaque session ID stays in the Host.
 * @param sessionId - local login identity.
 * @param attemptId - local attempt identity.
 * @param startedAt - UTC timestamp when the user started OAuth, in milliseconds.
 * @param completedAt - UTC timestamp in milliseconds.
 * @mode emit
 */
'verboo-account/login-completed'(sessionId: AccountSessionId, attemptId: SignInAttemptId, startedAt: number, completedAt: number): void
```

Source: [`packages/credentials/verboo-account/src/index.ts`](../../packages/credentials/verboo-account/src/index.ts)

<a id="verboo-accountlogin-started--emit"></a>

#### `verboo-account/login-started` — emit

A new local OAuth attempt is starting.

```ts cordis-catalog
/**
 * A new local OAuth attempt is starting.
 * @param attemptId - opaque local attempt identity.
 * @mode emit
 */
'verboo-account/login-started'(attemptId: SignInAttemptId): void
```

Source: [`packages/credentials/verboo-account/src/index.ts`](../../packages/credentials/verboo-account/src/index.ts)
<!-- END GENERATED cordis-surface -->

The account Service Definition exposes getState, getProfile, getBalance, getUnnotifiedBonuses, ackBonusNotified, startSignIn, cancelSignIn, signOut, watch, and Host-only resolveToken, refreshRejectedToken, rejectToken, and getPlatformSession. The platform provider implements it with an AuthorizationFlow and a private GrantRecord. AccountView distinguishes stored presence from server validation; attempt IDs bind cancellation to one local flow. See [the account package](../../packages/credentials/deepseek-account/README.md).

`AccountClientMetadata` carries `version` from the caller’s `DSH_CLIENT_VERSION`, its active UI `locale`, and `timezoneOffsetSeconds` sampled when the operation begins. The offset is local time minus UTC in seconds: UTC+8 is `28800`. It contains no credentials. Login attempts retain their initiating metadata through exchange and cancellation; sign-out retains its metadata for revocation retries.
