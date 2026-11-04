# Agent Note: Tauri desktop carrier with a Node profile Host

Status: implemented

English | [中文](2026-11-04-tauri-desktop-carrier.zh.md)

## Problem

Verboo Code needs a Tauri desktop application while retaining the existing agent, plugins, sessions and authenticated Web application. Replacing the Node engine together with the native window would duplicate those services and change plugin execution.

## Decision

Tauri owns the native window and its operating system WebView. A private, standalone Node process runs the product `verboo` profile layered over the shared Web and base bundles. Its versioned stdout channel reports readiness without printing bootstrap credentials in the native log; stdin owns graceful shutdown. Rust validates the local bootstrap origin before navigation and grants native directory selection only to the owned window at that origin. The initial Host document establishes the same-site context before the token exchange; this preserves the existing Strict-cookie policy in packaged WebKit. The client uses its existing Web keyboard and account adapters; Electron-specific document markers are absent.

The product layer supplies Verboo OAuth, neutral editor chrome, plans and per-user service connections. It replaces providers and interface entries through composition IDs; optional hero and running-indicator Slots and removable theme/icon overrides keep the shared Chat engine reusable. Composio credentials stay in the central backend, which derives each connection owner from the authenticated account.

Native packaging traverses workspace dependencies and peer dependencies, packs their built artifacts, preserves reviewed dependency patches and build-script decisions, and tests the resulting installation with the checksum-verified official Node binary before publication to the local build directory. Development state stays outside the runtime payload.

This partially supersedes the carrier mechanisms in the [shared Web application decision](2026-09-10-desktop-web-wrapper.md). Backend reuse remains current. The Electron source, installer tests and [Electron packaging rationale](2026-08-25-electron-desktop-packaging-and-updates.md) remain as legacy tooling, so those records are retained rather than archived. Their Electron preload, updater and background-window behavior do not define Tauri behavior.

## Alternatives considered

**Keep Electron as the desktop default.** This does not implement the requested framework change.

**Port the agent engine to Rust.** This replaces the plugin runtime and persistence consumers unnecessarily. The shared Node profile preserves their ownership.

**Deploy only dependency edges.** This omits workspace-only peer providers. The standalone runtime must include and test the complete peer closure.

## Consequences

The default desktop commands launch Tauri. Closing the application disposes the Host instead of using the Electron tray lifecycle. Native release credentials and update services require Tauri-specific configuration; the legacy Electron release tools remain distinct. Real-profile Node integration tests, Rust lifecycle tests and the native client-ready signal validate startup and teardown without model credentials.
