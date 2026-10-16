# 星桥智能平台 Web 与管理端

`apps/admin` 是 Next.js + React + TypeScript 官网、工作台、管理网页与 Node.js API 的统一应用。`src` 放界面，`server` 放身份、数据库、模型、设备和 Agent 生命周期，不再依赖独立 Python 后端。环境、启动和检查统一见根 [README](../../README.md#日常开发)，首次部署见[部署指南](deployment/README.md)，服务器拉取新代码见[常规更新](deployment/README.md#常规更新)。

启动默认进入 `/` 星桥官网，`/website` 保留独立官网地址；「进入工作台」使用 `/#/login`，旧登录页和工作台 Hash 链接保持兼容。官网包含卖点、业务示例、平台架构及桌面 / 手机 Web 界面演示，图片随 Next 构建一起发布。

## 代码入口

| 内容                              | 目录                                                |
| --------------------------------- | --------------------------------------------------- |
| 页面入口、主题与本地字体          | `src/app`                                           |
| 官网、整屏滚动与界面截图展示      | `src/components/website`、`public/images/website`   |
| 后台框架、总览、菜单编辑          | `src/components/console`                            |
| 模块注册、Hash 路由、导航 API     | `src/features/console`                              |
| 管理页面、通用弹窗与分页          | `src/components/pages`、`src/components/management` |
| 工作台组装与账号内存状态          | `src/components/demo.tsx`、`src/features/workbench` |
| 登录、OAuth 和客户端业务模型      | `src/components/auth`、`src/features`               |
| API、身份、数据库、Node Connector | [server](server/README.md)                          |
| PG / Redis / Qdrant 与生产配置    | [deployment](deployment/README.md)                  |
| 中文与英文 / 生成协议             | `messages` / `src/generated/protocol/v1`            |

## 框架与权限

登录进入总览，管理员与普通用户使用同一布局，菜单按实际权限过滤。`src/features/console/modules.ts` 注册页面、路由和懒加载入口，对应 `server/management/navigation.ts` 的服务端目录。新模块无需修改聊天根组件。`#/access/menus` 支持两级分组、名称、图标、排序、显示和角色范围；并发更新返回 409，隐藏菜单不改变授权。无权限显示 403，未知页面显示 404，旧 Hash 链接仍映射。

管理页不依赖 `WorkspaceProvider`、设备查询或会话 WebSocket。网页认证发送 `X-SuperDsh-Agent-Preparation: deferred`，进入工作台才准备 Agent；已有实例复用，失败显式重试。离开工作台释放订阅，不停止已提交任务；桌面和安卓保持原准备时机。

草稿、待上传 File、设备/模型选择及发送结果保存在当前账号页面内存；切模块恢复，换账号清理，刷新不保留临时附件。手机连接页只管理登录记录，聊天在工作台；已登录手机无需再次扫码。

## 交互和开发约定

聊天外页面采用“筛选工具栏 + 表格或卡片 + 分页”。新增、编辑和提交型配置放入 `ManagementDialog`；失败保留草稿，取消不提交，删除/封锁/撤销先确认。外观设置即时生效。通用实现位于 `src/components/management/presentation.tsx`。

用户、设备运维、审计和登录记录由 API 全量筛选后分页，返回 `total/page/pageSize`。角色、菜单和供应商完整目录在前端分页，默认 25 条，可选 10/25/50/100；旧客户端无分页参数调用保持兼容。

统一 Node 入口同时提供 `5174` 网页/API 和 `8000` 兼容 API。`server:dev` 与 `admin:dev` 是同一启动方式，不要同时执行。界面热更新由 Next 处理；服务端 TypeScript 修改后重启统一进程，正常账号登录或模块切换不重启 Host。

浏览器组件不能导入服务端数据库、密钥或进程模块。服务端与浏览器分别类型检查，公共协议沿用 API v2。`protocol:generate` 只生成本包类型，固定 `agents-anywhere/contracts/protocol/1.0` 只读。字体及许可在 `src/app/fonts`，生产构建无需访问 Google Fonts。

本包继承根 Yarn 4.18、Prettier、ESLint，不维护独立锁文件；脚本直接调用 Node 工具入口以兼容 Windows 中文路径。旧源码和历史报告是迁移依据，不参与运行或构建。
