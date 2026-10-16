# 管理端、服务端与安卓端迁移验收

日期：2026-09-28。本文保留当时 Python 后端迁移的历史验收证据，下面的目录、命令与容器行为不作为当前部署步骤。当前平台已迁至 `apps/admin/server`，开发入口见 [README](../README.md)，服务器拉代码升级见[现行部署指南](../apps/admin/deployment/README.md#常规更新)。

## 工程归属

| 应用          | 自有目录       | 构建与运行                                                           |
| ------------- | -------------- | -------------------------------------------------------------------- |
| 桌面          | `apps/desktop` | 根 `dev/build/start`，保持默认入口                                   |
| 管理网页      | `apps/admin`   | `admin:dev`、`admin:check`、`admin:build`                            |
| Python 服务端 | `apps/server`  | `server:sync`、`server:check`、`server:test`、`server:build/up/down` |
| 安卓          | `apps/android` | `android:check`、`android:build`、`android:start`                    |

源代码来自 AA 固定提交 `f9129757c3ee6071fd845c9de067443f694bad61`，具体目录和 Git tree 见[来源清单](../vendor/agents-anywhere/apps-source.json)。三个旧目录已从磁盘移除；稀疏检出保留 Connector、Bridge、协议和 iOS。子模块无未提交修改。新克隆与 CI 都执行 `sources:prepare`。

## 已完成检查

| 检查               | 结果                                                                                                |
| ------------------ | --------------------------------------------------------------------------------------------------- |
| 根 Yarn 不可变安装 | 通过；原有 DSH peer dependency 警告仍存在                                                           |
| 管理端             | 完整类型检查、310 项测试、协议检查、9 页静态构建通过                                                |
| 管理端真实网页     | 表单登录；看板、用户和服务配置页面完整显示，5 个管理 API 返回 200；未登录返回 401，普通成员返回 403 |
| 本地字体           | 5 个 WOFF2 文件随应用提供，保留来源、哈希和 OFL 许可证；构建无需 Google Fonts                       |
| 服务端协议与架构   | 24 项通过；导出只写临时目录，比对固定协议不写回上游                                                 |
| 服务端完整测试     | Linux / Python 3.12：875 项通过、16 项条件跳过、零失败；891 个唯一用例分三个隔离容器完整执行        |
| Docker             | 从新目录构建管理端和 Python 服务；原项目、服务名和三个数据卷保持兼容                                |
| 安卓               | 三项既有静态检查、Debug 构建、启动环境检查通过                                                      |
| APK 兼容           | 新旧 APK 的 SHA-256 完全一致，签名一致；包名、版本和 OAuth 身份未改                                 |
| 桌面集成           | 目录检查、AA Bridge 产物检查通过；布局测试 45 项通过，1 项 macOS 专用检查在 Windows 跳过            |
| 稀疏清理           | 2 项回归通过，覆盖保留本地文件、拒绝未提交修改和实际移除旧目录                                      |
| 代码规范           | 根 lint 通过，格式检查 1,970 个文件零差异                                                           |

真实服务端、桌面 Harness / Connector 与安卓模拟器的双向消息已通过：手机 API 提交的唯一测试消息进入桌面会话，真实 DeepSeek 回复“九加八等于十七。”；桌面原生协议提交的另一条消息回复“六加七等于十三。”，两轮消息与回复均显示在安卓聊天界面。覆盖安装保留原登录和简体中文。

桌面默认模型仍为 `deepseek-official / deepseek-flash / high`。消息使用 API / 桌面 RPC 提交，并核验真实安卓界面；没有把脚本提交描述为手机键盘输入测试。

## 数据与现场证据

- 迁移前源码归档、清单、本地配置备份和旧构建缓存位于忽略目录 `.superdsh-work/apps-migration-20260928`，不加入应用源码。
- 管理端网页和权限证据：该目录下 `admin-live/result.json` 与截图；临时普通成员账号已删除。
- 安卓构建、APK 哈希与签名记录：`.superdsh-work/android-migration/result.json`。
- 跨端消息与界面证据：迁移目录中的 `live-result.json`、`android-saved-chinese-home.png`、`android-replies.png`；首轮失败现场单独保留。
- 原管理员、数据库、上传文件、认证密钥及安卓设备数据保持独立于源码，桌面正常用户配置没有改动。
- `server:down` 保留命名卷，并拒绝带值的删卷参数。原配置丢失但已有卷时，启动脚本会拒绝自动生成新密码，要求恢复原环境文件。

临时 Electron、Harness、Connector、安卓模拟器及 ADB 已退出；Docker 服务端、PostgreSQL、Redis 已停止并移除容器，三个命名卷仍在。测试端口 `15174/15175/15176/5580/5581` 已释放，Ollama 与 Docker Desktop 保留。现场结果见迁移目录的 `shutdown-result.json`。

## 验证边界

Windows 策略拦截了 Python 第三方原生扩展，完整服务端测试改在 Python 3.12 Linux 容器运行，没有更改系统安全策略。安卓没有实际单测文件，三项静态检查和模拟器验收不等于单元测试或真机覆盖。首次模拟器验收遇到系统界面无响应弹窗，保留失败证据后重试；既有登录 WebView 黑屏不计为已修复。macOS、Linux 桌面打包与手机真机本次未重新验证。

服务端 16 项跳过包括 14 项上游已废止的持久通知场景，以及 2 项需要显式配置一次性 PostgreSQL 测试库的用例。实际联通验收使用原 PostgreSQL 服务，未将用户数据卷用于破坏性单测。首次全套测试发现 CRLF / LF 差异，修正文本比对后已重新执行全部用例；原始失败日志仍保留。最终完整报告是 `.superdsh-work/mobile-link-test/server-owned-pytest-final.log`，分片清单和原始日志在同级 `server-test-shards` 目录。
