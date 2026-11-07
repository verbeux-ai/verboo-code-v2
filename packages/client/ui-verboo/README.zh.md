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

服务器选定的账号在聊天输入框模型选择器的左侧看到紧凑的液体耐力指示器，两者位于同一工具栏行，并在“我的订阅”中看到详细信息。输入框采用已启用订阅中剩余耐力最少的读数，不显示数字或标签；本地化提示说明耐力和过期读数，支持键盘和屏幕阅读器查看。发送／停止按钮保留自己的外观和动作。减少动态效果的偏好会停止波浪。两个视图共享按账号寻址的资源，在窗口隐藏或离线时暂停读取，失败后保留上次确认的数据。账号变化会丢弃旧响应。百分比和新请求上限来自服务器，进行中的响应保持准入时的速度。界面不公开预算或定价数据。

对话行紧凑且保持单行，菜单使用独立的列，长标题会截断。仅当该对话正在处理时，标题左侧才显示小型旋转指示器；非活动对话不显示状态文字，也不预留指示器空间。输入框通过现有的 Session 和连接服务显示处理、等待用户操作、启动、重连和失败反馈，空闲时不占用空间。连接页面将已拥有的账号、用户自己的 MCP 服务器与目录分开呈现。目录初始为收起状态：每个类别显示一张卡片及其服务数量，选择类别后只显示该类别的服务，每次四十项。搜索会跨所有类别查找而无需先选择类别，单击即可返回类别列表。公共服务无需登录即可使用。MCP 服务器在一个对话框中定义——名称、传输方式、端点或命令，以及其请求头或环境变量键——保存前先校验，也可在保存前直接测试。机密值只提交一次，由 Host 保存且不再显示；编辑服务器时只列出键名，值留空。启用、测试与移除只需一次点击或一次确认，移除会一并撤回已保存的机密。

方案卡片展示服务器提供的价格、完整说明与每个方案的一项操作，便于比较。仅当目录包含两种计费周期时才显示周期标签。已取消或过期的订阅默认折叠，付款问题始终可见。目录价格未知时会打开网站，不会暗示免费。购买与管理仍使用经过身份验证的浏览器流程。

产品沿用 Verboo Code 网页应用的视觉：深色使用接近黑色的中性配色，搭配 `verboo:code` 字标、本地 Nunito 字体、紫色用户消息和少量控件点缀。Assistant 标志通过 Chat Slot 提供；输入框焦点和气泡前景色使用可选主题令牌。这些资源不包含服务或账号凭证。

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
