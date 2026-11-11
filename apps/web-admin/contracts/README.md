# 基础生产契约

此目录只存生产 Schema，不存测试种子、旧源码快照、请求日志或黄金样本。

- `*Input.schema.json` 从后端 Pydantic VO 导出；集中契约测试检查漂移。
- `ExtensionManifest.schema.json` 描述实现声明和工具 Schema；声明登记不等于已安装可执行代码。实际安装、MCP 和生产扩展生命周期由第二份计划完成。
- `SkillProgram.schema.json` 描述普通阶段、辅助工具与检查声明；业务 service 继续校验相邻 prepare/execute、资源归属、当前授权和真实收据。
- 阶段一的通用配置入口为 `/api/resources/*`，用于验证扩展声明、配置密文、资源版本和组合发布。它们不登记为旧管理 API 的兼容别名；旧 `/admin/agents` 等完整 DTO 和交互在第二份计划实现。
- 身份、用户、角色、菜单、OAuth 与已实现的 DSH 基础入口共享无版本 handler。旧入口仅由 `deployment/compatibility-routes.json` 声明，不在本目录复制业务路径。
- 默认资源包位于 `backend/resources/default-package.json`，只声明可编辑方法和配置，不暗中安装工具。账号初始化标记独立保存；删除示例后不会在重启或登录时恢复。
- 当前成果采用新数据卷下的受管本地对象目录，公开成果与证据由服务验证归属、执行收据和文件摘要；S3/MinIO provider 属于第二份存储功能迁移，不能把部署存在 MinIO 误报为业务已经使用它。
