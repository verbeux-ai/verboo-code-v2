---
description: "Browser-use capability packages for selecting and registering one browser backend."
kind: "package-group"
---

# packages/browser-use

English | [中文](README.zh.md)

## Summary

Browser-use providers let models inspect and operate web pages. This group owns exclusive provider registration. Experimental providers supply browser tools; the Verboo Chrome provider connects one existing Chrome profile to conversation-scoped tools.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Choose one provider and mount the shared registration service.

| Package | Role | ctx key |
|---|---|---|
| [`browser-use`](browser-use/README.md) | Exclusive named provider registration | `ctx.browserUse` |
| [`browser-use-verboo-extension`](browser-use-verboo-extension/README.md) | Verboo Chrome Native Messaging bridge and typed browser tools | `ctx.browserUse` |

<a id="related-documentation"></a>
## Related documentation

- [Browser use](../../docs/subsystems/browser-use.md) — capability ownership and provider choices.
- [Experimental packages](../experimental/README.md) — Playwright MCP, Chrome DevTools MCP, and Stagehand providers.
- [Verboo browser extension](https://github.com/verbeux-ai/verboo-code-browser-extension) — standalone Chrome extension source and Web Store package workflow.

<a id="dev-note"></a>
## Dev Note

None.
