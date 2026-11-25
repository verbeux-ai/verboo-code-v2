---
description: "使用持久化、校验回执的发件箱衡量经同意的 Verboo 桌面回复和功能使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-verboo-analytics

[English](README.md) | 中文

## 概述

在用户明确选择允许产品分析后衡量符合条件的 Verboo 产品使用情况。Host 在凭据提供器中保存选择和有界发件箱，并向 Verboo 收集器发送事件，直到收到匹配的回执。接收器负责向 PostHog 投递；目标密钥和对话内容不会进入客户端。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [深入探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

Verboo 产品层将此服务与账户、凭据和会话投影一起挂载。

### 何时选择

在能够显示和更改产品隐私选择的 Verboo 组合中使用。单独的广告选择不会启用此服务。

### 最小配置

产品组合包提供收集器地址和使用场景。桌面覆盖层设置 `surface: desktop`；服务也接受 `cli` 和 `dashboard`。

```yaml
- name: '@deepseek-ai/dsh-host-verboo-analytics'
  config:
    surface: desktop
    appVersion: 'development'
```

收集器必须单独启用产品分析。已挂载组合请参阅[产品层](../../bundle/verboo-app/README.zh.md)。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

投影仅记录根级人工轮次的有界回复事实。实时完成的回复产生事件；重放仅重建状态，不重新发送观察结果。同意版本和账户归属保护每个排队事件。精确匹配事件 ID 与负载哈希的回执允许删除事件；拒绝会丢弃该授权下的待处理事件。功能调用只接受固定类别、结果和操作开始时捕获的同意主体，不接受页面内容、工具名称、参数、提示词或回复。

凭据存储独立于账户上下文保存随机生成的安装密钥。Host 通过收集器传输将其发送给收集器；收集器派生假名以统计不同安装数量，不向 PostHog 发送账户 ID。Host 不将匿名上下文与账户关联。已有存储记录在下次选择时获得可选密钥；排队事件的字节与回执保持不变。一个人使用多个安装时可能被重复计数。

产品交互包括分屏和停止按钮、添加项目、普通消息操作、已接受的模型选择以及界面偏好的快照。模型和推理等级维度仅限 Verboo、OpenAI 账户及官方 DeepSeek 目录中的有界标识符；自定义提供方和模型名称归为 `other`。`default` 表示没有观察到明确的推理等级，并非某个确定的实际等级。事件次数与不同安装数量是不同的指标；偏好报告必须使用每个安装的最新观察结果。

桌面更新观测区分下载开始、完成与失败，以及安装开始与失败；无法归因的更新错误使用独立类别。 主会话中的人工请求失败只记录失败次数，不包含错误代码或文本；取消不计为失败。已连接的 Host 断开后恢复时，只有原授权仍然有效才计数。Host 验证收集器返回的区域元数据，但不将其作为收集授权。恢复的就绪状态或后续启动不能证明已观测的安装成功。

| 源文件 | 职责 |
|---|---|
| [index.ts](src/index.ts) | 同意、事件提交、回执和账户隔离 |
| [projection.ts](src/projection.ts) | 符合条件的回复事实 |
| [storage.ts](src/storage.ts) | 持久化身份和有界发件箱 |

</details>

-----

<a id="further-exploration"></a>
## 深入探索

- [Verboo 产品组合包](../../bundle/verboo-app/README.zh.md)——已挂载的产品组合。
- [Verboo 账户](../../credentials/verboo-account/README.zh.md)——账户会话和凭据。
- [会话投影](../../session/session-projection/README.zh.md)——确定性的会话事实。

<a id="model-experience"></a>
## 模型体验

无；服务记录产品事件，不向模型上下文添加内容。

#### KV Cache 影响

无；事件提交不会改变模型请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

当前服务具有以下边界。

- 发件箱有容量上限；跨重启保留需要可用的持久化凭据存储。
- CLI 挂载和浏览器扩展埋点需要各自的产品组合。
- 收集器接受事件不代表 PostHog 已摄取；须单独确认目标。
- 撤销时已在途的请求可能已到达收集器。

<a id="dev-note"></a>
### 开发备注

无。
