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

The `verboo` profile mounts this plugin. `refreshIntervalMs` controls visible-window refresh (5000ms); `staminaRefreshIntervalMs` controls stamina reads (2000ms); `handoffTimeoutMs` bounds authorization and checkout reconciliation (180000ms). [Config](src/config.ts) validates these settings. Enable **Stamina (debug)** in Preferences, or set the Host-backed `staminaDebug` option (default `false`), for exact server percentages, plan names, server reading times and a manual refresh. The switch persists through the shared configuration form and reports refused writes without claiming success. Diagnostics share the water indicator’s resource; they never estimate local consumption or display inference speeds.

Server-selected accounts see stamina as water inside the Send/Stop button, surrounded by a thin purple ring. The liquid and diagnostics follow the accepted composer model, matching its routing slug from subscriptions or the catalog to the server group ID. Other enrollments never supply a fallback percentage. Missing or ambiguous group metadata leaves the reading unknown; debug names the selected group when its stamina is unavailable. Its decoration preserves the original arrow, actions, disabled state and keyboard focus. Reduced-motion preferences stop the waves. The account-addressed resource pauses reads while hidden or offline, retains the last confirmed value after failures and discards old responses on account changes. Exact generation speeds and rate ceilings stay out of the interface and tooltips. The interface exposes no budget or pricing data. Stamina appears only in Chat; plan, connection and preference pages omit the reading.

Conversation rows are compact and single-line, reserve a separate menu column and truncate long titles. A small spinner precedes the title only while that conversation is working; inactive rows have no status text or indicator space. The composer shows pending user interaction, startup, reconnection and failure feedback from the existing Session and transport services, and occupies no space while idle. Connections separates owned accounts, the user’s own MCP servers and the catalog. The catalog starts closed: it offers one card per category with its service count, and choosing a category reveals only its services, forty at a time. A search looks across every category without choosing one, and the category list returns in one click. A service card and its owned account show the catalog’s brand mark beside the name, falling back to a product glyph when the catalog carries none or the mark fails to load. Public services are available without a sign-in flow. An MCP server is defined in one dialog — name, transport, endpoint or command, and its header or environment keys — validated before it can be saved, and testable without saving. Secret values are submitted once, stored by the Host and never shown again; editing a server lists its keys with blank values. Enabling, testing and removing a server are one click or one confirmation away, and a removal withdraws its stored secrets.

Plans appear in comparable cards with server prices, full descriptions and one action per plan. Billing-period tabs appear only when the catalog offers both periods. Previous canceled or expired subscriptions stay collapsed; payment issues remain visible. Unknown catalog prices open the website without implying a free offer. Purchases and management retain the authenticated browser flow.

The product follows the Verboo Code web app with a neutral near-black dark palette, a `verboo:code` wordmark, local Nunito fonts, neutral message bubbles with readable foregrounds and restrained control accents. The Assistant mark uses a Chat slot; composer focus and bubble foreground use optional theme tokens. No service or account credentials are included in these assets.

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
