# Agent Note: DeepSeek request errors and desktop observability

Status: implemented

English | [中文](2026-11-16-deepseek-request-errors-and-observability.zh.md)

## Problem

Desktop users reported recurring HTTP 400 `INVALID_REQUEST` failures, malformed tool-call failures, authentication errors, timeouts, and generic network failures. A DeepSeek account route enabled the provider's thinking format but did not preserve `reasoning_content` when replaying prior assistant tool-call messages. DeepSeek requires that field in subsequent tool-enabled requests; omission can reject the request.

The desktop also showed generic failures without a queryable breakdown by error class, status, model, provider, and release.

## Decision

The Verboo account route now declares `requiresReasoningContentOnAssistantMessages: true`. The pi-ai adapter therefore serializes missing prior assistant reasoning as an empty `reasoning_content` field, preserving the DeepSeek request contract.

For every terminal model-attempt failure, Desktop may send one bounded `desktop_model_error` event to the first-party observability route. The event classifies invalid requests, malformed responses, timeouts, transport failures, authentication, rate limits, pending usage accounting, upstream failures, and unknown errors. The endpoint validates a strict schema, records a Prometheus counter, and forwards detailed bounded fields to the existing PostHog project.

## Data and impact

Events include only bounded error class/code, retryability, HTTP status when available, and sanitized provider/model/app-version identifiers. They exclude account, user, device, session, prompt, response, tool names, tool arguments, and raw provider messages. PostHog disables person profiles and geolocation; Prometheus labels omit provider, model, and version.

Collection is best effort, disabled with the existing product-analytics policy, and bounded by short client/server deadlines. Collector failures do not change a model turn. The extra request occurs only after a terminal error; it does not call the model provider or add model tokens. No automatic model switching is introduced.

## Validation

Focused adapter, account-profile, desktop event, contract, metrics, and route tests cover the corrected request shape, privacy bounds, PostHog forwarding, and collector failure behavior. The front deployment already passes the existing PostHog project settings through the runtime build.

## Alternatives considered

Forwarding raw provider responses was rejected because they may contain prompts, tool data, or account details. Automatic retries and model fallback were excluded because they can change cost and conceal the failing route.

## Consequences

The DeepSeek route now preserves the reasoning field needed to continue tool calls. PostHog and Prometheus can group terminal failures by bounded error and model dimensions without chat content. Other provider and accounting failures remain visible as their own classes; this change does not bypass usage-accounting protection.

## Known limitation

Telemetry can be missing if analytics is disabled, the app exits before the best-effort send completes, or the first-party endpoint is unavailable. PostHog remains optional; Prometheus records delivery failures when its configuration is absent or its endpoint rejects an event.
