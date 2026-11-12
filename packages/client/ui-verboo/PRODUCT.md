# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Product Purpose

Verboo Code is a desktop coding assistant with projects, conversations, account-authorized models and connected tools. The Tauri desktop embeds the shared browser interface.

## Users

People working on several independent agent conversations and monitoring them together. The current brief comes from Mafra's use of dynamically split Ghostty panes.

## Capabilities and Constraints

Start with one conversation and allow at most four dynamically split, resizable panes. Reuse the shipped conversation renderer, composer, session services and product appearance. Each pane has one independent conversation; selecting an already visible conversation focuses its pane. Preserve drafts and running work when changing or closing a pane. Restore the saved arrangement and start with the left sidebar collapsed. Plans, Connections and Preferences retain their current pages; returning restores the conversation arrangement. The right sidebar follows the focused conversation. A global minimal conversation mode in Preferences follows the supplied ChatGPT conversation reference: replies on the left without the Boo avatar, and user messages in subtle neutral bubbles on the right across every pane. Purple pane gutters are 1.5px wide, with larger resize targets. Empty composers collapse to one line at rest and during generation, expanding on a click into the input, text entry, drafts and attachments. Selecting a pane by pointer or shortcut keeps an empty composer compact with a purple stroke on that pane; restoring its caret alone does not start editing. Clicking an inactive input first selects its pane; another click in the selected input opens editing. Conversation choices inherit and filter by project, identify open conversations and support search with arrow/Enter navigation in a plain list with one title. New conversations default to DeepSeek V4.1 Flash; every conversation can select its own model without changing that default. Closing a pane leaves running work intact; quitting the application requires confirmation.

## Brand Commitments

Preserve the existing Verboo Code interface and the rules in AGENTS.md. This feature extends the current application without a separate prototype or new visual identity.

## Product Principles

- Keep each conversation's input, output and approvals independent.
- Make the focused pane and conversation selection explicit.
- Preserve existing components and services wherever their public composition supports reuse.


## Navigation and quit refinements

Collapsed navigation previews over the chats on pointer hover, search or keyboard focus; it does not resize conversations. A pin keeps the existing sidebar open. Focus is indicated by the composer and internal split dividers, never a purple outline around the pane. Desktop quit requires two Command+Q or Control+Q presses within three seconds, cancelled by Escape or focus loss; menu and window-close confirmation remain available.

The selected split pane keeps its header actions visible. Inactive pane controls appear on hover or keyboard focus. Pane action tooltips show the platform's shortcuts, and Preferences includes a compact reference for splitting, moving between and closing panes.
