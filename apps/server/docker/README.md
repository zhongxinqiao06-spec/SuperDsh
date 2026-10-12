# 管理后台与服务端 Docker 部署

本页覆盖从 Git 克隆到完整部署。日常前后端分开开发见根 [README](../../../README.md#日常开发)，服务配置字段见 [Server](../README.md)。服务器示例使用 **Bash，在仓库根执行**；Windows 本地命令将 `corepack` 换成 `corepack.cmd`。

## 服务器首次部署

### 1. 环境与支持边界

宿主需要 Git、Node **24.x**、Corepack、项目固定的 Yarn **4.18.0**、Docker Engine、Buildx、Docker Compose 插件。部署账号需能直接执行 `docker`；Supervisor 使用 `/var/run/docker.sock`，本流程按常规 Linux Docker Engine 编写，不把 rootless / Podman 当作已验证替代品。

截至 2026-10-12，[Docker 官方 CentOS 安装页](https://docs.docker.com/engine/install/centos/)列出 CentOS Stream 9 / 10，CentOS 7 / 8 不在支持列表。旧 CentOS 还可能不满足宿主 Node 24 的系统库要求；容器不能消除这个限制，请按实际发行版准备维护中的系统，不将同一套 `dnf` 命令强套到旧版本。**本次只核对代码和文档，未在 CentOS 上执行部署。**

按 [Node.js 下载说明](https://nodejs.org/en/download)安装 Node 24；发行版未提供 Corepack 时，按 [Corepack 官方说明](https://github.com/nodejs/corepack#how-to-install)安装。服务镜像包含 Python 3.12 / uv，完整部署不必先执行 `server:sync`。宿主 Yarn 的原生依赖如需编译，另准备 Python 3、make、C/C++ 工具链，并根据安装错误补齐系统开发包。

```bash
git --version
node --version
corepack --version
docker info --format '{{.OSType}}'
docker compose version
docker buildx version
```

确认 Node 为 `v24.x`、Docker 类型为 `linux`。安装/构建需要访问 GitHub、包仓库和镜像仓库。不能仅安装 Docker 就跳到启动命令：根脚本先在宿主构建 Harness 的 `lib`，再装入 Linux 镜像。

### 2. 克隆与安装

```bash
git clone https://github.com/zhongxinqiao06-spec/SuperDsh.git
cd SuperDsh
git submodule update --init --recursive
node scripts/prepare-aa-source.mjs
corepack yarn --version
corepack yarn install --immutable
corepack yarn sources:check
```

子模块按主仓库锁定提交初始化，不使用 `git submodule update --remote`。源码准备为 AA 设置稀疏检出，排除已迁入 `apps` 的旧应用目录，不能手动恢复。构建使用已提交的运行时归档和补丁，不要求重建整个上游 Harness，也不需要 Android SDK 或桌面图形环境。

### 3. 构建与配置

以下针对**服务器上的全新克隆、全新数据库**。项目名固定为 `superdsh-prod`，后续所有命令保持一致：

```bash
export SUPERDSH_SERVER_PROJECT=superdsh-prod
umask 077
corepack yarn server:build
export SUPERDSH_SERVER_ENV="$PWD/.superdsh-work/server/aa-docker.env"
test -f "$SUPERDSH_SERVER_ENV"
chmod 600 "$SUPERDSH_SERVER_ENV"
```

`server:build` 先构建 `@superdsh/harness`，再构建 Agent Runtime、API/管理网页、Supervisor 三类镜像，尚未启动业务服务。首次生成的环境文件包含随机数据库密码、JWT 签名密钥、模型加密密钥和 Supervisor 内部凭据，不需要从文档复制默认密码。

- 未导出项目变量时，脚本默认项目名是 `superdsh-mobile-test`；上例使用独立生产项目，其数据库、附件、用户卷和实例按项目隔离。
- 未指定 env 时，脚本优先复用 `.superdsh-work/mobile-link-test/aa-docker.env`，不存在才生成 `.superdsh-work/server/aa-docker.env`。新服务器不要复制整份旧测试工作目录；已有部署须明确使用原文件。
- **显式指定的 `SUPERDSH_SERVER_ENV` 文件必须已存在**，否则报错；空文件也不会自动补齐数据库密码和 JWT 密钥。首次先按上例生成，再固定绝对路径。可安全复制到仓库外专用配置目录，之后改用新绝对路径。
- 若同项目已有卷而原配置丢失，脚本拒绝生成新密码，必须恢复原配置。不要删除或重置密钥来“修复”登录。

重新登录服务器后，先进入仓库、重新导出相同项目和 env 路径。环境文件不提交 Git，也不要将其作为 Shell 脚本 `source` 执行；Shell 中同名变量优先于 Compose env，排障时检查是否继承了旧值。镜像标签当前仍为 `:local`，项目隔离不代表同一主机上有独立的镜像发布仓库。

编辑生成文件，域名部署至少修改以下非密钥字段，替换示例域名，保留原密码和密钥行：

```dotenv
AGENT_SERVER_PUBLIC_ORIGIN=https://dsh.example.com
AGENT_SERVER_CORS_ORIGINS=https://dsh.example.com
AGENTS_ANYWHERE_WEB_PORT=15174
```

public origin 是页面和 API 共用的站点根地址，不带 `/api/v2`。仅通过 SSH 隧道本地检查时可暂用生成的回环地址，启用域名前再修改。HTTPS 反代的可信来源还须按下节设置 `SUPERDSH_TRUSTED_PROXY_IPS`。

### 4. 启动与管理员初始化

```bash
corepack yarn server:up --no-build
docker compose --project-name "$SUPERDSH_SERVER_PROJECT" --env-file "$SUPERDSH_SERVER_ENV" --file apps/server/docker/compose.yml ps -a
docker compose --project-name "$SUPERDSH_SERVER_PROJECT" --env-file "$SUPERDSH_SERVER_ENV" --file apps/server/docker/compose.yml logs --tail 100 server-next migrate-next agent-supervisor
curl --fail http://127.0.0.1:15174/api/v2/health/ready
```

先成功构建才使用 `--no-build`，或用 `corepack yarn server:up` 一并构建启动。管理页面已编译入 `server-next`，无需再启动独立 Next.js 进程。`up` 返回不等于全部就绪，等待健康接口 `200`；`migrate-next` 成功退出是正常的一次性迁移，不是前端秒退。

空库 setup token 会打印在 `server-next` 日志中。打开网页，按初始化表单填 token 并自行设置管理员；token 过期时刷新初始化页、查最新日志。**生产/完整 Docker 没有 `admin/admin123` 通用默认账号**，已有数据库继续使用原账号。不要公开分享含 setup token 的日志。

15174 默认只绑定服务器回环地址，自己电脑直接访问服务器 IP 的此端口不会成功。先配置 HTTPS，或在自己电脑建立临时 SSH 隧道后访问 `http://127.0.0.1:15174`：

```bash
ssh -L 15174:127.0.0.1:15174 deploy@your-server
```

替换实际 SSH 用户和服务器；本机 15174 被占用时改用空闲转发端口，同时核对浏览器 origin 配置。

### 5. HTTPS、WebSocket 与可信反代

将域名解析到服务器，准备有效证书，在宿主 Nginx 反代 `127.0.0.1:15174`。只公开站点所需的 80/443，PG、Redis、Supervisor 和用户容器不需公开。以下为站点示例，替换域名、证书路径，不覆盖已有其他站点：

```nginx
# 放在 http 上下文，例如由 http include 的 conf.d 文件中。
map $http_upgrade $superdsh_connection {
    default upgrade;
    '' close;
}

server {
    listen 80;
    server_name dsh.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name dsh.example.com;
    ssl_certificate /etc/letsencrypt/live/dsh.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/dsh.example.com/privkey.pem;
    client_max_body_size 32m;

    location / {
        proxy_pass http://127.0.0.1:15174;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $superdsh_connection;
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

显式传递 Upgrade/Connection 以支持 WebSocket，关闭响应缓冲保留流式输出，见 [Nginx 官方文档](https://nginx.org/en/docs/http/websocket.html)。`32m` 是示例请求上限，按应用上传策略调整。CentOS 的 SELinux 如阻止 Nginx 连接上游，应检查审计日志并配置对应反代网络权限，不以关闭 SELinux 代替处理。

API 需要信任**实际代理来源**才能将转发请求识别为 HTTPS 并签发 Secure 刷新 Cookie。Compose 将 `SUPERDSH_TRUSTED_PROXY_IPS` 传给 Uvicorn 的 `FORWARDED_ALLOW_IPS`；默认只信任 `127.0.0.1`，宿主经 Docker 映射访问容器通常不是这个地址。先查询默认网络 gateway：

```bash
docker network inspect "${SUPERDSH_SERVER_PROJECT}_default" --format '{{(index .IPAM.Config 0).Gateway}}'
```

结合实际请求来源确认代理地址，再在原 env 文件设置 `SUPERDSH_TRUSTED_PROXY_IPS=实际代理来源IP`，执行 `corepack yarn server:up --no-build` 应用。不要固定抄写 `172.17.0.1`，不要用 `*` 或信任整个用户执行容器网段。多网络环境下 gateway 只是候选值，必须核对实际来源。

执行 `sudo nginx -t` 通过后再 `sudo systemctl reload nginx`。验证域名健康接口，并在浏览器开发者工具中检查 HTTPS 登录返回的刷新 Cookie 含 `Secure`、刷新能续期、WebSocket 正常升级；仅健康接口通过不能证明代理配置正确。第三方网页登录回调登记 `https://实际域名/api/v2/auth/oauth/callback`，保留现有原生客户端回调身份。

桌面、安卓填写 `https://实际域名`，网页访问同址，无需填 5174/8000。网页进入 Agent 工作台后准备实例，个人中心配置个人模型或由管理员配置平台模型；再验证真实聊天、流式输出、附件和终端，Agent 在线不等于模型已产生回复。**9router / Codex 网关尚未纳入此部署，属于后续建设。**

## 升级、停止与备份

操作前重新确认原项目名和 env 路径，安排维护窗口。先在旧服务仍运行时准备新源码、依赖及镜像；有本地改动时先保存和解决，不强制覆盖：

```bash
git status --short
git pull --ff-only
git submodule update --init --recursive
node scripts/prepare-aa-source.mjs
corepack yarn install --immutable
corepack yarn server:build
```

构建成功后进入维护窗口，用根命令完整停止旧版本，先停 API/Supervisor，再停其管理的 Agent，最后关闭 Compose 服务，确保旧 API 不会在新迁移期间继续写库：

```bash
corepack yarn server:down
```

它保留数据库、附件和用户卷；运行任务可能中断，恢复后不自动重放有副作用的任务。不要加 `-v`、执行卷 prune 或删除环境文件。单独 `docker compose down` 不负责停止 Supervisor 动态创建的执行容器。

停机后至少备份原 env、PG/Redis/附件三类 Compose 卷、每用户 `data`/`workspace` 卷，记录 Git 提交、镜像 ID、卷名称和标签。只备数据库不包含用户工作区；只有数据库而丢失模型加密密钥无法恢复原 Key。列出本项目卷：

```bash
docker volume ls --filter "label=com.docker.compose.project=$SUPERDSH_SERVER_PROJECT"
docker volume ls --filter 'label=com.superdsh.managed-agent=true' --filter "label=com.superdsh.project=$SUPERDSH_SERVER_PROJECT"
git rev-parse HEAD
docker image inspect superdsh-server:local superdsh-agent-supervisor:local superdsh-agent-runtime:local --format '{{.Id}}'
```

可使用运维备份系统对停机卷做快照，或用只读挂载卷的临时容器归档到仓库外目录。备份加密保存到独立位置，不提交 Git。恢复在停机的独立环境演练：使用原项目、原密钥、原卷名和标签（Supervisor 检查归属标签），保留文件权限；PG 物理备份使用兼容主版本，跨版本使用数据库升级/逻辑备份流程。不要解压覆盖运行中的卷或合并用户数据。

备份确认完整后，用已经构建的新镜像启动原部署：

```bash
corepack yarn server:up --no-build
curl --fail http://127.0.0.1:15174/api/v2/health/ready
```

迁移失败查 `migrate-next` 日志，不跳过迁移启动新版 API；回退需遵循对应迁移策略，例如 v2_39 要求恢复升级前备份，不能仅切回旧镜像。备份时同时记录升级前运行容器的镜像 ID 并保留镜像，避免构建覆盖 `:local` 标签后找不到旧版本。仅修改 env 用 `server:up --no-build` 重建受影响容器，源码修改先 `server:build`。从停机恢复也用原配置执行 `server:up --no-build`。

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

以下补充原有本机完整部署的兼容约定，服务器从上方[首次部署](#服务器首次部署)开始。Windows 先启动 Docker Desktop 的 Linux containers，引擎就绪后用 `docker info --format '{{.OSType}}'` 检查，应返回 `linux`；若报 `DockerDesktopLinuxEngine` 管道不存在，先恢复引擎。Linux 检查 Docker Engine 服务及当前账号 socket 权限，无需 Docker Desktop。

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
- 网页仅登录或访问管理页不启动 Agent，进入工作台后准备并复用实例；桌面、安卓保留登录后准备。准备失败显示原因并可重试，真实 Connector 和 DSH Runtime 就绪后才能聊天。用户容器有独立网络，只连平台 API，不连 PostgreSQL / Redis 或其他用户容器。停止平台会停止该项目的执行容器，保留全部卷。

读取当前容器日志：

```powershell
docker logs --tail 100 superdsh-mobile-test-server-next-1
```

启动顺序是 PostgreSQL 健康 → 运行迁移成功 → Redis 和 Supervisor 健康 → API 与管理页面；网页在进入工作台时准备执行容器，不阻塞管理模块。
健康检查 `GET /api/v2/health/ready` 同时验证数据库版本、Redis 和实时订阅。

安卓模拟器与真机的地址配置见根[三端联调](../../../README.md#三端联调)。真实手机不共享电脑的回环地址；对外部署还需要明确配置监听地址、HTTPS、公共 origin 和 OAuth 回调。

## 测试镜像

根[检查与打包](../../../README.md#检查与打包)中的服务端 Docker 测试使用 Dockerfile 的 `test` 阶段，只安装锁定的 Python 依赖，复制服务端测试、上游协议与 Connector。运行时禁用外网，不挂载应用数据卷，不启动常驻服务。

完整 API 镜像的管理端构建使用根 `yarn.lock` 和 workspace focus，启用不可变安装。Harness 在独立 `superdsh-agent-runtime:local` 镜像内运行，API 不加载 Host。真实链路验收见根 `docs/server-agent-validation.md`。
