# Verboo Code 桌面应用

[English](README.md) | 中文

## 开发

安装 Node.js、仓库锁定的 pnpm、Rust 1.97 或更高版本，以及 [Tauri 开发依赖](https://v2.tauri.app/start/prerequisites/)。在仓库根目录运行：

```sh
pnpm run dev:desktop
```

该命令构建共享应用、启动客户端重建监视器并启动 Tauri。Rust 负责原生窗口和运行产品 `verboo` 配置的私有 Node 进程。Host 仅绑定 `127.0.0.1`，使用操作系统分配的端口及每次启动生成的浏览器 Cookie 进行认证，并保留现有会话、工具、模型和插件服务。WebView 先在 Host 来源提交文档，再从该来源交换启动令牌，使 WebKit 在认证重定向时保留 `SameSite=Strict` Cookie。原生目录选择使用 Tauri 对话框插件。原生权限仅授予应用窗口和该 Host 的确切来源；窗口不能跳转到其他来源。

仓库构建完成后，可复用产物：

```sh
pnpm run start:desktop
```

`pnpm run dev:desktop --skip-build` 同样复用产物，并启动客户端监视器。Rust 源码变更由 Tauri 重建；客户端变更通过 Web 使用的同一套监视构建更新。退出应用时先释放配置资源，再等待 Node 进程退出；超过关闭期限会明确报告失败，不会误报成功。

开发目录为 `apps/desktop/.desktop-build/tauri/home`，可用 `DSH_HOME` 覆盖。生成配置仅包含路径，不含凭据。构建产物和开发状态均已被 Git 忽略。

## 原生分发

`pnpm run build:desktop` 为当前主机平台构建 Tauri 应用。它打包工作区依赖与 peer 闭包，保留经过审核的补丁和构建脚本权限，使用 SHA-256 验证官方独立 Node 压缩包，并在调用 Tauri 打包器前运行真实配置冒烟测试。运行时不包含开发目录或模型凭据。产物位于 `apps/desktop/.desktop-build/tauri/target/release/bundle`。

保留的 Electron 安装器和更新器测试属于[Electron 参考](../README.zh.md)描述的旧工具。Tauri 不连接 Electron 更新服务。

## 验证

```sh
node --test apps/desktop/tauri/tests/bridge.test.mjs apps/desktop/tauri/tests/host.test.mjs
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

桥接测试覆盖缓存和异步客户端挂载，并确认不设置 Electron 标记。Node 集成测试覆盖真实配置的认证 HTML 和资源、重复关闭、启动失败以及父进程断开。Rust 测试拒绝远程或无效的启动 URL。

产品 Client 条目在启动时为必需项，原生就绪状态要求 Verboo 导航已挂载。普通 Harness 根节点不能报告产品启动成功。构建后，在仓库根目录运行 `node apps/desktop/tauri/product-qa.mjs`，使用临时配置与操作系统凭据、外部 HTTP 测试服务，验证 OAuth PKCE、模型选择、方案、连接、对话框及两种主题。`VERBOO_QA_OUTPUT` 指定截图目录，`VERBOO_QA_CHROME` 指定浏览器可执行文件。
