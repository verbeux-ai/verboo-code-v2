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

Conversations start in one pane with the left navigation collapsed. Hovering its rail reveals the existing navigation as a temporary overlay without resizing chats; keyboard focus and the search action also reveal it. Leaving closes the preview unless navigation retains focus or an open menu. Its pin action uses the existing persistent sidebar toggle. Split a focused pane right with Command+D on macOS or Control+D on Windows, or below with Shift added. Option+Command+arrows on macOS and Alt+Control+arrows on Windows move between panes. Up to four panes retain independent Session references and reuse the shared Conversation content, composer and action registrations. Escape stops the selected pane’s running response; Up and Down in the composer recall its sent messages and restore the current draft. A pane’s title and chevron form a visible control that opens a compact conversation search. Split headers use a distinct neutral surface, and the compact composer centers its send control. The chooser inherits the pane’s project; changing it filters recent conversations and sets the project for new ones. Search receives focus, arrows navigate results and Enter opens a match. Open conversations are marked, and project names are not repeated within filtered results; selecting an already visible conversation focuses its pane. Closing a pane releases its view without stopping or deleting the conversation. Dividers support dragging and arrow keys; minimum leaf dimensions are controlled by `minimumPaneWidth` and `minimumPaneHeight`. The Host-backed volatile `paneLayout` setting stores conversation identities, focus and proportions across application restarts without reloading the product plugin. Narrower windows keep the arrangement in a scrollable workspace. Global pages preserve mounted conversations while hidden. Split panes use 1.5px purple gutters with an 8px drag target and focus emphasis only on the shared dividers and composer, without a purple pane outline; header controls remain visible on the selected pane; inactive headers and secondary composer controls reveal them on hover or keyboard focus, while touch keeps them available. Pane action tooltips show platform shortcuts, and Preferences contains a compact pane-shortcut reference. Header controls keep a stable row height while collapsed or revealed, including background-job labels. Inline conversation choices are ordinary actions rather than popup menus, so an empty pane does not block split or navigation shortcuts. Command+W on macOS and Control+W on Windows close the focused view; closing the last view leaves an empty selector. An empty composer uses one line at rest, while running and when keyboard focus moves between panes. The selected pane keeps a solid 1px purple composer stroke even when focus is in its history. Clicking an inactive input selects its pane without opening editing; clicking the selected input or entering text starts editing and expands it; leaving an empty input collapses it again. Drafts and attachments keep their existing expanded presentation. Preferences exposes a Host-backed global `minimalist` setting: all current and future panes omit the assistant avatar and keep user messages in subtle neutral bubbles aligned to the right, with assistant replies as plain text on the left. Switching appearance preserves the existing editors, history and running agents.

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
