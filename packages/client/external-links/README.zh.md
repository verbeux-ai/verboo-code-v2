---
description: "所有外部目标只有一套策略：侧边栏浏览器、获批弹窗或桌面原生打开器。"
kind: package-reference
---

# @deepseek-ai/dsh-client-external-links

[English](README.md) | 中文

## 概述

离开应用的每一个目标都经过同一个服务。Markdown 链接、工具行、设置链接、插件市场信息与上下文菜单调用 `ctx.externalLinks.open()`，而不是各自调用 `window.open`。该服务决定目标位置、拒绝应用不打开的地址，并在什么都没打开时显示提示。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发说明](#dev-note)

<a id="use-this-package"></a>
## 使用本包

在需要打开外部地址的插件中注入 `externalLinks`，并让每一次用户手势都经过它：

```ts ignore-check
await ctx.externalLinks.open(url)
```

`open(url, { signal })` 返回 `'sidebar'`、`'window'`、`'native'` 或 `'blocked'`。拒绝会在 `shell.overlay` 上发布本地化提示；调用方不再自行编写失败文案。`begin()` 为地址要等异步 Host 步骤（登录交接）的手势预留弹窗，`end()` 释放未使用的预留。消费者的偏好变化时，`setPreference('new-tab')` 把普通点击送往独立窗口。

组件看不到该服务。功能插件通过注入面传递回调；Markdown 渲染器以 `MarkdownDelegateProvider` 处理函数接收它们。

### 接受的地址

策略是正向白名单：`http:`、`https:`、`mailto:` 与 `tel:`。内嵌凭据会使地址被拒绝。其余一切——`file:`、`ftp:`、`ssh:`、`javascript:`、`data:`、`blob:` 以及自定义协议——都在打开任何窗口之前被拒绝。

### 目标位置

- 桌面端，当 Tauri 桥暴露 `openExternal` 时：系统浏览器，不并行打开弹窗。
- Web 端，已注册侧边栏浏览器且偏好为 `sidebar`：右侧边栏浏览器标签页。
- 其他情况：浏览器允许的弹窗，替换预留的 `about:blank` 地址。`mailto:` 与 `tel:` 改为通过锚点交接，因为它们离开文档而不是加载页面。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部</summary>

`links.ts` 以注入依赖（`native`、`openWindow`、`sidebar`、`openSidebar`、`preference`、`report`）的类承载策略，因此同一批分支无需浏览器即可测试。桌面桥在每次激活时读取一次。`index.ts` 提供 `ctx.externalLinks` 并注册 `shell.overlay` 提示。预留状态属于服务实例，随插件 fiber 释放。

</details>

<a id="model-experience"></a>
## 模型体验

无。本插件只改变浏览器中一次点击的去向。

#### KV Cache 影响

无；本插件既不构造也不发送模型请求。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延后工作

- 侧边栏浏览器只渲染 `http:`/`https:`；其他被接受的协议总是离开应用，`sidebar` 之下的目标位置以 `'window'` 表达。
- 侧边栏可用性在点击时从 `sidebarRightTabs` 读取。没有该服务的配置中，所有可浏览地址都在窗口中打开。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文</summary>

无。

</details>
