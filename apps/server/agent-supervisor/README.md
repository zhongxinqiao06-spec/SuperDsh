# Agent Supervisor

仅接受内部随机 Bearer 凭据，API 管理每个稳定用户 ID 的固定容器模板。镜像、平台地址、工作区、卷名和权限不由聊天客户端指定。

- 仅这个控制服务挂载 Docker socket，不公开宿主端口。
- 每个用户独立容器、两个持久卷、独立网络；该网络只连接所属执行容器和平台 API，不连接数据库或其他用户容器。
- 非 root、只读系统目录、删除全部 capabilities、禁止提权；工作区工具继续由 Harness 管理。
- 标签归属检查保护已有容器、卷和网络；相同用户重复准备复用实例。镜像内容或内部凭据变化时替换容器，保留卷。
- `DELETE /agents/{ownerUserId}` 只停止，不删除数据。服务正常关闭时停止所属实例；`yarn server:down` 同时停止对应平台的执行容器。

在仓库根执行隔离单测：

```powershell
apps/server/.venv/Scripts/python.exe -m pytest -q apps/server/tests/test_agent_supervisor.py
```

数据库、API 权限和登录会话属于 `agent_server`；Docker 控制属于此服务，不将平台加密主密钥或数据库凭据传入执行容器。
