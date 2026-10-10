# SuperDsh 桌面架构

SuperDsh 是产品外壳，Harness 是由它启动与管理的必需插件。桌面开发入口位于 `apps/desktop`，不再从 DSH 的 root 插槽选择产品界面。管理网页、Python 服务端和安卓应用分别位于同级的 `apps/admin`、`apps/server`、`apps/android`。

管理网页与安卓通过现有 API v2 连接 Python 服务端；服务端通过 Connector 与桌面 Harness 通信。管理网页可以独立开发、构建，Docker 部署仍由 Python 服务端提供其静态文件，保持同源认证及现有地址。共享协议基准、Connector 和 Bridge 留在固定 AA 子模块；三个迁出的应用目录使用稀疏检出从上游工作区实际移除。根 `sources:prepare` 建立此布局，`sources:check` 防止旧目录重新成为开发入口。

## 控制与进程

```mermaid
flowchart TD
  A[SuperDsh Electron / Core] --> B[本地 backend 子进程]
  B --> C[Harness 插件 / DSH Host]
  C --> D[原会话、Agent、队列和持久化]
  A --> E[受限 Preload]
  E --> F[SuperDsh 产品 UI]
  A --> G[独立兼容 WebContentsView]
  G --> H[未修改的第三方旧界面]
  F -->|现有 HTTP / WebSocket| C
  H -->|相同协议| C
```

Core 管理后端启停、Profile 切换、重试、退出与恢复。只有必需 Harness 就绪后才进入产品业务界面；失败显示诊断、重试和恢复。DSH 保留 Agent 执行、会话持久化和原有执行队列，避免引入重复执行或第二套审批状态。

平台身份独立于本地 Host 生命周期。正常启动即加载产品 RuntimeBridge 和本地模型网关，原位登录只更换凭据、Connector 与模型目录，不重启 Host 或切换 Home。安全模式不开放平台连接；平台故障不关闭本机 DeepSeek 聊天。Connector 由 Core 明确选择产品管理的 Python 3.12，不使用系统默认 Python。

主聊天通过 Core 的 `ConversationTarget` / `ConversationSource` 区分本机和远程目标，共用消息组件和输入区。原生 DSH 日志与 API v2 时间线分别适配，远程调用、订阅及附件携带账号代次和完整设备目标；旧响应、旧订阅不能写入新目标。平台绑定和同步检查点按服务地址与用户 ID 保存，但历史来源始终是同一个本地 Home。

## 源码职责

| 包                             | 职责                                                                         |
| ------------------------------ | ---------------------------------------------------------------------------- |
| `apps/desktop/ui`              | React 根、产品导航、聊天/工作流/设置/插件/引导等组件、统一主题、兼容渲染入口 |
| `apps/desktop/core`            | main/preload、后端生命周期、业务服务、浏览器安全模型、跨进程契约             |
| `apps/desktop/plugins/harness` | 固定 Host、Profile、协议适配和引擎运行依赖                                   |
| `apps/desktop`                 | 公共产品身份、运行资源清单、构建/打包入口                                    |
| `dsh-community-market`         | 可选插件的包身份和依赖；实现位于 UI features 和 Core services/contracts      |

UI 只能依赖 Core 公开的 `client/*` 和 `contracts/*`。Core/client 不得引入 Node/Electron 或平台实现。Harness 可在构建时使用纯契约，不能对 Core 建立生产依赖循环。第三方源码、固定引擎和手机端仍在原依赖边界内。

## 产品与第三方界面

`ui/src/app` 创建唯一产品根和导航。内置客户端通过固定清单接入；第三方旧模块不会在产品渲染上下文激活。兼容容器继续提供原模块 ID、Cordis、Slots、Remote 和桌面桥接，其旧 root 只影响兼容界面。

Electron 兼容页使用另一个 sandboxed WebContentsView，独立 `dsh-app://compat` 来源。普通浏览器使用没有 opener 的单独窗口。关闭、产品刷新或 renderer 异常都会触发资源释放。兼容入口仍经过原 Host 认证；未授权请求和关闭浏览器访问后的请求被拒绝。

自有界面中的原协议调用逐步通过兼容适配层迁移。协议 ID、事件顺序、重连、取消和审批语义保持原样，每个渲染上下文内 React/Cordis 等保持单实例。

## 构建与运行数据

根 Yarn 负责产品，固定 Harness 上游保留 pnpm。市场 → Harness → Core → UI → 组装包依次构建。UI 产出静态根、兼容页、原生辅助页及70个内置动态模块，由清单声明来源；缺少自有产物直接失败，不回退到上游界面。

安装版数据使用系统应用数据目录下 `SuperDsh/home`，开发版使用仓库 `.superdsh/home`。导入只允许空目标，保留来源备份并按失败回退，不改写源目录。手机 AA Bridge 继续运行于 Harness 中，协议与数据目录保持兼容。

具体文件和命令见 [README](../README.md#项目结构)，实测范围见[验收记录](superdsh-migration-validation.md)。
