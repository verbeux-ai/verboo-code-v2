---
description: "Verboo Code Chrome 扩展提供方，通过一个本地 Native Messaging 桥接和会话专属浏览器工具连接 Chrome。"
kind: "package-reference"
---

# @deepseek-ai/dsh-browser-use-verboo-extension

[English](README.md) | 中文

## 概述

将 Chrome 中的 Verboo Code 扩展连接到现有 Verboo Host。Host 拥有回环 TCP 服务器，并为每个实时会话提供类型化浏览器工具；Chrome 负责标签页、分组、网页交互、历史记录和下载。

## 目录

- [使用此包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

在 Verboo profile 中挂载 `@deepseek-ai/dsh-browser-use` 与此提供方。Verboo 产品 bundle 会自动执行此操作。Native Messaging 主机通过每用户随机回环端口连接 Host，并使用操作系统应用配置目录中的专用启动文件进行身份验证。

桌面 bundle 会包含 Native Messaging 可执行文件，并在 Verboo Code 启动时安装 Chrome 的每用户主机清单。构建前设置 `VERBOO_CHROME_EXTENSION_ID`，使 Cargo 将同一个扩展 ID 编译进应用和 Native Messaging 主机。发行版必须使用已发布的 Chrome Web Store ID；若 ID 无效或缺失，启动器会拒绝发行版构建。开发构建可使用 Chrome 分配给未打包扩展的 ID。

提供方在每个 Agent 自己的作用域中注册浏览器工具。开始任务会在新的紫色 Chrome 分组中创建后台标签页；该任务打开的页面会加入同一分组。现有标签页可以被查看但不会被移动。任务结束后分组仍会保留。查看到登录、MFA 或 CAPTCHA 挑战时，会将对应标签页置前并等待挑战完成。

提供方最多等待 45 秒以连接 Chrome，并在 Native Messaging 断开后最多重发命令两次。重发会保留请求 ID，使扩展返回缓存结果或报告结果未知，而不是重复执行网页操作。`connectionTimeoutMs` 与 `recoveryRetries` 可调整这些上限。

## 配置

| 字段 | 默认值 | 范围 | 效果 |
| --- | ---: | ---: | --- |
| `connectionTimeoutMs` | `45000` | `1000`–`120000` | 等待 Chrome 连接或重新连接的最长时间。 |
| `recoveryRetries` | `2` | `0`–`2` | Native Messaging 断开后的额外重发次数。 |

-----

<a id="understand-the-implementation"></a>
## 了解实现

桥接仅绑定到 `127.0.0.1`，使用随机 256 位令牌对 Native Messaging 主机进行身份验证，并通过本地套接字传输按行分隔、带版本号的 JSON。Chrome 扩展另一侧使用 Chrome 的长度前缀 Native Messaging 协议。扩展实例标识符会将任务命令路由到创建该任务的 Chrome 配置文件。所有重试会沿用同一个请求 ID。Chrome 在 session storage 中缓存最多 4 MiB 的近期响应，并在 local storage 中保留持久请求标记；Host 收到响应后会发送确认消息，让扩展清除两者。扩展重新加载后，若只剩标记而没有 session 响应，扩展会报告结果未知，而不会重复执行网页操作。

提供方公开 `browser_task_start`、`browser_task_recover`、`browser_task_finish`、`browser_tabs_list`、`browser_tab_open`、`browser_page_observe`、`browser_page_act`、`browser_history_search`、`browser_downloads_search` 与 `browser_attention_raise`。如果 Chrome 在创建任务后、返回结果前断开连接，只要扩展任务 session 仍然可用，`browser_task_recover` 就会使用同一个任务 ID 恢复该任务。如果扩展或浏览器重启清除了 session，持久标记会阻止重复创建，并停止恢复以供检查。工具使用 DSH 标准执行管线与 Session 日志。任务标识符仅属于创建它的会话。

Chrome Manifest V3 源码与 Chrome Web Store 打包流程位于独立的 [verboo-code-browser-extension 仓库](https://github.com/verbeux-ai/verboo-code-browser-extension)。此提供方保留在 Host 侧。面向模型的工具 schema 由 [`src/index.ts`](src/index.ts) 中的类型化定义注册。

-----

<a id="model-experience"></a>
## 模型体验

### 产品集成

#### 模型看到什么

每个会话都会获得类型化 Chrome 工具目录。网页结果包含可见文本与控件；密码与验证码内容会被排除。确认存在登录、MFA 或 CAPTCHA 挑战后，观测工具会暂停，直到用户在 Chrome 中完成处理。

#### Token 影响

工具 schema 只会添加到拥有这些工具的会话作用域中。网页快照和操作结果作为普通工具结果，可能增加模型上下文。

#### KV Cache 影响

提供方加载期间工具定义保持稳定。网页内容与工具结果会作为每次请求的独立内容加入。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 开发运行需要在 `VERBOO_CHROME_EXTENSION_ID` 中设置未打包扩展的 ID；发行版构建需要已发布的 Chrome Web Store ID。若发行版 ID 无效或缺失，启动器会拒绝构建；Chrome Native Messaging 清单会将配置的 ID 写入允许来源。
- 扩展在[独立仓库](https://github.com/verbeux-ai/verboo-code-browser-extension)中版本管理，并作为单独的扩展包上传到 Chrome Web Store。
- Chrome 重启或扩展重新加载时会清除其 session storage。这些事件会使活动任务引用失效；桥接断开后，Host 会报告结果未知。
- 已发送到 Chrome 的浏览器操作无法通过取消撤销。

<a id="dev-note"></a>
### 开发备注

无。
