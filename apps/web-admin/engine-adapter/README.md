# 固定引擎适配

此目录是 DSH 引擎注册与传输适配，源码全部为 TypeScript。平台业务后端只在 `../backend` 使用 Python：身份、权限、数据库、收据、模型网关、工具执行及进程监督不在此目录实现。

构建入口为根命令配置的 `tsdown.config.ts`，严格类型检查使用 `tsconfig.json`。生成的 `dist/host.mjs` 不进入 Git；Python 只运行已构建产物，缺失时明确报错，不临时执行 TypeScript 或旧管理端。

引擎版本与依赖来源读取 `apps/desktop/plugins/harness/package.json`、根锁文件和固定 vendor 清单。装配复用同一安装锚点的 `host-runtime`、`server-profile`、产品 patches 和完整运行依赖，不从子模块源码加载，不更新 pin。

固定版本也提供官方 Python SDK 和自包含 runtime。其标准 SDK 启动 stdio Host，当前协议没有产品所需的逐会话取消、preset 组合和持久投影 ACK 全部接缝。因此产品由 Python 直接接入同一完整 Host 的 TCP RuntimeBridge，单个会话只有一条命令路径。这里的 Node 进程就是固定引擎进程，不是另一个 Node 业务服务。

`host.ts` 只装配引擎和生命周期信号；`tools.ts` 只注册显式描述和转发工具调用、结果、取消。工具授权和冻结修订必须由 Python 回调复验，未注入工具服务时拒绝执行。模型能力只面向回环、当前所有者和短期 secret；登录令牌、数据库密码与供应商密钥不传给引擎。

真实验收入口为 `tests/integration/test_dsh_runtime.py`：专用 PostgreSQL、临时 Home、真实固定 Host 与受控本地模型。协议反例位于 `tests/contracts/test_dsh_bridge.py`。受控模型结果不宣称覆盖外部付费模型或真实设备。
