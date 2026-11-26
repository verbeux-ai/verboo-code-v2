---
description: "Measure consented Verboo desktop response and feature use with a durable, receipt-checked outbox."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-verboo-analytics

English | [中文](README.zh.md)

## Summary

Measure eligible Verboo product use after an explicit product analytics choice. The Host stores the choice and a bounded outbox in the credential provider, sends events to the Verboo collector, and keeps events until a matching receipt arrives. The receiver owns PostHog delivery; no destination secret or conversation content enters the client.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The Verboo product layer mounts the service alongside account, credentials, and session projections.

### When to choose it

Use it in a Verboo composition that can show and change the product privacy choice. A separate advertising choice does not enable this service.

### Minimal configuration

The product bundle supplies the collector origin and surface. Its desktop overlay sets `surface: desktop`; the service also accepts `cli` and `dashboard`.

```yaml
- name: '@deepseek-ai/dsh-host-verboo-analytics'
  config:
    surface: desktop
    appVersion: 'development'
```

The collector must enable product analytics separately. See the [product layer](../../bundle/verboo-app/README.md) for the mounted composition.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

A projection records only bounded response facts for root human turns. Live completed responses create events; replay rebuilds state without resending observations. Consent revision and account ownership guard every queued event. An exact event ID and payload hash receipt permits deletion; denial discards pending events for that grant. Feature calls accept fixed categories, outcomes, and the consent subject captured at action start. They never accept page content, tool names, arguments, prompts, or responses.

The credential store holds a randomly generated installation secret independently of account contexts. The Host sends it to the collector over the collector transport; the collector derives a pseudonym for distinct-installation counts and does not send the account ID to PostHog. The Host does not link an anonymous context to an account. Existing stored records gain the optional secret on their next selection; queued event bytes and their receipts are unchanged. One person using several installations may be counted more than once.

For an authorized desktop root turn with human input, the first nonempty streamed text delta records elapsed time since turn start without its text. This observation can precede a failed or cancelled turn; turns without a text delta have no first-text observation. Completed response duration remains a separate measurement.

Schedule tool calls in such turns record bounded creation, edit, pause, resume, and deletion categories. Only recognizable tool results produce a settled outcome; unknown results are not counted as successes or failures. Task instructions and tool arguments are never sent.

Product interactions include the split and Stop buttons, project adoption, ordinary message gestures, accepted model choices, and snapshots of selected interface preferences. Desktop updater observations distinguish download starts, completions and failures from installation starts and failures; an unattributed updater error has its own category. Failed root human responses are counted without the error code or text; cancellations are excluded. Recovered Host disconnections are counted only when the loss was observed after connection and the same grant remains valid. The collector response may contain regional metadata, which the Host validates without using it to grant collection. A restored ready state or a later app launch does not prove that an observed installation succeeded. Model and effort dimensions are restricted to bounded identifiers from the Verboo, OpenAI account and official DeepSeek catalogs; custom provider and model labels are grouped as `other`. `default` means no explicit effort was observed, not a specific resolved effort. Event counts and distinct installations are separate measures, and preference reports must use each installation's latest observation.

| Source | Responsibility |
|---|---|
| [index.ts](src/index.ts) | Consent, event submission, receipt and account fencing |
| [projection.ts](src/projection.ts) | Eligible response facts |
| [storage.ts](src/storage.ts) | Durable identities and bounded outbox |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Verboo product bundle](../../bundle/verboo-app/README.md) — mounted product composition.
- [Verboo account](../../credentials/verboo-account/README.md) — account session and credentials.
- [Session projections](../../session/session-projection/README.md) — deterministic session facts.

<a id="model-experience"></a>
## Model Experience

None, as the service records product events without contributing model context.

#### KV Cache effect

None; event submission does not change model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The current service has these boundaries.

- The outbox is bounded; persistent credential storage must be available to survive restart.
- CLI mounting and browser-extension instrumentation require their own product compositions.
- Collector acceptance is not proof of PostHog ingestion; confirm the destination independently.
- A request already in flight at revocation may have reached the collector.

<a id="dev-note"></a>
### Dev Note

None.
