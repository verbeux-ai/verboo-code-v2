# Verboo Code 桌面应用

[English](README.md) | 中文

## 开发

安装 Node.js、仓库锁定的 pnpm、Rust 1.97 或更高版本，以及 [Tauri 开发依赖](https://v2.tauri.app/start/prerequisites/)。在仓库根目录运行：

```sh
pnpm run dev:desktop
```

该命令构建共享应用、启动客户端重建监视器并启动 Tauri。Rust 负责原生窗口和运行产品 `verboo` 配置的私有 Node 进程。打包后的 Windows 应用是 GUI 程序，因此 Host 控制台进程以 `CREATE_NO_WINDOW` 创建；否则 Windows 会在产品窗口旁打开一个终端窗口。Host 仅绑定 `127.0.0.1`，使用操作系统分配的端口及每次启动生成的浏览器 Cookie 进行认证，并保留现有会话、工具、模型和插件服务。WebView 先在 Host 来源提交文档，再从该来源交换启动令牌，使 WebKit 在认证重定向时保留 `SameSite=Strict` Cookie。原生目录选择使用 Tauri 对话框插件。原生权限仅授予应用窗口和该 Host 的确切来源；窗口不能跳转到其他来源。

仓库构建完成后，可复用产物：

```sh
pnpm run start:desktop
```

`pnpm run dev:desktop --skip-build` 同样复用产物，并启动客户端监视器。Rust 源码变更由 Tauri 重建；客户端变更通过 Web 使用的同一套监视构建更新。退出应用时先释放配置资源，再等待 Node 进程退出；超过关闭期限会明确报告失败，不会误报成功。

启动时仅打开原生聊天窗口，即使用户配置启用了自动打开浏览器。浏览器登录和用户明确请求的外部链接仍使用系统浏览器。

原生关闭命令（macOS 的 Command+W、Windows 的 Control+W）关闭当前对话窗格，不关闭应用窗口。macOS 按下 Command+Q 或 Windows 按下 Control+Q 会显示提示；三秒内再次按下该快捷键即可退出。按 Escape、失去焦点、隐藏文档或等待三秒会取消确认。长按不会算作第二次按键。原生菜单退出和窗口关闭按钮仍会先请求确认，再中断工作或释放 Host。取消后窗口与工作保持运行，确认后仍执行有时限的正常关闭。重复退出请求共用一个确认，不能跳过 Host 释放。

开发目录为 `apps/desktop/.desktop-build/tauri/home`，可用 `DSH_HOME` 覆盖。生成配置仅包含路径，不含凭据。构建产物和开发状态均已被 Git 忽略。

## 原生分发

`pnpm run build:desktop` 为当前主机平台构建 Tauri 应用。它打包工作区依赖与 peer 闭包，保留经过审核的补丁和构建脚本权限，使用 SHA-256 验证官方独立 Node 压缩包，并在调用 Tauri 打包器前运行真实配置冒烟测试。运行时不包含开发目录或模型凭据。产物位于 `apps/desktop/.desktop-build/tauri/target/release/bundle`。

Linux 桌面使用官方 glibc Node 运行时。在 AppImage 扫描 ELF 依赖前，暂存目录会保留 glibc 系统和 FFI 插件、主机 PTY 预构建文件以及静态 Landlock launcher。未使用的 musl 和其他平台 PTY 二进制文件仅从暂存目录中移除，源代码包保持完整。

保留的 Electron 安装器和更新器测试属于[Electron 参考](../README.zh.md)描述的旧工具。Tauri 改用自带的更新器，不再连接 Electron 更新服务。

## 更新

Tauri 更新器随应用一起发布：Host 开始提供产品页面后，它每次启动读取一次更新源，确认后在原位置安装新版本。Linux 替换 AppImage，Windows 以 `passive` 模式复用 NSIS 安装器，macOS 用归档的 `.app` 替换应用包。Debian 和 RPM 安装继续由包管理器更新。开发构建从不检查更新，因此检出目录不会自行安装发布版本。

`bundle.createUpdaterArtifacts` 让打包器输出更新包及其签名，发布工作流使用 `TAURI_SIGNING_PRIVATE_KEY` 签名。`plugins.updater.pubkey` 中的公钥是唯一信任锚，更新器拒绝由其他密钥签名的更新包；私钥一旦丢失，后续安装器将永远无法更新。

更新源是 `update-feed` 分支上的 `latest.json`，而不是发布附件，因为 `releases/latest` 永远不会指向预发布版本。`verify-release.mjs` 依据校验后的清单写出它，`publish-feed.mjs` 在发布公开后提交它；重跑旧版本发布不会让更新源倒退。拒绝某个版本的用户不会再被同一版本打扰。

## 发布流水线

[发布工作流](../../../.github/workflows/verboo-desktop-release.yml) 会在 GitHub release 发布时运行，也支持手动创建首次发布。标签必须为 `v` 加上已提交的桌面版本。它会原生构建 macOS Apple Silicon 和 Intel DMG，以及 Linux x64 AppImage、Debian 和 RPM 安装包，并保留已有的 Windows x64 安装包。Linux 构建机需要 `musl-tools`；工作流会在打包运行时前构建完整的主机原生文件，包括 Landlock launcher。

macOS 的可执行文件和应用显示名称均为 `Verboo Code`；开发模式也嵌入相同的显示名称。打包时会先校验 `CFBundleName`、`CFBundleDisplayName` 和 `CFBundleExecutable`，再检查签名，并通过原生 `hdiutil create` 和 `verify` 生成 DMG，无需挂载可写镜像来定制 Finder。临时文件归当前构建所有，完成或失败后都会删除。AppImage 打包使用 `NO_STRIP` 禁用打包器的符号剥离。

每个平台记录精确的源代码 SHA、安装包大小和 SHA-256。发布前会检查完整文件集，将轻量标签或附注标签解析到该 SHA，并确认 GitHub 上传的摘要。已有 release 会被复用；相同文件会跳过，缺失文件可继续上传，已发布但字节不同的文件绝不覆盖。手动构建仅在校验后将草稿公开；release 触发的构建会附加到已有发布。下载保留在 GitHub Releases，校验值包含在 `SHA256SUMS` 中。macOS alpha 使用 ad-hoc 签名，未经 Apple 公证。

## 验证

```sh
node --test apps/desktop/tauri/tests/bridge.test.mjs apps/desktop/tauri/tests/host.test.mjs
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

桥接测试覆盖缓存和异步客户端挂载，并确认不设置 Electron 标记。Node 集成测试覆盖真实配置的认证 HTML 和资源、重复关闭、启动失败以及父进程断开。Rust 测试拒绝远程或无效的启动 URL。

产品 Client 条目在启动时为必需项，原生就绪状态要求 Verboo 导航已挂载。普通 Harness 根节点不能报告产品启动成功。构建后，在仓库根目录运行 `node apps/desktop/tauri/product-qa.mjs`，使用临时配置与操作系统凭据、外部 HTTP 测试服务，验证 OAuth PKCE、令牌实时刷新时不闪现引导页且保留草稿、焦点和运行中的对话、模型选择、方案、连接、对话框及两种主题。`VERBOO_QA_OUTPUT` 指定截图目录，`VERBOO_QA_CHROME` 指定浏览器可执行文件。
