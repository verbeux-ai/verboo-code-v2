---
description: "在上游 Harness 引擎上运行 Verboo Code 产品，提供 Verboo 登录、带少量紫色点缀的中性编辑器界面、方案与每用户连接。上游 Web 与基础 bundle 文件保持可复用。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-verboo-app

[English](README.md) | 中文

<a id="summary"></a>
## 概述

在上游 Harness 引擎上运行 Verboo Code 产品，提供 Verboo 登录、带少量紫色点缀的中性编辑器界面、方案与每用户连接。上游 Web 与基础 bundle 文件保持可复用。

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

构建仓库后，使用 `pnpm dsh --profile verboo --no-open` 预览浏览器界面，或使用 `pnpm run dev:desktop` 进行 Tauri 开发。此配置按顺序叠加基础、Web 与产品 bundle。

产品使用精简 Chat 详情，并省略诊断用 Trajectory 视图。界面通过类型化 Slot 覆盖活动与词元统计底栏单元，并替换上下文用量控件。权限、模型选择、处理状态和账号耐力仍保留各自的控件。

新对话默认使用 `deepseek-account` / `pro/deepseek-v4.1-flash`。产品关闭 `agent-default-model.rememberSelection`，因此切换某个对话的模型只影响该对话，后续新对话仍使用 Flash。已有的模型选择保持不变。


<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节</summary>

[产品补丁](cordis.patch.yml)通过稳定条目 ID 替换账号和界面提供方，并加载连接扩展。上游内部包名与已保存的模型提供方路由仍为技术标识。更新上游时，合并引擎与 Web 组合、审查少量共享扩展修改、重新构建，并执行产品浏览器 QA 与共享 GUI 检查。

产品通过 `system-prompt.identity` 设置身份，不重写预设工具列表，因此上游 persona 保留所选模型的介绍。

</details>

<a id="further-exploration"></a>
## 延伸阅读

- [架构](../../../docs/architecture.zh.md) — 共享的 Cordis 引擎。
- [桌面运行](../../../apps/desktop/tauri/README.zh.md) — 开发与构建。

<a id="model-experience"></a>
## 模型体验

### 产品集成

#### 模型看到什么

所选上游 `Agent` 预设负责对话上下文。`system-prompt` 配置把助手标识为 Verboo Code，并保留所选模型；连接扩展添加其三个工具。

#### Token 影响

简短的产品身份替换默认开场。启用的插件负责其余提示词与工具成本。

#### KV Cache 影响

产品身份会改变此配置的系统前缀。相同配置与模型下前缀保持稳定；用户提交和工具结果追加到现有会话。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 这是源码仓库产品配置。用户界面隐藏插件安装，Cordis 仍作为内部组合机制。

<a id="dev-note"></a>
### 开发备注

无。
