# Agent Note：在工作区之间移动会话

Status: implemented

[English](2026-11-10-project-assignment-and-session-moves.md) | 中文

## 问题

一个会话属于它被创建时所在的那个目录，而且没有任何东西能改变这一点。这个关联并非任何人拥有的字段：它由不可变的 `SessionHeader.cwd` 派生，并物化为工作区记录中有序的 `sessionIds`，因此 `attachSession` 校验 `realpathNormalize(header.cwd) === record.path`，其余一概拒绝。注册表按 header 建立成员资格索引，一个会话被两个工作区同时记账被视为中间介质损坏，会在启动时失败。

这条不变量是对的，问题在于它成了产品限制。在意外的目录里开始了一段对话，或者想拿旧对话对着另一份检出继续，用户只能分叉或重新开始。目录本身其实已经有一条持久且对模型可见的变更路径——`working-directory/change` 与 `ctx.workingDirectory`——它的文档还明确写着「不可变的 Session header 保留原始项目」。也就是说，架构早就区分了「原始项目」与「有效目录」；缺的是一个能表达「项目变了」的位置。

代码在这个缺口上还已经出现了漂移。`@` 文件提及与 bash shell 使用有效目录投影，而 `sandbox-policy` 与 `workspace-files` 使用原始的 `header.cwd`。因此一个改过目录的会话，其沙箱可写根与文件预览根和它真正操作的位置并不一致。任何移动都必须让它们全部一致，而不是再加上第四种说法。

## 决定

header 保持不可变，会话记录（transcript）不搬移。发生变化的是工作区域拥有的持久项目归属，它在所有解析项目的位置上都优先于 header。

**领域增加一张表和一个标记分支。** `workspace` 升到版本 3，新增以会话 id 为键的 `session_projects` 表，存放 `{ projectPath, assignedAt }`；可恢复的 `pendingMutation` 联合增加 `{ operation: 'move', sessionId, workspaceId }`。版本 2 的介质原样解析：表只是不存在，归属按构造即可选。工作区记录没有新增列，因为所有权不能被表达两次。

**由一个解析函数决定。** `WorkspaceRegistry.projectPathOf(sessionId)` 回答「这个会话属于哪个项目」：存在归属时取归属，否则取已索引 header 的规范 cwd。`candidateMatches`、`attachSession`、引导分组与 `validateStoredState` 都经由它。引导保持仅依赖 header 且足够廉价——它只使用随领域已加载的归属，绝不重放日志——而归属于写入时已经校验过，无需再做文件系统检查。

**`moveSession` 在标记下先写归属、再写账本。** 它通过归档所用的同一个 `workspace/session-activity` waterfall 拒绝运行中的工作，抛出 `WorkspaceActiveSessionError` 并带 `move` 动词；并拒绝未知的，或目录当前不存在的目标（`WorkspaceMoveTargetInvalidError`）。被接受的路径先写归属——它正是让成员资格解析到目标的依据——然后从其他所有账本解除，再前插到目标，最后清除标记。任意两步之间的崩溃都会在下次启动或下一次注册表操作时补完：`recoverPendingMutation` 会补完被标记的移动而不是回滚它，因为归属是项目成员资格的唯一写入方，补完它才能保证只有一个所有者。

**归属通过 `agent/created` 抵达执行层。** `dsh-working-directory` 监听串行的 `agent/created` 事件，比较 `projectPathOf` 与已记录的目录，不同就提交一次 `working-directory/change`；`ensure` 现在的恢复目标是项目而不是 header。那次提交与用户的 `cd` 产生的是同一个对模型可见的过渡，因此移动不需要新的会话事件、新的提示词文本，也不需要重写 header。这个桥接位于本就拥有有效目录、且已依赖该投影的包中，而不是通用 dispatch 层。

**项目消费方读取同一权威。** `sandbox-policy.resolve` 与 `workspace-files` 的作用域查找读取 `ctx.get('workspaceRegistry')?.projectPathOf(id)`，仅在没有挂载注册表时回退到 `header.cwd`。该服务是以可选方式读取而不是注入：这两个包必须在没有挂载工作区注册表的组合（无 Agent 调用、SDK profile）中继续工作，而强制注入会让它们在那里永久 pending。这也正是消除 `@`/shell 与沙箱/文件访问既有分歧的地方。

