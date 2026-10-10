# SuperDsh 管理端

`apps/admin` 是自有 Next.js + React 管理界面，包含登录、会话、设备和手机连接，以及管理员的看板、用户、角色和服务设置。源码来源见仓库的 AA 导入记录；运行时连接 `apps/server`，桌面 Harness 接入仍由内置 Bridge 负责。

环境准备和启动命令统一见根 [README](../../README.md#日常开发)，三端连接见[三端联调](../../README.md#三端联调)，验证与构建见[检查与打包](../../README.md#检查与打包)。数据库、服务端 Agent 和部署配置见 [Server](../server/README.md)。

## 管理端配置

开发网页默认将 `/api/v2` 代理到本机 API；更换目标时，在启动网页前设置 `AGENTS_ANYWHERE_API`。`AGENTS_ANYWHERE_API_NAMESPACE` 默认 `/api/v2`，保持三端一致。`NEXT_DIST_DIR` 可指定独立构建缓存，默认 `.next`；不要把测试缓存或真实凭据提交到源码。

默认本地 `superdsh-dev` 开发库由 `server:deps:up` 初始化管理员 `admin` / `admin123`，`server:dev` 也会补充创建；已有 `admin` 的密码、角色和状态保持不变。显式配置 `AGENT_SERVER_DB_URL`、完整 Docker 和生产部署不自动创建此账号；首次空库仍显示管理员初始化页，使用 API 输出的 setup token 自行设置用户名和密码。

## 功能与部署

“手机连接”直接显示当前账号的手机登录会话，支持刷新和撤销；手机已通过用户名密码登录后无需再次扫码。列表每 15 秒及回到窗口时刷新，扫码入口仅用于添加另一部手机。这里管理登录记录，聊天及历史在原主聊天中。

新会话支持“服务端 Agent / 我的电脑”。登录或恢复登录会话后，后台自动准备服务端 Agent，不阻塞登录、不切走当前聊天；卡片显示准备状态，失败显示原因与重试入口。就绪后使用所属 `/workspace`，没有电脑也能聊天；真实执行实例同时出现在设备与会话列表。设置里的“个人模型”支持三种协议、供应商验证与默认模型，Key 只写入。手机、网页和桌面使用同一账号可继续同一服务端会话，复用原消息、附件、审批、文件和终端界面。

本机托管开发库下，默认 `server:dev` 自动准备 Supervisor、API relay 与所需运行镜像；`server:deps:up` 本身仍只启动 PostgreSQL / Redis。前后端各自在本机手动启动；仅开发电脑连接可设置 `SUPERDSH_DEV_AGENT_ENABLED=0`。配置与停止顺序见 [Server](../server/README.md#本机开发)。

完整 Docker 部署由 Python 服务提供静态页面和 API，采用同一地址。修改页面后需要手动重建并更新服务，保留原数据卷；部署细节见 [Docker](../server/docker/README.md)。

| 开发内容                 | 目录                                       |
| ------------------------ | ------------------------------------------ |
| 页面入口、主题与字体     | `src/app`                                  |
| 管理页面                 | `src/components/pages`                     |
| 登录和 OAuth             | `src/components/auth`、`src/features/auth` |
| 会话、设备、实时协议模型 | `src/features`                             |
| 中文与英文               | `messages`                                 |
| 协议生成类型             | `src/generated/protocol/v1`，禁止手改      |

部署到 Python 服务端时设置 `NEXT_OUTPUT=export` 后执行 `build`，产物在 `apps/admin/out`。常规 Next.js 构建后可执行 `start`。包脚本直接调用工具的 Node 入口，避免 Windows 中文路径经过命令包装脚本时乱码。

协议基线读取固定子模块的 `agents-anywhere/contracts/protocol/1.0`；`protocol:generate` 只重建本包类型，不写回子模块。字体文件、固定来源与许可证保存在 `src/app/fonts`，生产构建无需联网下载字体。

本包继承根 Yarn 4.18、格式与 lint 规则，不维护独立锁文件。历史参考和废弃页面保存在 `.superdsh-work/apps-migration-20260928` 的退役快照中，不参与产品构建。生成文件和第三方许可证不做机械格式改写。
