---
kind: upgrade-guide
description: "The desktop development commands launch Tauri instead of Electron."
---
# Tauri desktop development

English | [中文](guide.zh.md)

## Change

`pnpm run dev:desktop` and `pnpm run start:desktop` open the Verboo Code Tauri application. The shared Node profile still owns agents, sessions, credentials, tools, plugins and the authenticated local API. Tauri uses the operating system's WebView instead of shipping Electron's Chromium runtime.

The development application uses `apps/desktop/.desktop-build/tauri/home`. It does not overwrite the earlier Electron development home. An explicit `DSH_HOME` selects an existing home; review its profile configuration before reusing it. Electron-specific preload APIs, installer formats and updater endpoints are not Tauri interfaces.

## Migration

1. Install the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for the current operating system, including Rust and native development tools.
2. Run `pnpm install` from the repository root.
3. Run `pnpm run dev:desktop`. After a successful repository build, `pnpm run start:desktop` reuses the artifacts.
4. Confirm that the Verboo Code native window opens, a workspace can be selected, and closing the application stops its Node Host. See the [desktop reference](../../../../apps/desktop/tauri/README.md) for build and development commands.
