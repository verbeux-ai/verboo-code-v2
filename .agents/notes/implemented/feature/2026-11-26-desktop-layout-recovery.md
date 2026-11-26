# Agent Note: Desktop layout recovery

Status: implemented

English | [中文](2026-11-26-desktop-layout-recovery.zh.md)

## Problem

The desktop Host receives a new loopback port at each launch, so browser origin storage cannot retain sidebar layouts or terminal bindings across application restarts. A retained terminal tab must not claim that its previous Host process still exists.

## Decision

The owned Tauri window mirrors a bounded allowlist of sidebar preferences, right-sidebar session layouts, terminal bindings and shell preferences into native app data. It restores these keys before Client modules initialize. Native writes serialize through a process lock and replace the saved snapshot atomically. Web storage behavior remains independent. The sidebar restores terminal tabs using their previous identity; when the Host reports a missing process, the existing unavailable view offers a fresh terminal without starting it automatically.

## Alternatives considered

**Use the loopback origin alone.** Each launch chooses a new port, so browser storage cannot recover the previous layout. A fixed port would also conflict with concurrent windows.

## Consequences

Only layout and terminal bookkeeping are mirrored; credentials and conversation contents are excluded. Each Session retains its own right-sidebar layout, while frame widths are window-wide preferences. Processes and terminal output do not survive Host shutdown. Invalid or unavailable storage falls back to the in-memory layout.

## Related

- [Desktop runtime](../../../../apps/desktop/tauri/README.md)
- [Right sidebar](../../../../packages/client/ui-sidebar-right/README.md)
- [Terminal](../../../../packages/client/ui-sidebar-terminal/README.md)
