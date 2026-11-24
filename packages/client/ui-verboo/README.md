---
description: "Use the Verboo Code onboarding, project navigation, connections and subscription pages. Neutral surfaces, a small Verboo accent, the official icon and Lucide replacements are owned here."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-verboo

English | [中文](README.zh.md)

<a id="summary"></a>
## Summary

Use the Verboo Code onboarding, project navigation, connections and subscription pages. Neutral surfaces, a small Verboo accent, the official icon and Lucide replacements are owned here.

ChatGPT login and usage require the injected `remote.openaiAccountLogin` and `remote.llmOpenaiAccount` services. Successful login publishes the returned account status to the interface. Usage readings use the subscription route’s types re-exported by the Client Remote assembly; this package declares no separate subscription namespace.

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

The `verboo` profile mounts this plugin. `refreshIntervalMs` controls visible-window account and trial refresh (5000ms); `staminaRefreshIntervalMs` controls stamina reads (2000ms); `handoffTimeoutMs` bounds authorization and checkout reconciliation (180000ms). [Config](src/config.ts) validates these settings. Enable **Stamina (debug)** in Preferences, or set the Host-backed `staminaDebug` option (default `false`), for exact server percentages, plan names, server reading times and a manual refresh. The switch persists through the shared configuration form and reports refused writes without claiming success. Diagnostics share the water indicator’s resource; they never estimate local consumption or display inference speeds.

Server-selected accounts see stamina as water inside the Send/Stop button, surrounded by a thin purple ring. The liquid and diagnostics follow the accepted composer model, matching its routing slug from subscriptions or the catalog to the server group ID. Other enrollments never supply a fallback percentage. Missing or ambiguous group metadata leaves the reading unknown; debug names the selected group when its stamina is unavailable. Its decoration preserves the original arrow, actions, disabled state and keyboard focus. Reduced-motion preferences stop the waves. The account-addressed resource pauses reads while hidden or offline, retains the last confirmed value after failures and discards old responses on account changes. Exact generation speeds and rate ceilings stay out of the interface and tooltips. The interface exposes no budget or pricing data. Stamina appears only in Chat; plan, connection and preference pages omit the reading.

Conversation rows are compact and single-line, reserve a separate menu column and truncate long titles. A small spinner precedes the title only while that conversation is working; inactive rows have no status text or indicator space. The composer shows pending user interaction, startup, reconnection and failure feedback from the existing Session and transport services, and occupies no space while idle. Connections separates owned accounts, the user's own MCP servers and the catalog. MCP servers are this page's own inventory, so they follow the account lists without a heading of their own: the page heading carries one Add MCP server action beside Refresh, and the Active MCP servers tally scrolls to the same list. The catalog starts closed: it offers one card per category with its service count, and choosing a category reveals only its services, forty at a time. A search looks across every category without choosing one, and the category list returns in one click. A service card and its owned account show the catalog’s brand mark beside the name, falling back to a product glyph when the catalog carries none or the mark fails to load. Public services are available without a sign-in flow. An MCP server is defined in one dialog — name, transport, endpoint or command, and its header or environment keys — validated before it can be saved, and testable without saving. A remote MCP server chooses how it authenticates: static headers, or OAuth, where one Sign in action opens the browser and the Host keeps the resulting token. A server the browser flow cannot reach accepts a pasted token instead, and Sign out drops the grant. Secret values are submitted once, stored by the Host and never shown again; editing a server lists its keys with blank values. Enabling, testing and removing a server are one click or one confirmation away, and a removal withdraws its stored secrets.

Plans appear in comparable cards with server prices, full descriptions and one action per plan. Billing-period tabs appear only when the catalog offers both periods. Previous canceled or expired subscriptions stay collapsed; payment issues remain visible. Unknown catalog prices open the website without implying a free offer. Plan management retains the authenticated browser flow; trial offers and authorization also run inside the app.