**一个 Remote 动词、一个 Client 命令、一个菜单项。** `workspace/moveSession` 接受 `{ sessionId, workspaceId, stopActivity? }`，返回结果归属加目标行，使 Client 能够立即反映移动而不必等待 follow 帧。三种拒绝分别是 `workspace/session-active`、`workspace/move-invalid` 与 `session/not-found`。`ClientWorkspaceModel.moveSession` 只合并目标行，因为原工作区的新账本由 stream 送达。UI 在顺序 400（Fork 与 Copy ID 之间）的 `ctx.contextMenus` 条目中提出请求，`shell.overlay` 对话框拥有 Host 调用：它列出除当前所有者之外的每个已注册项目，确认后执行；遇到 `workspace/session-active` 拒绝时在对话框内报告，并指明仍在运行的工作。

## 考虑过的替代方案

**重写 `SessionHeader.cwd`。** 这样不需要新表也不需要新解析函数，但 header 是整个持久化层、格式迁移与工作区索引所依赖的唯一不可变事实。重写它会把一个产品动作变成格式变更，使会话的起点无法追溯，还必须触及已存日志的每一代——而工作目录模块的既定契约本就承诺 header 保留原始项目。

**把会话记录文件搬到目标项目的存储目录下。** 它带不来归属没有的东西：记录按会话 id 寻址，其位置对用户不可见，而搬移已提交的代际正是已发布格式政策所禁止的操作。

**把项目存在工作区记录上（`record.sessionId → path`）或新增一条会话行。** 两者都会造出第二个决定成员资格的地方。归属表以会话为键，而会话正是成员资格所针对的身份；把它排除在工作区记录之外，意味着一次记录写入无法悄无声息地搬家一个会话。

**在 `sandbox-policy` 与 `workspace-files` 中强制注入。** 这看起来更严格，但会让两个包在所有不挂载注册表的组合中无法加载，包括 SDK 与 headless profile，而它们其实可以回退。

**为移动追加一个新的会话事件。** 对模型可见的效果已经有事件——`working-directory/change`——需求是模型知道自己工作在哪个目录，而不是知道发生过一个产品动作。多一个事件只会让每个投影都去读它，却得不到额外的事实。

**只在 Client 侧完成移动。** 只重排侧栏满足「移动到项目」的字面要求，却没有任何实际意图：bash、沙箱可写根与 `@` 引用仍会解析到旧项目，而这正是本次改动要消除的分歧。

## 后果

被移动的会话保留其记录、历史与原始 header 目录，并从下一个请求起在目标项目中工作。已经在运行的一切保持旧目录——已有终端与 shell 是目录变更的既定行为，不是新例外——这也是移动拒绝运行中工作、而不是假装搬移它的原因。

归属现在成了成员资格第二件可能出错的事。因此当归属的 `projectPath` 与记账该会话的记录不一致时，`validateStoredState` 也会大声失败，使分叉的写入在启动时暴露，而不是表现为一个在某项目中出现、却在另一个项目中工作的会话。

两个包现在为 `ctx.workspaceRegistry` 的仅类型合并而依赖 workspace 包；加载顺序不变，因为该读取是可选的。

`workspace-files` 仍以项目根作答，因此在移动之后打开的预览列的是目标项目。用户仍在查看的旧项目下的路径依旧可以按绝对路径读取，这是该服务既定的读取授权，而不是包含（containment）规则。

## 测试

`packages/workspace/workspace/tests/workspace.spec.ts` 覆盖：成功移动、运行中工作被拒绝且不写入、未知与目录缺失的目标、幂等重复、重启后保留、两种被中断的标记形态（归属之前崩溃、之后崩溃）、重复记账与归属分叉的失败、移动后的 attach、无主会话、删除时清理归属，以及写入失败不留下半状态。`packages/session/working-directory/tests/move-composition.spec.ts` 是真实组合证明：它通过 Loader 启动发布的各行，移动一个会话、创建其 Agent，并断言有效目录、已记录的 `working-directory/change` 与投影值。`packages/api/workspace-controller` 覆盖三种 Remote 代码、`stopActivity` 以及客户端模型的回显；`packages/client/ui-workspace` 覆盖菜单项、其访问门禁、对话框的目标列表与拒绝渲染，以及移动通知。`packages/sandbox/sandbox-policy` 与 `packages/api/workspace-files` 各自证明归属优先于 header。

## 相关

- [工作目录](../../../../docs/subsystems/working-directory.zh.md) —— 本桥接扩展的有效目录所有者。
- [工作区](../../../../docs/subsystems/workspace.zh.md) —— 领域、注册表与 Remote 接口。
- [归档仍有运行的会话](../feature/2026-09-21-archive-stops-running-session-work.zh.md) —— 移动原样复用的活动与停止事件。
