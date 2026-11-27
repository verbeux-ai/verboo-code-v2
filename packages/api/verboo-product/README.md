---
description: "Read the signed-in user’s plans and connections, open a trusted commercial handoff, and authorize external services. All API calls resolve the current Host-held Verboo grant."
kind: "package-reference"
---

# @deepseek-ai/dsh-api-verboo-product

English | [中文](README.zh.md)

<a id="summary"></a>
## Summary

Read the signed-in user’s plans and connections, open a trusted commercial handoff, and authorize external services. All API calls resolve the current Host-held Verboo grant.

<a id="table-of-contents"></a>
## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

The `verboo` profile mounts this service beside the account provider. Its [Config](src/index.ts) accepts the public API origin, router URL and explicit development loopback setting. Composio project credentials belong only to the central backend.

Stamina reads return the primary percentage and next-request TPS only for server-enrolled plans. An empty list hides the feature; HTTP404 also supports older deployments without this endpoint. Other failures remain failures, and account replacement invalidates pending reads. Budgets, costs and tariffs never enter this projection. Plans and subscriptions preserve optional server routing slugs so the Client can join a model route to its group ID; older API projections may omit them.

The Plans checkout holds the signed card quote in the Host and durably saves the account-scoped request, attempt IDs and exact short-lived authorization before confirmation. Recovery reads the server’s canonical attempt, including an earlier checkout reused by the server. Subscription management displays server-authorized actions, signed plan-change previews, cancellation progress, and invoice links.

Authenticated historical usage reads expose subscription and per-plan totals for the requested period and a year of daily activity. The Client receives only the counts and token fields needed by the Analytics page; account replacement invalidates pending responses. A Host-only authenticated stream exposes server-measured or estimated account generation speed, without forwarding tickets, credentials or concurrency data.

Connections requests opt into the complete provider catalog with `catalog=all` and accept up to 10,000 toolkit records, including authorization method and server configuration requirements. A record may carry a brand mark as an absolute `logo` URL, which the Connections page shows beside the service name; a blank, null, or absent value means the page keeps its own placeholder, and the catalog read fails on any other value. Older APIs may omit this metadata. Agent listing returns only owned accounts and public services (`public_<slug>`), keeping the full discovery catalog out of model input. The backend revalidates public services as requiring no credentials before tool search or execution. Catalog reads use `connectionListTimeoutMs`, defaulting to 40 seconds; provider searches and executions have separate `connectionSearchTimeoutMs` and `connectionExecutionTimeoutMs` deadlines, defaulting to 120 and 75 seconds respectively. Execution is never retried; a timeout leaves its outcome unconfirmed.

Trial commerce reads server-decided attention and exposes display-only offers to the Client. Signed conversion and checkout authorizations remain in the Host's bounded, expiring quote cache. Every request captures its owning account, and confirmation rechecks that identity before submitting the exact offer. A quote, card setup, plan transfer and payment confirmation remain distinct operations. The server’s `X-Verboo-Quote-Rejected` marker releases a rejected authorization for a fresh quote only when no charge started; an unconfirmed write retains its original recovery identity. New Pix checkouts use a separately signed BRL quote; pending purchases resume their original attempt. Payment URLs are restricted to the supported Stripe destinations. Commercial endpoints remain owner-only in shared sessions; this data is not exposed to the model or its context cache.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals</summary>

Each request captures the installation session and rejects a response after account replacement. Remote exposes only display data, short-lived authorization links and public billing URLs. Agent execution stays Host-only and delegates ownership checks to the central backend. An unconfirmed provider write must be inspected before repeating it.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Architecture](../../../docs/architecture.md) — shared Cordis engine.
- [Desktop runtime](../../../apps/desktop/tauri/README.md) — development and builds.

<a id="model-experience"></a>
## Model Experience

### Product integration

#### What the model sees

`VerbooProduct` registers no prompt or tool schema. The connections extension owns the model-visible tools and recorded results.

#### Token effect

None directly; downstream tools own returned result tokens.

#### KV Cache effect

Stable tools and prompt prefixes remain unchanged; user submissions and tool results append to the existing Session.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Catalog and subscription loading require both central API projections. Payment and entitlement decisions remain on the Verboo website and backend.

<a id="dev-note"></a>
### Dev Note

None.
