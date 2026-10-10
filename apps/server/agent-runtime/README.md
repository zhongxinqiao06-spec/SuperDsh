# 服务端 Agent 运行时

每个用户容器运行一个完整 Node Harness Host 和固定版本 Python Connector。
执行队列、工具、审批、子 Agent 和工作流继续由 Harness 管理；客户端退出不关闭运行时。

## 构建与启动

在仓库根目录构建 Harness 后，再构建 Linux 镜像：

```powershell
corepack.cmd yarn workspace @superdsh/harness build
docker build -f apps/server/agent-runtime/Dockerfile -t superdsh-agent-runtime:local .
```

日常运行由服务端 Supervisor 创建容器；登录或恢复登录会话后后台幂等准备自己的实例，不阻塞登录、不切换当前聊天。
`POST /api/v2/server-agent` 保留为显式重试入口，不手动扫码或创建 Connector。已有完整 Docker 管理服务仍按用户的启动命令手动更新。

默认本机 `server:dev` 会在运行镜像缺失时自动构建，并利用缓存构建 Supervisor，再启动 Supervisor 与 API relay；本机 API、网页仍分别运行。relay 通过 Docker Desktop 的 `host.docker.internal` 访问本机 API，用户容器继续使用 `http://server-next:8000`。`SUPERDSH_DEV_AGENT_ENABLED=0` 关闭开发 Agent 准备，仅保留电脑模式；纯 Linux 主机此转发路径尚未验证。通用启动步骤见根 [README](../../../README.md#日常开发)。

容器入口是 `tini -g -- python /opt/worker/worker.py`。启动参数由 supervisor 设置：

| 环境变量                         | 含义                                                    |
| -------------------------------- | ------------------------------------------------------- |
| `SUPERDSH_AGENT_SERVER_URL`      | 用户容器可达的 API 地址，例如 `http://server-next:8000` |
| `SUPERDSH_AGENT_CONNECTOR_ID`    | 此用户专属 Connector ID                                 |
| `SUPERDSH_AGENT_CONNECTOR_TOKEN` | 内部 Connector 凭据；不使用用户登录令牌                 |
| `SUPERDSH_AGENT_RUNTIME_ID`      | 固定 `dsh`                                              |
| `DSH_HOME`                       | 固定 `/data/home`                                       |
| `SUPERDSH_AGENT_WORKSPACE`       | 固定 `/workspace`                                       |
| `AGENT_CONNECTOR_DATA_DIR`       | `/data/connector`，保存租约与同步检查点                 |

Node 使用 `@superdsh/harness/host-runtime`，与桌面共享 `runProfile` 和同一安装锚。
Profile 包含 `dsh-base`、`dsh-web-app` 和产品 RuntimeBridge，保留完整 Host API；不加载 Electron 桌面包。
内部模型网关仅监听 `127.0.0.1:8790`，用 Connector 自动续期的 access token 访问固定 API，
流式转发并在客户端取消时关闭上游请求。长期 Connector 凭据不传给 Node 或工具进程。

## 就绪与隔离

`GET http://127.0.0.1:8790/health` 返回 `200 {"ready":true}` 时，真实 Host／Bridge 已就绪，
Connector WebSocket 已连接；准备期间返回 `503`。Docker 健康检查有 90 秒启动宽限。

- 非 root UID/GID `1000:1000`，用户独享 `/data`、`/workspace` 两个持久卷。
- 只读容器根、`CapDrop ALL`、`no-new-privileges`、`/tmp` 临时文件系统。
- 执行容器不挂载宿主路径、Docker socket、其他用户卷或数据库／平台加密凭据。
- `requirements.txt` 固定该 Bridge 内置 Connector 的 Python 依赖；Node 依赖使用根 Yarn 锁与产品补丁。
- 实测 Linux 镜像在上述限制下，Harness 选择 Landlock，报告 `enforcement=full`；允许写工作区，拒绝写工作区外的同用户数据卷路径。

## 验证

```powershell
node --test apps/server/agent-runtime/tests/host.test.mjs
apps/server/.venv/Scripts/python.exe -m unittest discover -s apps/server/agent-runtime/tests -p test_gateway.py -v
Get-Content -Raw apps/server/agent-runtime/tests/sandbox-probe.mjs | docker run --rm -i --network none --read-only --cap-drop ALL --security-opt no-new-privileges --tmpfs /tmp:rw,nosuid,nodev,noexec --entrypoint node superdsh-agent-runtime:local --input-type=module
```

Host 检查使用中文临时 Home 和真实 RuntimeBridge；网关单测使用模拟上游；沙箱检查使用真实容器与真实内核。
完整 API／supervisor／Connector 联调需要另外的临时服务端数据，不操作已有用户库或 Home。
