---
description: "读取已登录用户的方案与连接，打开受信任的商业流程并授权外部服务。所有 API 调用均使用当前保存在 Host 中的 Verboo 凭据。"
kind: "package-reference"
---

# @deepseek-ai/dsh-api-verboo-product

[English](README.md) | 中文

<a id="summary"></a>
## 概述

读取已登录用户的方案与连接，打开受信任的商业流程并授权外部服务。所有 API 调用均使用当前保存在 Host 中的 Verboo 凭据。

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

`verboo` 配置在账号提供方旁加载此服务。[Config](src/index.ts) 接受公开 API 地址、路由地址与显式开发本地设置。Composio 项目凭据仅属于中央后端。

耐力读取仅返回服务器已启用订阅的主储备百分比和新请求 TPS 上限。空列表会隐藏此功能；HTTP404 同样兼容没有此端点的旧部署。其他失败仍按失败处理，账号替换会使未完成的读取失效。预算、费用和费率不会进入此展示数据。方案和订阅保留可选的服务器路由标识，让 Client 将模型路由匹配到分组 ID；旧版 API 可以不返回该字段。

经过认证的历史用量读取提供所选时间段的订阅及各方案总量，以及一年的每日活动。客户端仅接收分析页面需要的请求数及 token 字段；账号替换会使待处理响应失效。仅 Host 使用的认证流提供服务器测量或估算的账号生成速度，不向客户端传递票据、凭据或并发数据。

连接请求通过 `catalog=all` 获取提供方的完整目录，最多接受 10,000 条工具集记录，并包含授权方式和服务器配置要求。记录可以携带品牌标识，即绝对的 `logo` URL，连接页面会在服务名旁显示它；空字符串、null 或缺失表示页面使用自带的占位图，其他任何取值都会让目录读取失败。旧版 API 可以不返回这些元数据。Agent 列表只返回用户拥有的账号和公共服务（`public_<slug>`），避免将完整发现目录发送给模型。后端在搜索或执行工具之前会重新确认公共服务无需凭据。目录读取使用 `connectionListTimeoutMs` 期限，默认为 40 秒；提供方搜索与执行分别使用 `connectionSearchTimeoutMs` 和 `connectionExecutionTimeoutMs` 期限，默认均为 75 秒。执行不会自动重试；超时意味着结果尚未确认。

试用商业流程读取服务器决定的提醒状态，仅向客户端提供可展示的报价。签名后的转换及结账授权保留在 Host 有容量和时限的报价缓存中。每次请求绑定其所属账号，确认前再次核对身份，并提交用户看到的准确报价。报价、银行卡设置、套餐转移及付款确认是独立操作。服务器仅在尚未开始扣款时发送 `X-Verboo-Quote-Rejected` 标记，允许客户端重新获取报价并再次确认。结果未确认的写入保留原恢复标识，不能重新付款。新 Pix 结账使用单独签名的 BRL 报价；待处理付款恢复原付款尝试。付款链接仅允许受支持的 Stripe 地址。共享会话中的商业接口仅供拥有者使用，这些数据不进入模型或上下文缓存。

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节</summary>

每个请求捕获安装会话，并在账号替换后拒绝响应。Remote 仅公开展示数据、短期授权链接与公开账单地址。Agent 执行保留在 Host 内，所有权检查由中央后端完成。提供方写入若结果未确认，必须先检查状态再重复。

</details>

<a id="further-exploration"></a>
## 延伸阅读

- [架构](../../../docs/architecture.zh.md) — 共享的 Cordis 引擎。
- [桌面运行](../../../apps/desktop/tauri/README.zh.md) — 开发与构建。

<a id="model-experience"></a>
## 模型体验

### 产品集成

#### 模型看到什么

`VerbooProduct` 不注册提示词或工具定义。连接扩展负责模型可见的工具及已记录结果。

#### Token 影响

本身无影响；下游工具负责返回结果所消耗的 token。

#### KV Cache 影响

稳定的工具与提示词前缀保持不变；用户提交和工具结果追加到现有会话。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 目录与订阅加载需要中央 API 的两个投影。付款及权益决定仍由 Verboo 网站和后端负责。

<a id="dev-note"></a>
### 开发备注

无。
