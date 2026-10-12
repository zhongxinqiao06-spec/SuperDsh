# SuperDsh Server

自有远程服务端，使用 Python 3.12、FastAPI、PostgreSQL 17 和 Redis 8。
负责账号、设备配对、远程请求中转和会话同步。任务可以在所属电脑上执行，也可以在每个用户独立的服务端 Harness 容器中执行。
管理与登录界面在 [`../admin`](../admin)，Docker 将其静态页面与 API 放在同一服务中。

部署到服务器直接阅读[从 Git 拉取到 Docker 启动](docker/README.md#服务器首次部署)：包含 Linux / CentOS 前提、首次构建与启动、管理员初始化、HTTPS、升级、停止和备份。

## 从哪里改

| 内容                          | 目录                          |
| ----------------------------- | ----------------------------- |
| HTTP / WebSocket 接口         | `agent_server/api/`           |
| 业务模型与协议                | `agent_server/core/`          |
| 业务操作                      | `agent_server/services/`      |
| 数据库、Redis、文件与连接设施 | `agent_server/infra/`         |
| 数据库升级                    | `migrations/`                 |
| 回归测试                      | `tests/`                      |
| Docker 部署                   | [`docker/`](docker/README.md) |

## 本机开发

依赖准备、启动与停止命令统一见根 [README](../../README.md#日常开发)，检查命令见[检查与打包](../../README.md#检查与打包)。本机 API 使用 Python 3.12 与 `uv.lock`；脚本优先复用仓库的 `uv`，也可用 `UV_PATH` 指定可执行文件。

仅对本地托管的 `superdsh-dev` 开发库，`server:deps:up` 等待 PostgreSQL / Redis 就绪后执行增量迁移，并幂等创建开发管理员 `admin` / `admin123`；`server:dev` 也会在迁移后补充创建。已有 `admin` 的密码、角色和状态保持不变；若同名账号不是有效管理员，命令会明确报错，不会重置密码、提权或启用账号。

显式设置 `AGENT_SERVER_DB_URL` 时不自动创建开发管理员；外部空库使用 API 终端输出的 setup token 在网页初始化，自行设置用户名和密码。`GET /api/v2/health/ready` 同时检查数据库版本、Redis 和实时订阅；仅检查端口不能证明服务就绪。

开发依赖使用独立项目 `superdsh-dev`、独立卷及忽略的配置 `.superdsh-work/server-dev/aa-dev.env`；PostgreSQL 17 / Redis 8 默认监听 `127.0.0.1:15432` / `127.0.0.1:16379`。重复运行 `server:deps:up` 跳过健康容器、等待启动中容器，只启动缺失或停止的依赖。其他程序占用端口时自动选择并保存空闲端口，不接管其数据库或停止其容器；已有本项目容器则复用实际映射。终端显式设置的 `SUPERDSH_DEV_PG_PORT` / `SUPERDSH_DEV_REDIS_PORT` 冲突时提示修改，不静默覆盖。`server:dev` 自动读取保存的端口；已有 API 进程需要重启。

显式设置的 `AGENT_SERVER_DB_URL`、`AGENT_SERVER_REDIS_URL` 优先。使用已有 PostgreSQL / Redis 时，设置这两个变量即可跳过 `server:deps:up`，本机 API 不需要 Docker；数据库 URL 使用 `postgresql+asyncpg://`。依赖命令检测到这两个外部地址时也跳过托管容器启动与默认管理员初始化。

先对本机 API、网页分别按 `Ctrl+C`，再停止开发依赖：`server:deps:down` 会停止 Supervisor、转发容器和 `superdsh-dev` 的用户 Agent，保留全部卷；未停止的 API 可能重新调度 Agent。此流程不改动 `15174` 的完整 Docker 服务或其凭据。保留开发卷时也要保留其环境文件，不能重新生成数据库密码或加密密钥。

`server:deps:up` 只启动 PostgreSQL / Redis；默认托管开发库下，`server:dev` 随后自动准备 Supervisor、nginx API relay 与 Harness 运行镜像。缺少运行镜像时首次自动构建，Supervisor 每次利用缓存构建；API 与网页仍在本机手动运行。网页进入 Agent 工作台后准备所属 Agent；桌面、安卓登录及恢复会话仍在后台准备，不阻塞登录。失败显示诊断并允许重试。

只需要平台开发与电脑 Connector 时，设置 `SUPERDSH_DEV_AGENT_ENABLED=0`。显式配置外部数据库不会自动启动这组开发 Agent 依赖。开发 relay 只转发 `/api/v2/`，通过 Docker Desktop 的 `host.docker.internal` 访问本机 `AGENT_SERVER_PORT`（默认 `8000`），保留 WebSocket 和流式转发；纯 Linux 主机的此路径尚未验证，可选完整 Docker 部署。

## 完整部署与环境

完整部署由管理页面/API、PostgreSQL、Redis、Supervisor 及按需创建的用户 Harness 容器组成。完整 Docker 和生产部署首次空库仍使用 API 日志中的 setup token 在网页初始化管理员，不提供 `admin/admin123` 默认账号；已有部署继续使用原账号。构建不会更新正在运行的服务；更新需手动启动新镜像。部署入口见根 [README](../../README.md#三端联调)，项目名、卷、镜像与 Compose 配置见 [Docker](docker/README.md)。停止完整服务会停止所属 Agent 并保留卷。

| 配置                                                          | 用途                                            |
| ------------------------------------------------------------- | ----------------------------------------------- |
| `AGENT_SERVER_DB_URL`、`AGENT_SERVER_REDIS_URL`               | 本机数据库与 Redis；显式值优先于开发环境文件    |
| `SUPERDSH_SERVER_DEV_ENV`                                     | 指定本机开发环境文件                            |
| `SUPERDSH_DEV_AGENT_ENABLED`                                  | 托管开发库默认启用 Agent；设为 `0` 仅用电脑模式 |
| `SUPERDSH_DEV_AGENT_PORT`                                     | 开发 Supervisor 的本机端口，默认 `18090`        |
| `AGENT_SERVER_PORT`                                           | 本机 API 端口，默认 `8000`；开发 relay 跟随此值 |
| `SUPERDSH_SERVER_ENV`、`SUPERDSH_SERVER_PROJECT`              | 指定完整 Docker 服务的环境文件与独立项目名      |
| `AGENT_SERVER_SECRET`                                         | 登录令牌签名密钥                                |
| `AGENT_SERVER_PUBLIC_ORIGIN`                                  | 外部网页地址及 OAuth 回调基准                   |
| `AGENT_SERVER_CORS_ORIGINS`                                   | 明确允许的跨域地址                              |
| `AGENT_SERVER_FILES_BACKEND`、`AGENT_SERVER_FILES_LOCAL_ROOT` | 本地文件存储；也可配置 S3，详见运维参考         |
| `AGENT_SERVER_STATIC_DIR`                                     | Python 服务提供的管理端静态产物目录             |
| `SUPERDSH_MODEL_ENCRYPTION_KEY`                               | 供应商 Key 加密，与登录密钥分离                 |
| `SUPERDSH_AGENT_SUPERVISOR_SECRET`                            | API 与 Supervisor 共用的内部管理密钥            |
| `SUPERDSH_PERSONAL_MODEL_ALLOWED_ORIGINS`                     | 个人自托管模型的精确 origin 白名单              |

Windows 安全策略可能拦截第三方 Python 原生扩展；可使用隔离 Docker 测试入口，不需调整系统策略。实际检查结果与环境限制见根[排障与验证边界](../../README.md#排障与验证边界)。

## 边界

- `uv.lock` 固定 Python 依赖；Docker 管理端使用根 Yarn 锁，仅安装 `@superdsh/admin` 的依赖。
- 协议基准只读 [`../../agents-anywhere/contracts`](../../agents-anywhere/contracts)；兼容测试使用上游 Connector，不改写子模块。
- 协议导出默认写入根 `.superdsh-work/aa-protocol-export/1.0`，禁止写入固定的上游子模块。
- SQLite 仅用于隔离测试与旧数据导入；运行服务使用 PostgreSQL。
- 数据库迁移与运维参数见 [OPERATIONS.md](OPERATIONS.md)。

## 平台身份与权限

API v2 的登录接受 `identifier`（用户名或邮箱），兼容旧 `email` 字段。内置角色为 `admin`、`member`，可创建自定义角色；权限并集仍需通过资源归属校验。管理员可查看设备运维信息和封锁连接，不能读取其他用户的会话、文件与终端。

管理后台菜单使用 `GET /api/v2/navigation`、`GET/PUT /api/v2/admin/menus` 和 `POST /api/v2/admin/menus/reset`。页面目录固定在 `core/navigation.py`；配置采用版本检查并记录审计，菜单隐藏不替代接口授权。`v2_39` 初始化默认菜单并给内置管理员补齐 `menus.read`、`menus.manage`，保留既有账号、数据及角色。

Access token 有效期 15 分钟；refresh token 有效期 30 天并轮换。网页使用 HttpOnly 刷新 Cookie，原生客户端接收刷新凭据并安全存储。退出、禁用、软删除及密码重置会撤销登录；授权版本变化影响已有 WebSocket、预览链接和后续请求。管理员只能发起密码重置，不能设置现有用户的新密码。

增量迁移保留原用户 ID 和设备归属，将旧 `admin/member` 回填为内置角色。旧管理员别名通过现有 `AGENT_SERVER_LOGIN_ALIAS` / `AGENT_SERVER_LOGIN_EMAIL` 配置迁为正式用户名；冲突会停止迁移。旧无会话标识的用户令牌升级后需重新登录。测试使用临时库，不用于升级当前用户数据。

平台模型的管理接口位于 `/api/v2/admin/models`，客户端目录为 `/api/v2/models/catalog`。代理支持 OpenAI Completions、OpenAI Responses 和 Anthropic Messages，要求有效账号及所属设备；保持流式响应和取消传播，客户端不获得供应商 Key。

## 服务端 Agent

手机、网页、桌面用同一平台账号访问所属“服务端 Agent”。网页认证使用 `X-SuperDsh-Agent-Preparation: deferred`，仅抑制自动准备；进入工作台调用准备接口。桌面、安卓保持登录及恢复会话后幂等准备，不抢占当前聊天。就绪后在主聊天选择，无需扫码、连接电脑或填写电脑路径；准备失败显示原因，用户可以显式重试。个人模型在三端的账号设置中配置，接口为 `/api/v2/models/personal/providers` 和 `/api/v2/models/personal/default`。设置个人默认后，新会话使用该模型，否则使用平台默认；已有会话保留原选择。

`GET /api/v2/server-agent` 查询状态，`POST` 幂等准备真实 Connector、DSH Runtime 和 `/workspace` 工作区。消息、历史、流式事件、审批、取消、附件、文件和终端继续沿用 API v2。登录客户端退出不会停止服务端任务；封锁连接、禁用账号或撤销执行权限会影响运行和请求。手机离线只能查看已加载的缓存历史、保存草稿，重连后手动发送。

修改执行入口见 [agent-runtime](agent-runtime/README.md)，修改隔离容器模板见 `agent-supervisor/supervisor.py`。Supervisor 单独持有 Docker socket：完整部署仅内部访问，开发模式以内部认证在 `127.0.0.1:18090` 供本机 API 调用。每个用户容器只有自己的两个数据卷、限定 Connector 身份和到平台 API 或开发 relay 的网络，不接触数据库及平台主密钥。`SUPERDSH_AGENT_SUPERVISOR_SECRET` 由启动脚本首次生成并保存在既有环境文件中；手动 Compose 部署必须为 API 和 Supervisor 设置相同的随机密钥。

升级保留原 Compose 项目名、数据库卷和加密密钥，迁移从现有链增量执行。升级前备份，停止旧版本写入进程，再迁移到当前 head；迁移锁只串行化迁移，不能阻止旧应用继续写入。

个人供应商出站请求默认只访问公网，DNS 校验后固定 IP，保留原 Host/SNI，不跟随重定向。自托管模型由运维通过 `SUPERDSH_PERSONAL_MODEL_ALLOWED_ORIGINS` 明确允许精确 origin；原生开发需重启 API，Docker 部署需更新 API 容器。平台全局供应商保持管理员管理的地址策略。

本机代理使用 Fake-IP 时，官方域名也可能解析成非公网地址，导致“personal model address must resolve only to public addresses”。确认是可信代理后，可在开发环境文件 `.superdsh-work/server-dev/aa-dev.env`（或 `SUPERDSH_SERVER_DEV_ENV` 指定文件）中设置 `SUPERDSH_PERSONAL_MODEL_ALLOWED_ORIGINS=https://api.deepseek.com`，再重启 `server:dev`。仅填写需要使用的精确 origin，不附加 `/v1`；已有条目用逗号分隔保留，TLS 校验仍然生效。

供应商 Key 使用独立的 `SUPERDSH_MODEL_ENCRYPTION_KEY` 加密。通过 `server:up/build` 启动脚本时，会为缺少此项的本地环境文件生成并持久保存密钥；手动 Compose 部署须自行配置 URL-safe Base64 编码的 32 字节密钥。**备份数据库时一并备份这个环境文件，不能随意更换密钥**，否则已有供应商 Key 无法解密。该值与登录签名密钥分离，不输出到管理页面。
