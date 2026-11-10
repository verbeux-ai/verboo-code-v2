---
description: "浏览器操作能力包，用于选择与注册一个浏览器后端。"
kind: "package-group"
---

# packages/browser-use

[English](README.md) | 中文

## 概述

浏览器操作提供方让模型检查与操作网页。本组拥有独占提供方注册。实验性提供方提供浏览器工具；Verboo Chrome 提供方将一个现有 Chrome 配置文件连接到会话专属工具。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

选择一个 提供方 并挂载共享注册服务。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`browser-use`](browser-use/README.zh.md) | 独占具名 提供方 注册 | `ctx.browserUse` |
| [`browser-use-verboo-extension`](browser-use-verboo-extension/README.zh.md) | Verboo Chrome Native Messaging 桥接与类型化浏览器工具 | `ctx.browserUse` |

<a id="related-documentation"></a>
## 相关文档

- [浏览器操作](../../docs/subsystems/browser-use.zh.md) — 能力所有权与 提供方 选择。
- [实验包](../experimental/README.zh.md) — Playwright MCP、Chrome DevTools MCP 与 Stagehand 提供方。
- [Verboo 浏览器扩展](https://github.com/verbeux-ai/verboo-code-browser-extension) — 独立的 Chrome 扩展源码与 Web Store 打包流程。

<a id="dev-note"></a>
## 开发备注

无。
