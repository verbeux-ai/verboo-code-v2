---
description: "Use the Verboo Code onboarding, project navigation, connections and subscription pages. Neutral surfaces, a small Verboo accent, the official icon and Lucide replacements are owned here."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-verboo

English | [中文](README.zh.md)

<a id="summary"></a>
## Summary

Use the Verboo Code onboarding, project navigation, connections and subscription pages. Neutral surfaces, a small Verboo accent, the official icon and Lucide replacements are owned here.

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

The `verboo` profile mounts this plugin. `refreshIntervalMs` controls visible-window refresh (5000ms); `staminaRefreshIntervalMs` controls stamina reads (2000ms); `handoffTimeoutMs` bounds authorization and checkout reconciliation (180000ms). [Config](src/config.ts) validates all three settings.

Server-selected accounts see stamina below the conversation composer and on My plan. Both views share one account-addressed resource, pause reads while hidden or offline, and retain the last confirmed value with a notice after failures. Account changes discard old responses. Percentages and next-request ceilings come from the server; ongoing responses retain their admitted speed. The interface exposes no budget or pricing data.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals</summary>

Components receive renderer-bound hooks and commands. The presenter discards responses from an earlier account generation, joins concurrent reads, retains valid data on refresh failures, and reconciles created OAuth links even when browser navigation fails. Dialog errors stay with their owning dialog. Subscription status comes from the server; browser callbacks never establish payment.

The product registers `conversation.hero.intro` for its quiet opening question and `conversation.chat.running.indicator` for a neutral pulse. Shared Chat defaults remain available to other profiles.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Architecture](../../../docs/architecture.md) — shared Cordis engine.
- [Desktop runtime](../../../apps/desktop/tauri/README.md) — development and builds.

<a id="model-experience"></a>
## Model Experience

### Product integration

#### What the model sees

`ProductModel` adds no model input through the interface; user submissions remain owned by the conversation.

#### Token effect

None; interface preferences and account metadata do not enter prompts.

#### KV Cache effect

Stable tools and prompt prefixes remain unchanged; user submissions and tool results append to the existing Session.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Checkout and account authorization open the official website or hosted OAuth in the system browser. A closed app does not continue polling.

<a id="dev-note"></a>
### Dev Note

None.
