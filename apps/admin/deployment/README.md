# 星桥智能平台：服务器部署与 Git 拉取更新

当前平台采用 **Next.js 官网 / 工作台 + Node API + 本机 Harness 子进程**，开发与生产使用相同运行结构。Docker 只运行 PostgreSQL、Redis 和知识检索用的 Qdrant，不再构建 Python API、Supervisor 或 Agent 镜像。网站根路径 `/` 默认展示星桥官网，「进入工作台」使用 `/#/login`；官网图片、桌面与手机 Web 演示截图随同源码构建，无需另开静态站点。

代码仓库为 [zhongxinqiao06-spec/SuperDsh](https://github.com/zhongxinqiao06-spec/SuperDsh)，以下命令使用 `main` 分支。已经部署的服务器直接看[常规更新](#常规更新)；旧 Python / 容器 Agent 部署先看[迁移边界](#旧-python-部署切换边界)。常用开发命令见根 [README](../../../README.md#日常开发)，服务模块见 [Node 服务端](../server/README.md)。

## 服务器首次部署

以下为 Linux 原生部署步骤。服务器需要能运行项目指定的 Node 24、Corepack / Yarn 4.18、Git；依赖使用容器时还需 Docker Compose。先用 `node --version`、`corepack yarn --version`、`git --version` 检查；使用容器再检查 `docker info`、`docker compose version`。服务器须能获取根锁文件中的依赖和两个固定子模块。CentOS 7/8 的内核、系统库和 Node 24 兼容性尚未在当前版本验收；先确认 Node 能正常执行，不能把 Docker 可运行视为原生运行环境已满足。

以下以普通运行用户 `superdsh`、源码目录 `/srv/SuperDsh`、系统服务 `superdsh-platform` 为例。先创建或选用自己的运行用户，并为其准备可写的源码、数据及备份目录；已有部署沿用原路径和服务名。Git、安装依赖和构建均由运行用户执行，只有系统配置与 `systemctl` 使用 `sudo`。

### 1. 获取源码与安装依赖

在运行用户有写权限的 `/srv` 目录执行：

```bash
cd /srv
git clone --branch main https://github.com/zhongxinqiao06-spec/SuperDsh.git SuperDsh
cd SuperDsh
git submodule sync --recursive
git submodule update --init --recursive
node scripts/prepare-aa-source.mjs
corepack yarn server:sync
```

顺序不可省略：先按主仓库提交初始化固定子模块，再执行 sparse 准备，最后同步依赖。`prepare-aa-source.mjs` 排除 AA 中已迁移的 `web-next`、`server`、`android`；不要重新恢复这些目录。若旧目录残留未跟踪缓存，脚本会停止，先核对并备份这些文件再处理，不使用 `git clean -fdx` 清理运行数据。

`server:sync` 已执行根目录 `corepack yarn install --immutable` 并构建固定 Harness，无需另跑一遍安装，也不安装 Python 后端。安装失败时保留错误并处理环境，不删除 `yarn.lock`、不使用 `yarn up` 或 `git submodule update --remote` 解决。后续所有项目命令在仓库根执行。

### 2. 准备数据库依赖

正式部署先准备专用 PostgreSQL、Redis，以及启用知识检索所需的 Qdrant，使用已有运维方式启动并配置认证、持久卷和备份。当前仓库开发 Compose 使用 PostgreSQL 17、Redis 8 与 Qdrant v1.19.2；生产依赖的版本、升级和恢复须在自己的环境验证。已有部署保留原数据库、容器项目名、卷名和凭据，不重新建一套空库替代原库。

仓库提供的 `server:deps:up` 是**本机开发 / 演示入口**，不是生产初始化步骤。只有明确使用该开发环境时才执行：

```bash
corepack yarn server:deps:up
```

这只启动 `superdsh-dev` 项目的 PG / Redis / Qdrant，默认回环端口 `15432` / `16379` / `16333`。保留原 PG/Redis 卷名，新增 `superdsh-dev_qdrant-data` 卷；保留 `.superdsh-work/server-dev/aa-dev.env`，重复运行复用健康实例。端口被其他程序占用时自动选空闲端口并记录；显式端口不自动改变。已有卷而环境文件缺失会停止，须恢复原配置。

Qdrant 固定为官方 [v1.19.2](https://github.com/qdrant/qdrant/releases/tag/v1.19.2)，只发布本机 HTTP 端口，不发布 gRPC。Compose 使用 `/readyz` 健康检查；无需在镜像内安装 curl。已有开发配置没有 Qdrant 字段时使用默认端口，不重写已有密钥。外部依赖模式不会代管容器，需提供可用的 `SUPERDSH_QDRANT_URL`。

此命令会在已确认的开发空库创建 `admin/admin123`；**不要把开发默认账号直接用于对外生产环境**。正常生产更新不需要运行它，也不要把 `SUPERDSH_SERVER_ENV` 误认为其开发配置选择器：它使用 `SUPERDSH_SERVER_DEV_ENV` 或 `.superdsh-work/server-dev/aa-dev.env`。连接已有生产库时必须保留原密码、鉴权密钥和模型加密密钥。

### 3. 准备生产环境文件

在源码目录之外保存受限环境文件，例如 `/etc/superdsh/platform.env`，确保运行用户可读且其他普通用户不可读（例如 `root:superdsh`、权限 `0640`）。同时准备归运行用户所有的 `/var/lib/superdsh/native` 和 `/var/lib/superdsh/files`。以下是字段模板，数据库端口只是示例，须改成第 2 步的实际地址；连接已有部署时复制原值，不能重新生成其密钥：

```dotenv
AGENT_SERVER_DB_URL=postgresql://app_user:URL_ENCODED_PASSWORD@127.0.0.1:15432/app_database
AGENT_SERVER_REDIS_URL=redis://127.0.0.1:16379/0
SUPERDSH_QDRANT_URL=http://127.0.0.1:16333
SUPERDSH_QDRANT_API_KEY=REUSE_OR_CONFIGURE_QDRANT_API_KEY
AGENT_SERVER_SECRET=REUSE_OR_GENERATE_A_RANDOM_AUTH_SECRET
SUPERDSH_MODEL_ENCRYPTION_KEY=REUSE_OR_GENERATE_32_BYTE_BASE64URL_KEY
SUPERDSH_SERVER_DATA_DIR=/var/lib/superdsh/native
AGENT_SERVER_FILES_LOCAL_ROOT=/var/lib/superdsh/files
SUPERDSH_SERVER_HOST=127.0.0.1
SUPERDSH_SERVER_PORT=5174
AGENT_SERVER_PORT=8000
AGENT_SERVER_CORS_ORIGINS=https://superdsh.example.com
AGENT_SERVER_PUBLIC_ORIGIN=https://superdsh.example.com
```

仅全新空库可生成新密钥：`node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` 生成鉴权密钥；将 `hex` 改为 `base64url` 生成 32 字节模型加密密钥。保存到环境文件后持续保留，别写入源码或提交 Git。

### 4. 构建并启动

```bash
corepack yarn server:build
export SUPERDSH_SERVER_ENV=/etc/superdsh/platform.env
corepack yarn server:start
```

构建完整 Harness 与 Next 生产产物；启动读取指定环境文件并执行数据库迁移，然后运行网页/API 和本机 Agent 管理。`server:build` 不读取该环境文件，也不连接数据库；`server:start` 才加载生产配置。不要用只构建网页的 `admin:build` 代替完整平台构建，不设置 `NEXT_OUTPUT=export`，也不要给构建和启动配置不同的 `NEXT_DIST_DIR`。

默认网页/API `http://127.0.0.1:5174`，兼容 API `http://127.0.0.1:8000` 是同一服务，不是另一份数据库。`server:up` 是生产启动别名，不接受 Docker 参数。生产迁移随 `server:start` 自动完成；**不要执行 `server:migrate` 迁移生产库**，该命令读取的是开发配置。

首次空库从日志取得有效期 1 小时的 setup token，浏览器打开 `/#/login`，按初始化流程设置管理员账号。旧库保留账号密码；生产入口不创建或重置 `admin/admin123`。支持空库或 `v2_35` 至 `v2_42` 产品库，当前目标版本为 `v2_42`；旧 AA 数据库先用原版本完成升级。不要公开包含 setup token 的日志。

### 5. 配置 HTTPS 与长期运行

Node 默认仅监听回环。由已有反向代理提供 HTTPS，外部客户端统一使用 `https://superdsh.example.com`；仅暴露所需 HTTPS 端口，不暴露 PG / Redis / Qdrant。Nginx 的 `http` 块内定义升级连接映射：

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    '' close;
}
```

在已配置证书的对应 `server` 块使用：

```nginx
location / {
    client_max_body_size 100m;
    proxy_pass http://127.0.0.1:5174;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_buffering off;
    proxy_read_timeout 3600s;
}
```

反代须覆盖客户端传入的转发头，保留 WebSocket、流式响应和 HTTPS 协议。配置允许的 origin 与实际公开地址一致；OAuth 第三方回调同步使用该地址。普通浏览器与安卓访问同一个平台地址，无需扫码绑定服务端 Agent。

长期运行交给现有 systemd 或进程管理器。下面是首次配置 systemd 的示例，保存为 `/etc/systemd/system/superdsh-platform.service`；已有服务直接核对配置，避免再注册第二份。先用运行用户执行 `command -v node`，把 `ExecStart` 中 `/usr/bin/node` 替换为实际 Node 24 的绝对路径。通过版本管理器安装 Node 时，还需在服务 `PATH` 中包含其目录，systemd 不会读取交互式 shell 初始化文件。

```ini
[Unit]
Description=Starbridge platform web and Node API
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=superdsh
Group=superdsh
WorkingDirectory=/srv/SuperDsh
Environment=SUPERDSH_SERVER_ENV=/etc/superdsh/platform.env
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/node /srv/SuperDsh/scripts/server.mjs start
Restart=on-failure
RestartSec=5
KillMode=mixed
TimeoutStopSec=90
UMask=0077

[Install]
WantedBy=multi-user.target
```

停止前台试运行后，确认数据库依赖已启动，再执行：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now superdsh-platform
sudo systemctl status superdsh-platform --no-pager
sudo journalctl -u superdsh-platform -n 100 --no-pager
curl --fail --silent --show-error http://127.0.0.1:5174/api/v2/health/ready
```

`systemctl` 显示 active 只表示进程存在，还须等待 readiness 返回 HTTP 200、`status: ready`。服务通过环境文件加载密钥，systemd 只保存该文件路径；进程环境中的同名变量优先于文件值，排查旧配置时核对服务 override。停止服务须允许 Node 回收所属 Host，不同时手动启动另一份平台。最终按[上线验收](#上线验收)检查公开地址。

## 配置与数据

| 配置                                              | 含义                                                          |
| ------------------------------------------------- | ------------------------------------------------------------- |
| `SUPERDSH_SERVER_ENV`                             | 生产环境文件路径，`server:start` 必须提供                     |
| `AGENT_SERVER_DB_URL` / `AGENT_SERVER_REDIS_URL`  | PostgreSQL / Redis；保留原数据库和认证                        |
| `SUPERDSH_QDRANT_URL` / `SUPERDSH_QDRANT_API_KEY` | Qdrant HTTP 地址与可选认证 Key；Key 只由后端使用              |
| `SUPERDSH_DEV_QDRANT_PORT`                        | 受管开发 Qdrant 回环端口，默认 `16333`，变更会持久保存        |
| `AGENT_SERVER_SECRET`                             | 原账号、Connector 和签名票据密钥，升级不更换                  |
| `SUPERDSH_MODEL_ENCRYPTION_KEY`                   | 32 字节 base64url 模型加密密钥，需与密文数据库同备份          |
| `SUPERDSH_SERVER_DATA_DIR`                        | 本机 Agent 数据目录，默认仓库 `.superdsh-work/server-native`  |
| `AGENT_SERVER_FILES_LOCAL_ROOT`                   | 已有附件文件根，迁移不自动改变内容                            |
| `SUPERDSH_SERVER_HOST` / `SUPERDSH_SERVER_PORT`   | 默认 `127.0.0.1:5174`，网页与 API 共用                        |
| `AGENT_SERVER_PORT`                               | 默认 `8000` 的兼容 API 监听，和主端口连接同一实例             |
| `AGENT_SERVER_CORS_ORIGINS`                       | 允许的浏览器 origin，逗号分隔，生产使用实际 HTTPS 地址        |
| `SUPERDSH_PERSONAL_MODEL_ALLOWED_ORIGINS`         | 仅精确允许可信自托管供应商 origin，默认不允许内网个人模型地址 |

S3 部署沿用 `AGENT_SERVER_FILES_BACKEND=s3`、`AGENT_SERVER_FILES_S3_BUCKET`、`REGION`、`ENDPOINT_URL`、`PREFIX`、`ACCESS_KEY`、`SECRET_KEY`、`VIRTUAL_HOST_STYLE`（后七项均以 `AGENT_SERVER_FILES_S3_` 开头）。没有设置 S3 时使用本机文件存储。

平台启动后按需管理用户 Agent，无需单独准备 Supervisor。服务端 Agent 使用内部 Node Connector，不需要 Python CLI。账号的数据与接口归属隔离仍有效，但同一运行用户下的进程共享系统权限，**不提供原容器式系统沙箱**。手机退出或离开网页不终止任务；停止平台会回收所属 Agent，重启不自动重放副作用任务。

知识原文和配置存储在 PG；Qdrant 索引可在「知识库」查看状态并重建。备份原文数据库、环境文件和 Qdrant 卷；暂时不可用时管理页面仍可打开，知识检索会明确报错。生产实例启用 Qdrant Key 时，Node 的 `SUPERDSH_QDRANT_API_KEY` 必须与 Qdrant 的服务认证配置一致，不能只改客户端。

## 更新、停止与回退

### 旧 Python 部署切换边界

旧 Python API、Supervisor 和容器 Agent 不再是当前启动链的一部分。迁移时先记录原版本并准备备份方案，停止旧 API、Supervisor、Agent 以及新 Node 平台后，对原数据库、Redis、附件、Agent 卷与原环境文件做一致备份；保留 PostgreSQL、Redis 和原卷。已有生产库必须沿用 `AGENT_SERVER_SECRET`、`SUPERDSH_MODEL_ENCRYPTION_KEY`、密码哈希、稳定用户 / Connector ID 和原数据库，不改成新生成的开发配置。

当前迁移接受空库或产品 `v2_35` 至 `v2_42`，更早的 AA 库先使用其原发布版本升级至 `v2_35`。缺少版本表、未知版本或结构错误会停止；不能手动修改 `alembic_version` 跳过检查。旧 Home 不会在启动时自动迁入本机目录，需要保留历史时先完成下面的离线导入，再启动新平台，避免先创建非空目标 Home。

### 旧容器 Agent 数据离线导入

导入是单独操作，不会在启动时自动合并。先停止旧 API、Supervisor 和待迁用户的 Agent，保留 PG / Redis、原容器与卷；同时停止新 Node 平台。确认没有其他进程使用这些 Home。不要通过删除锁文件跳过正在运行的源检查。

先在原数据库查询稳定归属（不要使用用户名或电脑名称猜测）：

```sql
SELECT a.owner_user_id, a.connector_id, c.name
FROM server_agents a JOIN connectors c ON c.id = a.connector_id;
```

核对原容器标签、挂载与上述用户一致，只查看标签和挂载，不打印含令牌的容器环境：

```bash
docker inspect --format '{{json .Config.Labels}}' <已停止的旧Agent容器>
docker inspect --format '{{range .Mounts}}{{println .Name .Destination}}{{end}}' <已停止的旧Agent容器>
```

向独立备份目录导出真实文件。旧镜像使用 `/data/home`、`/data/connector` 和 `/workspace`；以下示例需替换容器名，导出目录不要放在目标数据根下：

```bash
mkdir -p /srv/superdsh-export/alice/home /srv/superdsh-export/alice/connector /srv/superdsh-export/alice/workspace
docker cp <已停止的旧Agent容器>:/data/home/. /srv/superdsh-export/alice/home/
docker cp <已停止的旧Agent容器>:/data/connector/. /srv/superdsh-export/alice/connector/
docker cp <已停止的旧Agent容器>:/workspace/. /srv/superdsh-export/alice/workspace/
```

如果原容器已移除，仅保留卷，先通过你现有的卷备份工具离线导出同样的 `home/`、`workspace/`、可选 `connector/` 结构；不要启动旧 Agent 来搬运数据。导出文件如含符号链接或特殊文件，先制作经过检查的普通文件备份，导入器不会跟随链接。

导入器要求数据库已经是当前 `v2_42`，且目标 Home 为空。如果旧库尚未到该版本，先确保新旧 API、Supervisor 和全部待迁 Agent 已停止、备份已完成，再使用明确的生产环境文件单独迁移数据库。此操作不启动网页或 Agent，也不会创建目标 Home：

```bash
NODE_ENV=production SUPERDSH_BOOTSTRAP_DEV_ADMIN=0 \
  node --env-file=/etc/superdsh/platform.env apps/admin/server/migrate.ts
```

该独立迁移脚本没有完整平台的运行租约保护，必须人工确认不存在其他写入实例；不要与 `server:start` 并行执行。Node `--env-file` 和生产入口一样，已有进程环境中的同名变量优先，执行前清除与目标配置冲突的旧数据库 / 密钥环境变量。该命令与读取开发配置的 `corepack yarn server:migrate` 不同。

在仓库根使用**原环境文件和原稳定 ID**执行导入，Windows 可将 `corepack` 换成 `corepack.cmd`：

```bash
corepack yarn server:import-agent-data --env /etc/superdsh/platform.env --source /srv/superdsh-export/alice --user-id <owner_user_id> --connector-id <connector_id>
```

不传 `--env` 时，先读取 `SUPERDSH_SERVER_ENV`，否则读取既有开发环境文件；不存在则报错，绝不生成新密钥。命令验证当前 `v2_42`、用户及真实服务端 Connector 归属，取得平台全局和用户 Agent 数据库租约，确保 Node API/Agent 已停。数据库无法验证或租约丢失时取消；导入本身不会升级数据库、改账号或启动任何服务。

目标为配置的 `SUPERDSH_SERVER_DATA_DIR/agents/<用户ID的SHA256>`，必须为空。复制采用暂存后原子提交，写入匹配归属的 `native-runtime.json`；跳过 `node_modules`、旧 Bridge endpoint 和 Connector 运行租约，保留原 Home、工作区和同步资料。发生错误清理暂存，不改源和旧卷，也不覆盖已有目标。旧 API 不使用新租约，所以仍须人工停止它和旧容器。

导入会把原 `/workspace` 转换为本机工作区，同步调整 Harness v4 会话头、会话目录和工作区记录，保留会话 ID 与消息事件；派生缓存重新生成。原始导出和旧卷保持不变，首次连接重新同步历史，不自动重放之前的任务。

导入完成后再启动 Node 平台，进入该用户工作台核对历史、附件、项目与模型；Profile 运行依赖在新环境重新安装。确认完成前保留导出备份和旧卷，不向其他用户导入同一份数据。

### 常规更新

以下适用于已完成 Node 平台部署的服务器。全程使用原运行用户、原目录、原环境文件和原数据库；将示例服务名、路径替换成实际值。更新会停止正在运行的平台与所属 Agent，应在任务可中断的维护时间执行；重启不会自动重放有副作用的任务。

**1. 拉取远程信息并检查本地状态。** 此时不修改正在运行的代码：

```bash
cd /srv/SuperDsh
git remote get-url origin
git branch --show-current
git status --short
git submodule status --recursive
git fetch origin main
git log --oneline HEAD..origin/main
```

确认 `origin` 是本项目仓库（HTTPS 或等价 SSH 地址）、当前分支为 `main`，且主仓库及子模块没有待保留的修改。下面两项任一失败就先处理本地分支或变更，不能用 `reset --hard`、强制 checkout 或 `clean` 覆盖：

```bash
test "$(git branch --show-current)" = main
test -z "$(git status --porcelain --untracked-files=normal)"
```

**2. 停止平台并完成一致备份。** 保持数据库依赖运行，先停止应用写入，再备份数据库、附件、Agent Home、生产环境文件及所用 Redis / Qdrant 持久数据。沿用已有经过恢复验证的备份方案，并在源码目录外记录当前 Git 提交与子模块版本。

下面的数据库备份示例要求先为运行用户配置 PostgreSQL 客户端连接服务 `superdsh`（`~/.pg_service.conf` 与权限 `0600` 的 `~/.pgpass`），指向**与生产环境文件相同的数据库**；不要把连接密码写进 shell 历史。备份路径需要由运行用户持有写权限：

```bash
sudo systemctl stop superdsh-platform
sudo systemctl is-active superdsh-platform
```

第二条预期输出 `inactive`，退出码为非零；这是状态检查，不要把它加入必须全部成功的命令链。确认所属 Agent 已关闭后继续，若显示 `failed`，先检查停止日志和残留进程。

```bash
backup_dir="/var/backups/superdsh/$(date +%Y%m%d-%H%M%S)"
umask 077
mkdir -p "$backup_dir"
git rev-parse HEAD > "$backup_dir/git-revision.txt"
git submodule status --recursive > "$backup_dir/git-submodules.txt"
pg_dump --dbname='service=superdsh' --format=custom --file="$backup_dir/database.dump"
pg_restore --list "$backup_dir/database.dump" > "$backup_dir/database-contents.txt"
tar -czf "$backup_dir/files-agent-env.tar.gz" -C / \
  var/lib/superdsh/native var/lib/superdsh/files etc/superdsh/platform.env
```

每条命令成功后再继续；`pg_restore --list` 只检查备份可读取，不替代在独立库进行恢复演练。路径须覆盖真实数据目录，使用 S3 时另外保留对象存储备份 / 版本。Redis、Qdrant 按现有快照方案备份，不直接复制运行中的数据库卷文件；有旧容器 Agent 卷时一并保留。备份失败则停止升级，修复备份后再继续。

**3. 快进更新并重新构建。** 平台保持停止；任何一条失败都不要继续启动：

```bash
git pull --ff-only origin main
git submodule sync --recursive
git submodule update --init --recursive
node scripts/prepare-aa-source.mjs
corepack yarn server:sync
corepack yarn server:build
git rev-parse HEAD
```

`--ff-only` 遇到本地提交分叉会拒绝合并，先处理分叉再部署。子模块跟随主仓库固定提交，不能更新到上游最新版本。无需上传本机 `node_modules` 或 `.next`，生产服务器根据锁文件生成适配其系统的依赖与产物。保留 `/etc/superdsh/platform.env`、持久目录、数据库卷；日常更新不执行 `server:deps:down`、`docker compose down -v` 或旧 Docker 应用构建命令。

**4. 使用原配置启动并检查迁移。** 未改 systemd unit 时无需 `daemon-reload`；改过 unit 才先 reload：

```bash
sudo systemctl start superdsh-platform
sudo systemctl status superdsh-platform --no-pager
sudo journalctl -u superdsh-platform -n 100 --no-pager
curl --fail --silent --show-error http://127.0.0.1:5174/api/v2/health/ready
```

平台会自动迁移至 `v2_42` 并校验结构，再对外服务。若日志显示数据库版本、密钥、端口或依赖错误，停止反复重启，保留错误进行处理；不要改迁移版本号或重新生成密钥。readiness 未就绪前不宣布部署完成。

### 上线验收

先检查本机，再检查反向代理后的真实域名；下例域名需替换：

```bash
curl --fail --silent --show-error http://127.0.0.1:5174/api/v2/health/ready
curl --fail --silent --show-error --output /dev/null https://superdsh.example.com/
curl --fail --silent --show-error https://superdsh.example.com/api/v2/health/ready
```

浏览器使用实际 HTTPS 地址验证以下内容。URL 中 `#` 后的路径由浏览器处理，`curl` 请求 `/#/login` 无法证明工作台跳转成功。

- `/` 默认进入「星桥智能平台」官网；桌面滚动翻页、手机导航、截图切换 / 放大与图片加载正常，`/website` 兼容地址可访问。
- 点击「进入工作台」到 `/#/login`，未登录时显示登录 / 初始化，已有账号可登录；返回官网正常。旧 `/login` 与已保存的工作台 Hash 链接仍可用。
- 使用已有账号核对权限菜单、模型目录、知识库索引状态及一个归属明确的既有会话；有测试授权时再验证一条实际任务的流式响应、取消与成果下载。
- 通过 HTTPS 验证 WebSocket、流式响应及已有桌面 / 安卓连接；如使用 OAuth，核对原回调身份和登录回跳。官网中的手机截图是手机 Web 演示，不等同于安卓实机验收。

`/api/v2/health/ready` 检查数据库、Redis 与平台运行归属，**不检查 Qdrant、模型供应商或每个 Agent 是否可执行任务**。启用了知识检索时，另外在知识库查看索引状态并使用授权测试资料验证检索。

### 回退与停止

更新失败时先停止新平台，保留失败日志和失败时的数据副本，记录已部署提交与数据库迁移结果。不能仅 `git checkout` 旧提交就假设数据库也已回退：当前没有自动降级迁移，旧代码可能拒绝或错误处理新结构。

若已发生数据库迁移或升级后写入，须按维护方案把**升级前数据库、对应环境密钥、附件与 Agent Home** 一致恢复到隔离目标或已确认的原目标，再恢复匹配的旧代码、固定子模块、依赖与构建产物。保留升级后的数据供核对；备份时点之后的写入需要单独处理，不能静默丢弃。未迁移且仅构建失败时，也先确认旧代码与当前数据库兼容，再恢复原提交并重新构建。任何时刻都不能让新旧平台同时写同一数据库或 Home。

前台进程用 `Ctrl+C`，系统服务用其停止命令。`server:down` 只输出停止方式，不终止未知进程。`server:deps:down` 只停止受管 PG / Redis / Qdrant，保留原卷与环境文件，不执行 `down -v`。平台运行期间不要停止其数据库依赖。

当前测试不等于你的 CentOS 主机、HTTPS、签名或真实三端已完成验收；部署由维护者手动执行，本文不会自动更新运行服务。
