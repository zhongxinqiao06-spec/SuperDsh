# 本地 Docker 服务

## 本机开发依赖

启动与停止命令统一见根 [README](../../../README.md#日常开发)，开发环境配置见 [Server](../README.md#本机开发)。`server:deps:up` 仅启动独立的 PostgreSQL 17 / Redis 8，本机 Python API 和 Next.js 分别运行，不构建网页或 API 镜像。默认 `server:dev` 另外启用开发 Compose 的 `agents` profile，准备服务端 Agent 所需容器。

- 项目：`superdsh-dev`；PostgreSQL / Redis 仅绑定 `127.0.0.1:15432` / `127.0.0.1:16379`，使用独立开发卷。
- 配置：`.superdsh-work/server-dev/aa-dev.env`，由开发命令生成，忽略于 Git；本机 API 自动读取，显式环境变量优先。保留数据卷时同时保留该文件；丢失后需恢复原配置，不能重新生成密码或加密密钥。
- 初始化：`server:deps:up` 等待 PostgreSQL / Redis 就绪后迁移开发库，并幂等创建 `admin` / `admin123`；`server:dev` 也会补充创建。已有 `admin` 的密码、角色和状态保持不变，非有效管理员则报错。仅限本地托管的开发库，显式设置 `AGENT_SERVER_DB_URL` 时不自动创建账号。
- Agent 准备：缺少 Harness 运行镜像时自动构建，每次利用缓存构建 Supervisor，然后启动 Supervisor 与 nginx API relay；API 与管理网页仍在本机运行。设 `SUPERDSH_DEV_AGENT_ENABLED=0` 可只开发电脑 Connector。
- 连接：开发 Supervisor 仅绑定 `127.0.0.1:18090`，可用 `SUPERDSH_DEV_AGENT_PORT` 修改，并要求内部随机凭据。relay 不映射宿主端口，仅将 `/api/v2/`（含 WebSocket/流式请求）转到 Docker Desktop 的 `host.docker.internal:${AGENT_SERVER_PORT:-8000}`。
- 隔离：relay 初始网络与 Supervisor、PostgreSQL、Redis 分离；Supervisor 将它加入各用户独立网络，固定别名 `server-next`。用户容器不加入数据库或控制网络。纯 Linux 主机的宿主回环转发路径尚未验证，可用完整 Docker 部署。
- 停止：先停止本机 API，避免继续调度，再运行 `server:deps:down`；它停止控制服务及 `superdsh-dev` 的 Agent，保留用户卷、数据库卷和配套密钥。

开发命令与原 `superdsh-mobile-test` 的 `15174` 服务、卷和凭据独立。

## 完整服务

先启动 Docker Desktop，使用 Linux containers，并等待引擎就绪。Windows 可运行 `docker desktop start`；再用 `docker info --format '{{.OSType}}'` 检查，应返回 `linux`。若报 `DockerDesktopLinuxEngine` 管道不存在，先恢复 Docker Desktop 的 Linux 引擎再重试。

完整构建与启动顺序见根 [README](../../../README.md#三端联调)。部署使用本目录 [compose.yml](compose.yml) 和 [Dockerfile](Dockerfile)，Harness 使用 [agent-runtime/Dockerfile](../agent-runtime/Dockerfile)；构建上下文都是仓库根，不依赖上游已迁出的 Web / Server 目录。

- 地址：`http://127.0.0.1:15174`，只绑定本机回环地址。
- 项目名：`superdsh-mobile-test`。`postgres-next`、`redis-next`、`migrate-next`、`server-next` 及三个卷名保持兼容，沿用之前的本地测试数据。
- 配置：优先复用根 `.superdsh-work/mobile-link-test/aa-docker.env`；没有时自动创建 `.superdsh-work/server/aa-docker.env`，密码随机生成。源码中不保存密钥。
- 管理员：首次空库使用 API 日志中的 setup token 在网页初始化，自行设置用户名和密码；完整 Docker 和生产部署不提供 `admin/admin123` 默认账号，已有部署继续使用原账号。
- `SUPERDSH_SERVER_ENV` 可指定另一个环境文件；`SUPERDSH_SERVER_PROJECT` 可指定独立项目名。更换环境文件时数据库密码必须与已有卷匹配。
- 若环境文件缺失但项目数据卷已存在，会拒绝生成新密码，要求指定原文件；Docker 无法访问时也不会自动生成凭据。
- 用户名和邮箱均可登录。升级旧管理员别名时，迁移任务读取本地环境文件中的 `AGENT_SERVER_LOGIN_ALIAS` 与 `AGENT_SERVER_LOGIN_EMAIL`，将别名保存为原账号的正式用户名；保留用户 ID、密码与设备。用户名冲突会停止迁移，不自动重分配账号。
- 平台模型 Key 由 `SUPERDSH_MODEL_ENCRYPTION_KEY` 加密；`server:up/build` 会在缺失时生成并保存到上述本地环境文件。手动部署需配置 URL-safe Base64 编码的 32 字节密钥，备份数据库时保留它，不能随意重置。
- `SUPERDSH_AGENT_SUPERVISOR_SECRET` 缺失时由根启动脚本追加随机值到原环境文件；手动 Compose 必须为 API 与 Supervisor 提供同一密钥。
- 个人模型默认只允许公网供应商；服务端校验 DNS 并固定目标 IP，拒绝私网、回环和元数据地址。自托管模型由运维在环境文件设置 `SUPERDSH_PERSONAL_MODEL_ALLOWED_ORIGINS`（逗号分隔的精确 origin，包含端口），例如 `http://host.docker.internal:11434`，不能由普通用户扩大白名单。
- Supervisor 只在内部网络开放，单独持有 Docker socket。每用户固定容器只挂载自己的 Home 和工作区卷，以普通用户、只读根文件系统运行；不挂载 Docker socket、宿主目录或数据库凭据。
- 登录或恢复登录会话后，后台自动准备服务端 Agent；准备失败显示原因并可重试，真实 Connector 和 DSH Runtime 就绪后才能聊天。用户容器有独立网络，只连平台 API，不连 PostgreSQL / Redis 或其他用户容器。停止平台会停止该项目的执行容器，保留全部卷。

读取当前容器日志：

```powershell
docker logs --tail 100 superdsh-mobile-test-server-next-1
```

启动顺序是 PostgreSQL 健康 → 运行迁移成功 → Redis 和 Supervisor 健康 → API 与管理页面；用户登录后后台自动准备执行容器，不阻塞登录或切换当前聊天。
健康检查 `GET /api/v2/health/ready` 同时验证数据库版本、Redis 和实时订阅。

安卓模拟器与真机的地址配置见根[三端联调](../../../README.md#三端联调)。真实手机不共享电脑的回环地址；对外部署还需要明确配置监听地址、HTTPS、公共 origin 和 OAuth 回调。

## 测试镜像

根[检查与打包](../../../README.md#检查与打包)中的服务端 Docker 测试使用 Dockerfile 的 `test` 阶段，只安装锁定的 Python 依赖，复制服务端测试、上游协议与 Connector。运行时禁用外网，不挂载应用数据卷，不启动常驻服务。

完整 API 镜像的管理端构建使用根 `yarn.lock` 和 workspace focus，启用不可变安装。Harness 在独立 `superdsh-agent-runtime:local` 镜像内运行，API 不加载 Host。真实链路验收见根 `docs/server-agent-validation.md`。
