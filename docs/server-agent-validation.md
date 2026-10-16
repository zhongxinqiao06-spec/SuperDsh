# 服务端 Agent 联调记录

本文是 2026-10-09 的历史验收记录，保留下列旧 Python / Docker 架构的证据。当前版本已迁至 `apps/admin/server`，原 `apps/server` 脚本、`server:check --agent`、`server:up --no-build` 与旧端口不再是当前运行方式。新版本检查使用 `corepack yarn server:check`、`corepack yarn server:test:integration`；服务器拉取、构建、备份与重启以[现行部署指南](../apps/admin/deployment/README.md#常规更新)为准。

验证日期：2026-10-09。环境：Windows 中文仓库路径、Docker Linux 容器、Node 24、Python 3.12。

最终使用三个正式 `local` 镜像运行完整检查，退出码为 0，21 项通过，耗时约 3 分钟。证据位于 `.superdsh-work/superdsh-agent-verification-1791531899678-700340/evidence.json`：无失败记录，`cleanedUp=true`、`productionStackUnchanged=true`。专用容器、网络、卷及临时账号配置已清理；既有 `15174` 服务的进程启动时间和运行状态不变。

## 复现

在仓库根目录完成产品构建后执行：

```powershell
corepack.cmd yarn server:build
corepack.cmd yarn server:check --agent
```

脚本位于 `apps/server/scripts/verify-server-agent.mjs`。它使用独立 Compose 项目、随机本机端口、空 PostgreSQL 数据库、临时账号和专用卷；不连接现有用户库或 Home。结束后移除专用容器、网络、卷和临时密码，保留 `.superdsh-work/superdsh-agent-verification-*/evidence.json`。

默认使用 `superdsh-server:local`、`superdsh-agent-supervisor:local`、`superdsh-agent-runtime:local`；`SUPERDSH_VERIFY_API_IMAGE` 可以覆盖 API 镜像。`--readiness-only` 仅验证启动，`--keep-failed` 仅在失败时保留专用环境用于诊断。

## 实际覆盖

| 内容                                                                        | 结果 |
| --------------------------------------------------------------------------- | ---- |
| 空 PostgreSQL 增量迁移链、两个临时账号、零电脑设备                          | 通过 |
| 个人供应商 Key 加密、只写入、默认选择与跨账号拒绝                           | 通过 |
| 真实完整 Host、Connector、Bridge 自动就绪；并发准备只有一个实例             | 通过 |
| 必需 DSH Runtime 的五种公开修改操作被拒绝                                   | 通过 |
| Anthropic Messages、OpenAI Completions、OpenAI Responses 实际 Host 流式调用 | 通过 |
| 手机模式退出时任务继续；网页、桌面模式登录读取同一历史；重连不重复生成      | 通过 |
| 新供应商目录刷新，无需重启 Host                                             | 通过 |
| 附件执行、持久下载、管理员跨用户下载与打开被拒绝                            | 通过 |
| 真实工作区文件与 PTY；跨账号会话、票据、文件、终端被拒绝                    | 通过 |
| 取消传到实际 Host 并关闭模型上游请求                                        | 通过 |
| 工具审批、重复/迟到审批、归一化工具结果                                     | 通过 |
| 实际前台子 Agent、workflow 子任务及其结果投影                               | 通过 |
| 两用户独立容器、Home/工作区卷与私有网络                                     | 通过 |
| 重启保留历史与文件，不重放完成的推理                                        | 通过 |
| 工具写计数文件后，模型流在途时 SIGKILL；恢复后计数仍为 1                    | 通过 |
| 持久封锁、恢复、禁用账号与运行清理                                          | 通过 |
| 现有 Connector token 执行权限撤销                                           | 通过 |

Host、工具、Connector、API、数据库、容器及 WebSocket 都是真实运行。模型回复来自本地协议 fixture，不消耗外部供应商额度；它仅提供模型响应，工具和子任务由 Harness 执行。测试只为临时 API 白名单放行 `http://model-fixture:8080`，不改变现有服务配置。

本地模型 fixture 位于 `apps/server/scripts/server-agent-model-fixture.mjs`。它提供三种协议的流式响应、一次工具调用及可取消的慢速响应；不替代实际 Host、审批、文件、终端或子任务执行。

默认模型验证包含 API 保存个人默认配置；三端新会话组件明确选择模型并发送已有 Runtime selectionId。真实 Host 联调用显式 selectionId，不代表省略选择时修改 Harness 全局默认，也不会自动切换费用来源。

三种客户端模式均通过真实登录 API 获取身份。这证明相同协议和历史，不代表实际手机/Electron 图形界面的操作覆盖。安卓 APK/JVM 检查与浏览器组件检查由各应用的检查入口另行记录。

## 构建与客户端检查

| 检查                                                             | 结果                                                         |
| ---------------------------------------------------------------- | ------------------------------------------------------------ |
| 根类型检查、lint、格式及目录/固定上游检查                        | 通过；桌面 UI 1083 个源码与工具文件纳入类型检查              |
| 管理网页类型、351 项测试、协议检查及正式 Next.js 构建            | 通过                                                         |
| 桌面/Core/Harness/UI/市场相关测试、网关与 Bridge 兼容回归        | 通过                                                         |
| 三项无头桌面界面检查                                             | 通过；包含主聊天服务端入口，使用模拟 API，不计为真实设备覆盖 |
| 服务端账号隔离、模型代理、生命周期及 Supervisor 相关 Python 测试 | 通过                                                         |
| API、Supervisor、Harness Runtime 正式 Dockerfile 构建            | 通过；从 Windows 中文仓库路径构建                            |
| 安卓三个静态检查、16 项 JVM 测试、Debug APK                      | 通过                                                         |

安卓产物：`apps/android/app/build/outputs/apk/debug/app-debug.apk`，构建时间为 2026-10-09 15:16:41（北京时间）。已核对 APK 内全部 15 个项目 Dex 与最新构建产物一致，签名验证通过且沿用原 Debug 签名。SHA-256：`0C38AEEA8F3D3EA82ACEB5F9BCF9755555C7E1F0F0A6A612AB9C6281A96E3774`。

根格式检查此前覆盖 2065 个文件、0 差异。最终仅补充验收文档，已单独运行 Prettier；随后重复全仓检查因 Windows 可用虚拟内存耗尽未能完成，不计为第二次通过，也没有关闭现有应用或服务来释放内存。

本轮没有覆盖安装到已登录的模拟器，也没有操作真实账号界面；手机离线缓存/草稿由 JVM 测试覆盖，仍需实际客户端验收。正式签名发布及 macOS/Linux 桌面打包不计为已通过。

三个本地服务镜像已构建，现有运行服务保持原状。由使用者从根目录手动更新：

```powershell
corepack.cmd yarn server:up --no-build
corepack.cmd yarn android:start
corepack.cmd yarn dev
```

更新后管理网页仍使用 `http://127.0.0.1:15174/`。三端登录同一账号，在主聊天选择服务端 Agent 并准备，然后在账号设置配置个人模型。安卓启动命令会覆盖安装 Debug APK，不清除已有 App 数据。

## 联调中修复的问题

- 原生 addon 缓存与 `noexec /tmp` 冲突：禁用可执行缓存，加载镜像内原生产物。
- Anthropic SDK 使用 `x-api-key` 和 `/v1/messages?beta=true`：本机网关支持其固定协议形式，冲突凭据及其他查询仍被拒绝。
- 新 Harness InteractionStream 参数与旧 Bridge 不匹配，以及 ToolMessage 结果结构变化：通过受控产品补丁兼容，固定上游不改写。
- 封锁时被拒绝的准备请求残留启动租约：准入前不领取租约，竞态拒绝仅回滚本次租约，允许立即恢复。
- Host 真正就绪后立即提交运行状态并清理本次启动租约，按 lease ID 防止旧观察覆盖新准备；就绪后立刻崩溃也能恢复，避免误等首次启动超时。

验收始终保留 `15174` 既有服务、用户数据和原 DeepSeek 配置。
