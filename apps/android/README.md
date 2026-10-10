# SuperDsh Android

SuperDsh 的安卓产品源码。页面使用 Kotlin + Jetpack Compose，业务通过现有 API v2 HTTP/WebSocket 连接平台，由电脑或服务端 Agent 的 Connector 调用完整 Harness。

日常开发直接修改本目录，在 Android Studio 打开 `apps/android`。通用准备与命令统一见根 [README](../../README.md#环境准备)、[检查与打包](../../README.md#检查与打包)；模拟器、SDK 和签名细节见 [安卓开发手册](../../docs/android-local-development.md)，分层规则见 [ARCHITECTURE.md](ARCHITECTURE.md)。本工程独立使用 Gradle；不依赖桌面包、Yarn 模块或上游 Android 目录。

新建会话可选择“服务端 Agent／我的电脑”。没有在线电脑时默认服务端；服务端自动准备独立运行环境和工作区，无需扫码或填写电脑路径。准备完成后使用原主聊天页，消息、附件、审批、取消、工具及子 Agent 沿用现有协议，网页和桌面可继续同一会话。准备失败可重试，平台离线时不会回到电脑配对流程。

“个人资料 → 个人模型”支持三个现有模型协议、供应商地址、模型 ID、API Key、验证和个人默认模型。Key 仅提交服务端加密保存，读取只显示是否已配置；编辑时留空保留原 Key。新会话优先采用个人默认，再采用平台默认；已有会话不会自动切换费用来源。

手机离线时可以查看主动加载过的列表和会话快照并保存草稿，重连后手动发送。缓存和草稿按平台地址及稳定用户 ID 隔离；快照最多保留 20 个，每个不超过 2 MiB。鉴权失效、权限不足和服务错误不会伪装成离线缓存。旧版仅按用户哈希保存的草稿文件保留，但不会自动导入到无法确认平台归属的新空间。

源码基于 `anywhere-labs/Agents-Anywhere` 的固定提交 `f9129757c3ee6071fd845c9de067443f694bad61` 中的 `android/`。原 submodule 保留为上游参考，本目录是唯一产品开发与构建入口。资源中的第三方 LICENSE / NOTICE 必须保留。

迁移保持 `com.agentsanywhere.app` 包名、OAuth 回调与 API v2 协议。更新已有安装必须沿用原签名；构建缓存、APK、`local.properties` 和 keystore 不提交。

账号支持用户名或本人已验证邮箱登录，也保留网页 OAuth 与二维码授权。访问和刷新凭据由 Android Keystore AES-GCM 加密；首次启动会迁移旧登录凭据并移除明文键，保留服务器和界面语言设置。无法解密的跨设备备份要求重新登录，不回退到明文存储。刷新会话按服务端返回的期限旋转，并合并并发刷新；角色与权限取自服务端，权限缩减后隐藏入口，后端继续验证每次请求。初始密码账号必须本人改密，成功后重新登录。

身份回归测试位于 `app/src/test`，根安卓测试入口委托 Gradle `:app:testDebugUnitTest`，覆盖真实本地 HTTP 请求以及刷新／登出竞态。Windows 中文路径且系统 ACP 为 936 时，脚本仅为测试启动器匹配 Java 17 worker 参数文件编码；不改源码 UTF-8 或 build/check 的编码。这些 JVM 测试不代表手机 Keystore 或真实账户验收。

构建结果在 `app/build/outputs/apk/debug/app-debug.apk`。发布签名与正式更新下载地址仍需单独配置；当前 Debug 构建不代表发布版本已就绪。
