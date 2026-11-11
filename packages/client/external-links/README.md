---
description: "One policy for every external destination: Sidebar Browser, granted popup, or Desktop native opener."
kind: package-reference
---

# @deepseek-ai/dsh-client-external-links

English | [中文](README.zh.md)

## Summary

Every exit from the app to a destination outside it goes through one service. Markdown anchors, tool rows, settings links, plugin-market facts, and context menus call `ctx.externalLinks.open()` instead of reaching for `window.open` themselves. The service decides the destination, refuses what the app does not open, and shows a notice when nothing opened.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Inject `externalLinks` from a plugin that links out of the app, and route every user gesture through it:

```ts ignore-check
await ctx.externalLinks.open(url)
```

`open(url, { signal })` resolves to `'sidebar'`, `'window'`, `'native'`, or `'blocked'`. A refusal publishes the localized notice on `shell.overlay`; callers do not build their own failure copy. `begin()` reserves a popup during a gesture whose URL arrives after an async Host step (sign-in handoff), and `end()` retires an unused reservation. `setPreference('new-tab')` sends ordinary clicks to a separate window whenever the consumer's preference changes.

Components never see the service. A feature passes callbacks through its inject face; the Markdown renderer receives them as `MarkdownDelegateProvider` handlers.

### Accepted destinations

The policy is a positive allowlist: `http:`, `https:`, `mailto:`, and `tel:`. Embedded credentials reject the URL. Everything else — `file:`, `ftp:`, `ssh:`, `javascript:`, `data:`, `blob:`, and custom schemes — is refused before any window opens.

### Destinations

- Desktop, when the Tauri bridge exposes `openExternal`: the system browser, with no competing popup.
- Web with the Sidebar Browser registered and the `sidebar` preference: a right-Sidebar Browser tab.
- Otherwise: a popup the browser granted, replacing the reserved `about:blank` location. `mailto:` and `tel:` hand off through an anchor instead, because they leave the document rather than load a page.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals</summary>

`links.ts` holds the policy as a class over injected dependencies (`native`, `openWindow`, `sidebar`, `openSidebar`, `preference`, `report`), so the same branches are exercised without a browser. The Desktop bridge is read once per activation. `index.ts` provides `ctx.externalLinks` and registers the `shell.overlay` notice. Reservation state belongs to the service instance, which the plugin fiber disposes.

</details>

<a id="model-experience"></a>
## Model Experience

None, as choosing where a click opens adds no model input or Session event.

#### KV Cache effect

None; this plugin neither constructs nor sends model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The Sidebar Browser renders only `http:`/`https:`; other accepted schemes always leave the app, which the destination below `sidebar` expresses as `'window'`.
- Sidebar availability is read from `sidebarRightTabs` at click time. A profile without that service opens every browsable destination in a window.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers</summary>

None.

</details>