Conversations start in one pane. The New Conversation page keeps navigation on screen and offers no collapse control, since there is no conversation to give the width to. Inside a conversation the toggle collapses it to a 56px icon rail or expands it again; collapsing is a slide plus crossfade — the content fades in place at its frozen expanded width while the frame's column slides and clips it, and the rail layout applies only after the fade settles, so no row reflows mid-slide. Reduced-motion preferences disable both transitions. Search expands a collapsed rail before it takes focus. Split a focused pane right with Command+D on macOS or Control+D on Windows, or below with Shift added. Option+Command+arrows on macOS and Alt+Control+arrows on Windows move between panes. Up to four panes retain independent Session references and reuse the shared Conversation content, composer and action registrations. Escape stops the selected pane’s running response; Up and Down in the composer recall its sent messages and restore the current draft. A pane’s title and chevron form a visible control that opens a compact conversation search. Split headers use a distinct neutral surface. The chooser inherits the pane’s project; changing it filters recent conversations and sets the project for new ones. Search receives focus, arrows navigate results and Enter opens a match. Open conversations are marked, and project names are not repeated within filtered results; selecting an already visible conversation focuses its pane. Closing a pane releases its view without stopping or deleting the conversation. Dividers support dragging and arrow keys; minimum leaf dimensions are controlled by `minimumPaneWidth` and `minimumPaneHeight`. The Host-backed volatile `paneLayout` setting stores conversation identities, focus and proportions across application restarts without reloading the product plugin. Narrower windows keep the arrangement in a scrollable workspace. Global pages preserve mounted conversations while hidden. Split panes use 1.5px purple gutters with an 8px drag target and focus emphasis only on the shared dividers and composer, without a purple pane outline; header controls remain visible on the selected pane; inactive headers reveal their controls on hover or keyboard focus, while touch keeps them available. Pane action tooltips show platform shortcuts, and Preferences contains a compact pane-shortcut reference. Header controls keep a stable row height while collapsed or revealed, including background-job labels. Inline conversation choices are ordinary actions rather than popup menus, so an empty pane does not block split or navigation shortcuts. Command+W on macOS and Control+W on Windows close the focused view; closing the last view leaves an empty selector. The composer stays open: its whole control row is present while empty, while running, and when keyboard focus moves between panes, so only the draft’s own height grows. The selected pane keeps a solid 1px purple composer stroke even when focus is in its history, and the stroke and focus ring fade between pane focus states instead of snapping, honoring reduced-motion preferences. Clicking an inactive input selects its pane without opening editing; clicking the selected input or entering text starts editing. Drafts and attachments keep their existing expanded presentation. Preferences exposes a Host-backed global `minimalist` setting: all current and future panes omit the assistant avatar and keep user messages in subtle neutral bubbles aligned to the right, with assistant replies as plain text on the left. Switching appearance preserves the existing editors, history and running agents.

The product follows the Verboo Code web app with a neutral near-black dark palette, a `verboo:code` wordmark, local Nunito fonts, neutral message bubbles with readable foregrounds and restrained control accents. The Assistant mark uses a Chat slot; composer focus and bubble foreground use optional theme tokens. No service or account credentials are included in these assets.

Trial attention uses the server's commercial snapshot: the composer notice appears within 24 hours of expiry or at 20% remaining tokens, and shows the reported token balance. Actual expiry opens a dismissible Pro offer with other plans and their descriptions. Dismissals last for this app window; starting the app again offers conversion again. The focused composer's server group controls attention, so paid individual or team access does not inherit another group's expired trial.

Offers show USD catalog prices and require explicit payment authorization. Saved cards show only brand and last four digits. Pix selection fetches a separate, expiring BRL quote and shows the recurring amount and bank authorization ceiling before confirmation. Browser steps handle card setup, payment collection or additional authentication; returning from them never grants access. Recovery keeps the original account and attempt, including across restarts. Deploy the backend trial-status/card-summary changes and migration 0386 before this client; Pix also requires the backend's Brazilian primary-account capability and fresh official FX cache. Trial attention does not alter model prompts, token budgets or KV cache.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals</summary>

Components receive renderer-bound hooks and commands. The presenter discards responses from an earlier account generation, joins concurrent reads, retains valid data on refresh failures, and reconciles created OAuth links even when browser navigation fails. Dialog errors stay with their owning dialog. Subscription status comes from the server; browser callbacks never establish payment.

The product registers `conversation.hero.intro` for its quiet opening question and `conversation.chat.running.indicator` for a neutral pulse. Shared Chat defaults remain available to other profiles.

The product sidebar declares its own footer seat, `verboo.sidebar.foot`, and renders it above the plan shortcut; the desktop update row occupies it. Until the first account read answers, the entry screen shows only the brand and the account-check spinner, because the welcome copy and sign-in button describe a state nobody has observed yet.

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
