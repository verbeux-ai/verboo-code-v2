---
kind: upgrade-guide
description: The desktop product uses a dedicated Verboo profile and replaces the account, navigation and billing interfaces.
---

# Verboo Code product profile

English | [中文](guide.zh.md)

## Change

The Tauri desktop launches the `verboo` profile, layered over the upstream `web` composition. Verboo OAuth replaces DeepSeek sign-in, plans replace balance and top-up controls, and user-owned connections replace the plugin-management interface. Internal package names and the `deepseek-account` model route remain technical identifiers for existing Sessions.

## Migration

1. Run `pnpm install` and `pnpm run build:artifacts` from the checkout. Start the native app with `pnpm run start:desktop`, or preview with `pnpm dsh --profile verboo --no-open`.
2. Sign in with Verboo. Do not copy a CLI grant or another profile’s storage. The operating system credential store must be available.
3. Configure Composio only in the central backend. Each authenticated Verboo user authorizes their own accounts; the app receives no Composio project key.
4. Confirm the Verboo onboarding and navigation load, the account model appears, and Connections and My plan show server data. The product interface is required at client startup; a failed activation prevents successful boot.

See the [product bundle](../../../../packages/bundle/verboo-app/README.md) for upstream updates.
