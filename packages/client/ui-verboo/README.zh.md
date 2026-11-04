---
description: "使用 Verboo Code 的引导、项目导航、连接和订阅页面。中性配色、少量 Verboo 点缀、官方图标与 Lucide 图标替换均由此包管理。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-verboo

[English](README.md) | 中文

<a id="summary"></a>
## 概述

使用 Verboo Code 的引导、项目导航、连接和订阅页面。中性配色、少量 Verboo 点缀、官方图标与 Lucide 图标替换均由此包管理。

<a id="table-of-contents"></a>
## 目录

- [使用此包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用此包

`verboo` 配置会加载此插件。`refreshIntervalMs` 控制可见窗口的刷新间隔（5000ms）；`staminaRefreshIntervalMs` 控制耐力读取间隔（2000ms）；`handoffTimeoutMs` 限制授权和结账核对时间（180000ms）。[Config](src/config.ts) 校验这三项设置。

服务器选定的账号会在对话输入框下方和“我的订阅”中看到耐力。两个视图共享按账号寻址的资源，在窗口隐藏或离线时暂停读取，失败后保留上次确认的数据并显示提示。账号变化会丢弃旧响应。百分比和新请求上限来自服务器，进行中的响应保持准入时的速度。界面不公开预算或定价数据。

对话行使用独立的菜单列，长标题保持单行并在下方显示执行状态。输入框也通过现有的 Session 和连接服务显示空闲、处理、等待用户操作、启动、重连和失败状态。连接断开时不会显示已确认的空闲状态。连接页面按名称或 slug 搜索服务器的完整目录，每次显示四十项；公共服务无需登录即可使用。

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节</summary>

组件接收渲染器绑定的 hook 与命令。展示模型会丢弃旧账号的响应、合并并发读取、刷新失败时保留有效数据，并在浏览器打开失败时核对已创建的 OAuth 链接。对话框错误由各自的对话框显示。订阅状态来自服务器，浏览器回调不能证明付款。

产品通过 `conversation.hero.intro` 显示简洁的开场问题，通过 `conversation.chat.running.indicator` 显示中性的脉动圆点。其他配置仍可使用共享 Chat 的默认界面。

</details>

<a id="further-exploration"></a>
## 延伸阅读

- [架构](../../../docs/architecture.zh.md) — 共享的 Cordis 引擎。
- [桌面运行](../../../apps/desktop/tauri/README.zh.md) — 开发与构建。

<a id="model-experience"></a>
## 模型体验

### 产品集成

#### 模型看到什么

`ProductModel` 不通过界面添加模型输入；用户提交仍由对话功能处理。

#### Token 影响

无；界面偏好与账号元数据不会进入提示词。

#### KV Cache 影响

稳定的工具与提示词前缀保持不变；用户提交和工具结果追加到现有会话。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 结账与账号授权会在系统浏览器打开官方网站或托管 OAuth 页面。应用关闭后不会继续轮询。

<a id="dev-note"></a>
### 开发备注

无。
