# Product telemetry

English | [中文](product-telemetry.zh.md)

The [product telemetry plugin](../../packages/host/product-telemetry-otel/README.md) sends explicitly selected analytics events through OTLP/HTTP. Its `productTelemetry` service owns submission only; product consumers own when an event occurs and which fields are approved. The exporter collects no Session data or identifiers automatically. The [Desktop analytics consumer](../../packages/client/product-analytics/README.md) selects interaction and live compaction events, adds cached static environment and available login identity, and follows the Desktop launch-time collection switch. Ordinary Web clients do not collect product events.

`ProductTelemetryRecord` requires an event name, string body, and Unix-millisecond timestamp. Attributes accept scalar strings, numbers, booleans, and one-level objects of those values (`ProductTelemetryScalar`). Optional severity uses OTel severity numbers and defaults to INFO. Observation time is assigned when the record is enqueued.

Enqueue is synchronous and does not acknowledge delivery. The SDK owns batching and retry; local diagnostics report export failures. See the package README for configuration, shutdown, and loss limits.

## Record types

```ts type-equiv
/** Scalar values accepted in product attributes. */
type ProductTelemetryScalar = OTelEventScalar
```

```ts type-equiv
/** Caller-selected ordinary analytics record. */
type ProductTelemetryRecord = OTelEventRecord
```

Source: [`packages/host/product-telemetry-otel/src/index.ts`](../../packages/host/product-telemetry-otel/src/index.ts)

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxproductanalytics--productanalytics"></a>

### `ctx.productAnalytics` — `ProductAnalytics`

Authenticated event intake; disabled instances do not inspect identity or accept new events.

```ts cordis-catalog
/**
 * Read the collection policy.
 * @returns whether this Host currently accepts Desktop analytics.
 */
@Remote enabled(): boolean

/**
 * Stream the effective policy initially and after live configuration edits.
 * @param signal - subscriber lifetime.
 * @returns current policy values until cancellation or service disposal.
 */
@Remote({ mode: 'stream' }) async *watchPolicy(signal: AbortSignal): AsyncIterable<boolean>

/**
 * Submit selected Desktop fields with cached static environment and fresh identity.
 * The first intake waits for bounded environment queries; concurrent intakes share them.
 * Missing identity is omitted; failed environment fields carry fixed reasons.
 * @param event - typed product event without message contents or credentials.
 * @returns after local submission; no delivery or warehouse acknowledgement.
 */
@Remote async report(event: ProductEvent): Promise<void>
```

Source: [`packages/client/product-analytics/src/index.ts`](../../packages/client/product-analytics/src/index.ts)

<a id="ctxproducttelemetry--producttelemetry"></a>

### `ctx.productTelemetry` — `ProductTelemetry`

Host analytics sender. Mounting alone sends nothing; the owning fiber drains it on unload.

```ts cordis-catalog
/**
 * Enqueue one selected product event without waiting for network delivery.
 * Queue admission and shutdown completion are not collector or warehouse acknowledgements.
 * @param record - caller-owned event containing only approved analytics fields.
 */
emit(record: ProductTelemetryRecord): void
```

Source: [`packages/host/product-telemetry-otel/src/index.ts`](../../packages/host/product-telemetry-otel/src/index.ts)

<a id="ctxverbooanalytics--verbooanalytics"></a>

### `ctx.verbooAnalytics` — `VerbooAnalytics`

Host-owned consent, response observation and receipt-checked product outbox.

```ts cordis-catalog
/**
 * Read the product analytics preference and queue status for the current identity.
 * @returns preference for the current identity; unavailable does not grant collection.
 */
@Remote async status(): Promise<ProductAnalyticsStatus>

/**
 * Persist an explicit choice. Refusal blocks locally before any network call.
 * @param decision - product-only choice, independent of advertising.
 * @returns confirmed preference, or a fixed failure without credentials.
 */
@Remote async choose(decision: 'granted' | 'denied'): Promise<ProductConsentResult>

/**
 * Observe one allowlisted feature without tool names, arguments or page data.
 * @param feature - fixed product category.
 * @param outcome - fixed observation outcome.
 * @param subjectId - consent subject observed when the user initiated the action.
 * @param consentRevision - granted revision observed when the action began.
 * @param consentProof - signed reference observed when the action began.
 */
@Remote feature(feature: ProductFeature, outcome: 'started' | 'completed' | 'failed' | 'cancelled', subjectId: ProductAnalyticsSubject, consentRevision: number, consentProof: string): void
```

Source: [`packages/host/verboo-analytics/src/index.ts`](../../packages/host/verboo-analytics/src/index.ts)
<!-- END GENERATED cordis-surface -->
