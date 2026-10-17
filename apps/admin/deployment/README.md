# 星桥智能平台：Docker Compose 部署与更新

拉取代码后，在仓库根执行 **`docker compose up -d --build`** 即可构建并启动官网、工作台、Node API、服务端 Harness、PostgreSQL、Redis 和 Qdrant。默认配置已齐全，**无需复制 `.env`、手工填写数据库地址或安装宿主机 Node / Yarn**。应用启动后自动迁移数据库，并在全新空库创建首个管理员。

代码仓库：[zhongxinqiao06-spec/SuperDsh](https://github.com/zhongxinqiao06-spec/SuperDsh)，默认分支 `main`。已有 Compose 部署看[常规更新](#常规更新)；已有原生、systemd 或旧 Python 部署先看[迁移边界](#旧-python-部署切换边界)。日常源码开发继续使用根 [README](../../../README.md#日常开发) 的命令。

## 服务器首次部署

服务器准备 **Git、Docker Engine 与 Docker Compose v2**，Docker 使用 Linux 容器。先确认 `docker info` 和 `docker compose version` 正常；服务器需能访问依赖、镜像仓库。构建在容器内完成，包含固定的 Node 24、Yarn 4.18、Harness 和 Next 生产产物，以及 Office 预览组件与中文字体。

**2 GB 或更少内存的服务器先检查 swap**，按[小内存服务器](#小内存服务器与-exit-code-137)准备构建所需余量后再执行下面的启动命令。

```bash
git clone --branch main https://github.com/zhongxinqiao06-spec/SuperDsh.git
cd SuperDsh
docker compose up -d --build
```

不需要在宿主机执行 `yarn install`、`server:sync` 或初始化上游子模块；镜像使用仓库固定的运行依赖归档。首次构建需要下载依赖；后续构建可复用 Docker 缓存。构建失败时先解决日志中的错误，不删除数据卷，也不更换锁文件或上游版本。

查看启动状态和日志：

```bash
docker compose ps -a
docker compose logs --tail=100 platform
curl --fail --silent --show-error http://127.0.0.1:5174/api/v2/health/ready
```

`config-init` 成功退出是正常状态，它负责一次性初始化持久配置。其余服务应正常运行，`platform` 就绪后 readiness 返回 HTTP 200。打开 **`http://服务器IP:5174`**，默认是星桥官网，点击「进入工作台」登录。服务器防火墙 / 云安全组需允许实际访问端口；本机浏览器使用 [http://127.0.0.1:5174](http://127.0.0.1:5174)。

### 首次管理员与模型

全新部署默认管理员账号为 **`admin`**，初始密码为 **`admin123`**。登录后请立即修改密码；也可在首次启动前用 `SUPERDSH_INITIAL_ADMIN_PASSWORD` 设置自己的初始密码。在服务器仓库根读取首次凭据记录：

```bash
docker compose exec platform cat /data/config/initial-admin.txt
```

该文件仅用于保存首次初始化信息。登录后可在平台修改密码；文件里的旧密码不会随密码修改更新，手工编辑文件也不会修改数据库密码。数据库密码、鉴权密钥和模型加密密钥保持原值。首次建号失败后的重试继续使用已经保存的首次凭据。

**旧 Compose 部署直接拉取、构建、启动即可兼容新的初始密码，无需额外执行重置命令：**

```bash
git pull --ff-only origin main && docker compose up -d --build
```

首次升级启动时，平台会在独占数据库租约下核对 `initial-admin.txt`：记录的用户名必须与当前初始管理员配置一致，账号必须是启用且未删除的管理员，并且数据库密码仍匹配文件里的原始密码。满足条件后，自动对齐到当前初始密码（默认 `admin123`），同时撤销该账号的旧登录会话和恢复码，记录审计与一次性完成标记。此后重启、重建或修改 `.env` 都不会再次覆盖密码。

已经自行修改过密码、账号状态不符或缺少初始记录的部署保留现有账号。`initial-admin.txt` 继续保留历史记录，自动对齐完成后应使用新的初始密码登录；旧文件不代表当前密码。所有其他账号、模型配置、资料和数据卷保持不变。

平台与知识检索可直接启动。实际 AI 对话仍需要你在「模型管理」或「个人中心 → 个人模型」填入自己的供应商 Key 并选择模型，默认配置不包含付费模型凭据或额度。桌面和手机填写同一个平台地址，例如 `http://服务器IP:5174`；默认无需另开 `8000`。

### 登录 401 与已有管理员密码恢复

点击登录后 `/api/v2/auth/login` 返回 `401 invalid credentials` 表示账号或密码校验失败。仍使用旧随机初始密码的 Compose 部署按上节直接升级启动即可；已经改过密码的账号使用后来修改的密码。未登录时页面检查 `/api/v2/auth/refresh` 收到 401 则属于正常会话检查。

只有已修改后忘记密码、缺少初始记录等不适用自动兼容的情况，才需要显式恢复。需要将**现有管理员 `admin`** 重置为 `admin123` 时，在服务器原仓库目录执行下面的命令。会短暂停止平台与 Agent，并撤销该管理员的旧登录会话和恢复码；账号、角色、模型配置、资料与数据卷保留。PostgreSQL 保持运行。每步确认成功再继续：

```bash
git pull --ff-only origin main
docker compose stop platform
printf '%s' 'admin123' | docker compose run --rm -T --no-deps --volume "$PWD/apps/admin/deployment/reset-admin-password.mjs:/app/apps/admin/deployment/reset-admin-password.mjs:ro" platform node apps/admin/deployment/reset-admin-password.mjs --username admin --password-stdin
docker compose start platform
```

这里将新脚本只读挂载到现有平台镜像，**无需为密码恢复重新构建镜像或在宿主机安装 Node**。命令要求平台已停止、目标账号存在且是启用状态的管理员，不会新建账号、提升权限、重新启用账号或重新生成密钥。脚本成功后使用 `admin / admin123` 登录并修改密码。`initial-admin.txt` 仍保留首次记录，不作为当前密码的凭证。

如果恢复步骤失败，保留报错并用 `docker compose start platform` 恢复原服务，不删除卷或编辑数据库哈希。自定义管理员账号应将 `--username admin` 改为真实用户名；希望设置自己的密码时，可在 Bash 中用 `read -r -s -p 'New administrator password: ' admin_password` 读取，再将上面 `printf '%s' 'admin123'` 换为 `printf '%s' "$admin_password"`，执行后 `unset admin_password`。

### PostgreSQL 初始化报 Operation not permitted

`dependency failed to start: container starbridge-postgres-1 is unhealthy` 是结果，先查看实际数据库日志：

```bash
docker compose logs --tail=100 postgres
docker version --format 'Docker Server: {{.Server.Version}}'
uname -r
# CentOS / RHEL 上补充检查：
rpm -q libseccomp
getenforce
```

如果 `creating subdirectories`、`creating configuration files` 已成功，随后写 `postmaster.pid` 和 `pg_wal/xlogtemp.*` 时出现 `Operation not permitted`，应优先排查新版 Alpine / musl 与旧 Docker、libseccomp 的系统调用兼容问题。musl 的定位写入可能使用较新的系统调用，旧过滤规则返回 EPERM 时无法按“不支持”回退；这类问题见 [Docker 官方镜像维护者说明](https://github.com/docker-library/official-images/issues/16829)。仍需结合宿主版本和安全审计日志确认，不能仅凭 `unhealthy` 判断为目录权限问题。

**仅对新建数据卷、`initdb` 从未成功且日志反复提示清理初始化目录的部署**，可选用同为 PostgreSQL 17 的 Debian Bookworm 镜像。保留原卷和已生成的密码；在仓库根 `.env` 新增或修改这一项（不要用示例文件覆盖已有 `.env`）：

```dotenv
SUPERDSH_POSTGRES_IMAGE=postgres:17-bookworm
```

然后执行以下命令。平台镜像已经构建成功时，无需再次运行 Yarn 或重新构建平台：

```bash
git pull --ff-only origin main
docker compose stop postgres
docker compose pull postgres
docker compose up -d --no-build
docker compose ps -a
docker compose logs --tail=100 postgres platform
```

`.env` 的镜像选择会保留到下次更新。默认仍是 `postgres:17-alpine`，避免拉取代码时给已有数据库隐式更换发行版。**已有成功初始化的 Alpine 数据库不要直接套用这次新库处理步骤**：不同发行版的 libc、locale / collation 和扩展可能不同；优先在维护窗口升级 Docker / libseccomp，或通过备份、逻辑导出与恢复迁移到独立目标并验证。不要换 PostgreSQL 主版本、删除数据卷、使用 `chmod 777`，或把 `privileged` / `seccomp=unconfined` 作为部署修复。

如果 Bookworm 镜像仍报同样错误，保留日志和宿主版本信息，再检查实际数据挂载、文件系统及 SELinux 审计记录；此配置不能代替对宿主容器运行环境的修复。

### 小内存服务器与 exit code 137

镜像默认已限制 Yarn 下载 / 解包、原生依赖编译和 Next 构建的并发，并只安装当前 CPU 架构所需依赖；这些限制只用于构建阶段，不改变平台运行时配置。Yarn 的并发参数含义见[官方配置说明](https://yarnpkg.com/configuration/yarnrc#taskPoolConcurrency)。

**2 GB 整机内存不等于构建可独占 2 GB。** 操作系统、Docker 和已运行的 PostgreSQL / Redis / Qdrant / 平台都会占用内存。2 GB 服务器建议配置 **4 GB swap** 作为构建峰值缓冲；更小内存、多个 Agent 或大型 Office 处理需要增加内存或在另一台机器构建镜像，不能把构建成功理解为所有业务负载都有足够内存。swap 会增加磁盘访问，并不能替代运行负载所需的内存，参见 [Docker 内存与 swap 说明](https://docs.docker.com/engine/containers/resource_constraints/#memory)。

如果 Yarn 的 Fetch / Build 阶段出现 `Killed` 或 `exit code: 137`，先检查宿主机资源与内核日志。137 通常表示进程收到 SIGKILL；内存不足触发 OOM 是一种原因，也可能是外部强制终止，不能仅凭退出码认定：

```bash
free -h
swapon --show
df -h /
docker stats --no-stream
sudo journalctl -k --since '-30 min' | grep -Ei 'out of memory|oom-kill|killed process'
```

已有合适 swap 时无需再创建。下面仅为 Linux ext4 / XFS 上**新增独立 4 GB swap 文件**的示例，先确认根分区可额外容纳 4 GB，并继续为镜像、构建缓存和业务数据留有空间；Btrfs 等文件系统按发行版的 swap 文件要求配置。命令发现同名文件、符号链接或已有 fstab 条目就退出，不覆盖原 swap：

```bash
sudo bash -eu <<'SWAP'
swap_path=/swapfile-starbridge
if [ -e "$swap_path" ] || [ -L "$swap_path" ]; then
  echo "$swap_path already exists; inspect it instead of overwriting" >&2
  exit 1
fi
if awk -v path="$swap_path" '$1 == path { found=1 } END { exit !found }' /etc/fstab; then
  echo "$swap_path already appears in /etc/fstab; inspect the existing entry" >&2
  exit 1
fi
umask 077
dd if=/dev/zero of="$swap_path" bs=1M count=4096 oflag=excl status=progress
chmod 600 "$swap_path"
mkswap "$swap_path"
swapon "$swap_path"
printf '%s none swap sw 0 0\n' "$swap_path" >> /etc/fstab
SWAP
swapon --show
free -h
```

每步失败即停止，只有 `swapon` 成功才追加开机启用项；失败时先查看错误，不删除或重新格式化已有 swap。如果使用独立 BuildKit builder 或云平台的容器限额，还须核对其内存 / swap 限制；宿主机有 swap 不代表受限构建容器能够使用。

小内存机器更新时，正在运行的生产服务会与构建争抢内存。先按[常规更新](#常规更新)记录版本、保留旧镜像，然后在维护时间执行下面的顺序；**从停止平台到新版本就绪期间网站与 Agent 均不可用**：

```bash
git pull --ff-only origin main
docker compose stop platform
docker compose stop postgres redis qdrant
# 此时按下文“一致备份”完成备份，确认成功后再继续。
docker compose build
docker compose up -d --no-build
docker compose ps -a
curl --fail --silent --show-error http://127.0.0.1:5174/api/v2/health/ready
```

逐条确认成功，不在构建失败后继续启动新镜像。仅构建失败、尚未启动新版本时，可用 `docker compose start postgres redis qdrant platform` 恢复原容器；已有数据迁移则按[回退步骤](#回退与停止)处理。停止容器保留卷和密钥，不使用 `down -v`、清理缓存或删除锁文件来处理内存不足。

## 默认配置与数据

根 [compose.yml](../../../compose.yml) 是正式部署入口，[.env.example](../../../.env.example) 仅提供可选覆盖项。所有启动必需值均有默认值；部署密钥在首次启动时随机生成，保存在 `config-data` 卷中，不写入 Git。

| 项目                             | 默认行为                                                        |
| -------------------------------- | --------------------------------------------------------------- |
| Compose 项目名                   | `starbridge`，与开发环境 `superdsh-dev` 分开                    |
| 对外端口                         | `5174`，统一承载网页、API、WebSocket 和客户端连接               |
| 数据库                           | Compose 内部 PostgreSQL；地址、数据库名、账号与随机密码自动配置 |
| Redis / Qdrant                   | 使用 Compose 私有网络中的服务地址；不发布宿主机数据库端口       |
| 配置与密钥                       | `config-data`，容器内 `/data/config`                            |
| Agent 数据                       | `platform-data`，保留每个用户的 Home、工作区与运行数据          |
| 文件与成果                       | `files-data`，保留上传附件与本地文件存储                        |
| PostgreSQL / Redis / Qdrant 数据 | `postgres-data` / `redis-data` / `qdrant-data`                  |
| 首次账号                         | `admin` / `admin123`，首次凭据保存于 `/data/config/initial-admin.txt` |

Docker 卷实际名称默认带项目名前缀，例如 `starbridge_config-data`。源码目录、镜像与持久数据分离：`git pull`、镜像重建、容器重建和正常 `docker compose down` 均保留卷。**不要使用 `docker compose down -v` 删除生产数据。** 保持原项目名；改名会创建另一组新卷，看起来像一套空平台，不会自动迁移原数据。

可选项需要变更时，再把 `.env.example` 复制成仓库根 `.env`，按文件注释修改后运行 `docker compose up -d --build`：

| 可选变量                          | 默认值 / 用途                                                         |
| --------------------------------- | --------------------------------------------------------------------- |
| `SUPERDSH_HTTP_PORT`              | `5174`，宿主机发布端口                                                |
| `SUPERDSH_BIND_ADDRESS`           | `0.0.0.0`；使用同机反向代理时可改为 `127.0.0.1`                       |
| `TZ`                              | `Asia/Shanghai`                                                       |
| `SUPERDSH_PUBLIC_ORIGIN`          | 留空使用实际请求地址；配置域名时填写 `https://实际域名`               |
| `SUPERDSH_CORS_ORIGINS`           | 留空沿用平台默认规则；需要跨域时填写允许的 origin                     |
| `SUPERDSH_INITIAL_ADMIN_USERNAME` | `admin`，初始管理员账号及旧初始凭据的匹配目标                         |
| `SUPERDSH_INITIAL_ADMIN_PASSWORD` | `admin123`；留空沿用默认值，用于新库初始化与旧初始密码的一次性兼容      |
| `POSTGRES_PASSWORD`               | 留空自动生成并持久保存；已有库沿用原密码                              |
| `SUPERDSH_POSTGRES_IMAGE`         | `postgres:17-alpine`；新库兼容问题可按上节选择 `postgres:17-bookworm` |

`.env` 不纳入 Git。首次密码覆盖项用于新库初始化及上述一次性兼容；完成后再修改它不会重置现有账号。数据库和加密密钥须保留原值；配置卷丢失时应恢复备份，不让旧数据搭配新生成的密钥启动。

`AGENT_SERVER_SECRET` 与 `SUPERDSH_MODEL_ENCRYPTION_KEY` 默认留空，由平台生成并保存在配置卷。仅恢复已有部署时填入对应的原始密钥；覆盖值与保存值不一致会拒绝启动，避免已有登录和模型凭据失效。

平台容器统一运行 Node 服务和受管 Harness 子进程，按用户管理 Home、鉴权与数据库租约。它不会为每个用户启动独立 Docker 容器，也不挂载宿主机 Docker socket。同一平台容器里的 Agent 共享系统用户权限，用户归属检查不等同于每用户操作系统沙箱。

### HTTPS 与域名

默认 HTTP 地址可直接访问。需要域名 / HTTPS 时，用现有反向代理转发到 `127.0.0.1:5174`，在可选 `.env` 中配置实际公开 origin；OAuth 供应商回调同时使用该地址。反代部署可把应用发布地址改为回环，仅由代理对外服务。

Nginx 的 `http` 块定义：

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    '' close;
}
```

在已配置域名和证书的 `server` 块添加：

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

代理须覆盖客户端传入的转发头，并支持 WebSocket 和流式响应。HTTPS 证书、域名解析和云防火墙由服务器实际环境提供，默认 Compose 不替你申请域名证书。

## 常规更新

在原仓库目录执行，保持原 Compose 项目名和持久卷：

```bash
git pull --ff-only origin main
docker compose up -d --build
```

无需重填配置。Compose 构建新镜像、重建平台容器，启动时自动执行支持的数据库迁移及上述一次性初始密码兼容；其他已有账号、模型密钥、资料和会话保留。更新会中断当前平台连接及运行中的 Agent，重启不会自动重放有副作用的任务，应安排维护时间。若有本地代码修改或分支分叉，先保留并处理，不使用强制 reset 或 clean 覆盖。

有业务数据且内存充足的服务器推荐按下面的备份顺序更新。先记录当前版本并保留旧镜像；**构建新镜像成功后再停止平台**，构建失败时旧容器可继续运行。小内存机器改用[先停服务再构建](#小内存服务器与-exit-code-137)的维护顺序，避免生产服务与构建争抢内存。

```bash
git status --short
git fetch origin main
git log --oneline HEAD..origin/main
backup_dir="$HOME/starbridge-backups/$(date +%Y%m%d-%H%M%S)"
umask 077
mkdir -p "$backup_dir"
git rev-parse HEAD > "$backup_dir/git-revision.txt"
previous_image="$(docker compose images -q platform | head -n 1)"
docker image tag "$previous_image" "starbridge-platform:backup-$(date +%Y%m%d-%H%M%S)"
printf '%s\n' "$previous_image" > "$backup_dir/platform-image.txt"
git pull --ff-only origin main
docker compose build
```

逐条确认成功再继续。不要在备份完成前执行新平台启动，否则数据库可能先被迁移。

### 一致备份

下面使用已构建的平台镜像作为本地归档工具，无需宿主机 Node 或 PostgreSQL 客户端。先停止平台，再停止数据库依赖，等待命令完成；整个复制期间保持服务停止：

```bash
docker compose stop platform
docker compose stop postgres redis qdrant
project="$(docker inspect "$(docker compose ps -aq platform)" --format '{{index .Config.Labels "com.docker.compose.project"}}')"
test -n "$project"
docker run --rm --user 0:0 --entrypoint tar \
  --mount "type=volume,src=${project}_config-data,dst=/backup/config,readonly" \
  --mount "type=volume,src=${project}_platform-data,dst=/backup/platform,readonly" \
  --mount "type=volume,src=${project}_files-data,dst=/backup/files,readonly" \
  --mount "type=volume,src=${project}_postgres-data,dst=/backup/postgres,readonly" \
  --mount "type=volume,src=${project}_redis-data,dst=/backup/redis,readonly" \
  --mount "type=volume,src=${project}_qdrant-data,dst=/backup/qdrant,readonly" \
  --mount "type=bind,src=${backup_dir},dst=/output" \
  "$previous_image" -czf /output/volumes.tar.gz -C /backup .
tar -tzf "$backup_dir/volumes.tar.gz" > "$backup_dir/contents.txt"
```

这些命令沿用上节的 `backup_dir`、`previous_image`，使用默认卷定义；若自行改过 Compose 的卷名或改用外部数据库，须同步采用真实挂载和对应数据库备份方案。备份所有六个卷，可同时保留数据库、配套密钥、上传文件、Agent Home 和索引。可选 `.env`、反向代理配置及证书也应另存到同一受限备份位置；不要把含密钥的备份提交 Git。归档可列出不等同于恢复成功，应在独立环境演练恢复。

备份失败就停止更新，原容器及卷仍保留；用 `docker compose start postgres redis qdrant platform` 恢复原容器，不要执行 `up` 启动尚未验证的新镜像。备份成功后启动新版本：

```bash
docker compose up -d --build
docker compose ps -a
docker compose logs --tail=100 platform
curl --fail --silent --show-error http://127.0.0.1:5174/api/v2/health/ready
```

### 上线验收

- 打开 `/` 星桥官网和 `/website` 兼容地址，检查图片、桌面滚动翻页和手机布局；点击「进入工作台」到 `/#/login` 并登录。
- 核对已有账号、菜单权限、模型目录、知识库与一条归属明确的既有会话；授权测试时验证实际模型回复、流式响应、取消和成果下载。
- 使用域名时，从真实 HTTPS 地址检查 readiness、WebSocket 和客户端连接；桌面 / 安卓填写同一个平台地址。

`/api/v2/health/ready` 检查数据库、Redis 与平台运行归属，不证明模型供应商或每个 Agent 能执行任务，也不代替 Qdrant 检索验证。使用知识库时另查索引状态并用授权资料验证。官网手机截图是手机 Web 演示，不等同于安卓实机验收。

### 回退与停止

停止并保留所有数据：

```bash
docker compose stop
```

恢复现有容器用 `docker compose start`；删除容器但保留卷用 `docker compose down`。不要加 `-v`。平台应先于依赖停止，正常退出会回收所属 Agent。

新版本启动失败时先停止新平台、保留失败日志和数据副本。仅构建失败且新容器从未运行时，旧容器仍可启动；发生迁移或新写入后，不能只切旧 Git 提交 / 旧镜像就认为数据已回退。当前没有自动降级迁移。

需要回退数据时，将**升级前 PostgreSQL、配置密钥、附件、Agent Home、Redis 与 Qdrant**一致恢复到隔离环境或确认的目标卷，并使用记录的旧提交、旧平台镜像及匹配的数据库镜像版本。备份之后的新增写入需要单独核对，不能静默丢弃。恢复期间不允许新旧平台同时写同一数据库或 Home；确认恢复可用后再对外提供服务。

## 旧 Python 部署切换边界

默认 Compose 是全新部署入口，使用独立 `starbridge_*` 卷，不会自动连接、复制或覆盖原 `superdsh-dev`、原生 systemd 或旧 Python 部署的数据。旧实例有资料时，直接启动得到的是新平台，不能把它当成历史数据已迁移。

迁移已有平台须先备份并停止全部旧写入进程，保留原数据库、稳定用户 / Connector ID、密码哈希、鉴权密钥、模型加密密钥、附件与 Agent Home，再规划导入目标。原数据库当前支持产品 `v2_35` 至 `v2_42` 升级，更早的 AA 库需先用原发布版本升级；未知版本不能手工改 `alembic_version` 绕过。

已有原生或 systemd 部署可继续使用[原生部署与更新](native.md#常规更新)，无需为本次代码更新立即切换存储方式。旧容器 Agent 的稳定归属核对、离线导出及空目标导入步骤保留在[原生迁移指南](native.md#旧容器-agent-数据离线导入)。迁入新 Compose 前必须把原配置与数据成套迁移，不能将新生成的密钥搭配原数据库，也不能在目标 Home 已有数据时覆盖导入。
