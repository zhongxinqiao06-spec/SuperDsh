# 安卓开发与本地启动

安卓产品源码在 `apps/android`，与 `apps/desktop`、`apps/admin`、`apps/server` 同级。使用 Kotlin + Jetpack Compose，独立使用 Gradle；根 Yarn 只提供统一命令。旧 `agents-anywhere/android` 已通过稀疏检出从工作目录移除，上游版本仍保存在固定提交中。

通用构建、启动和检查命令见根 [README](../README.md#检查与打包)，登录与聊天模式见 [三端联调](../README.md#三端联调)。本页只维护安卓工具链、模拟器和参数说明。

启动脚本安装已有的 `apps/android/app/build/outputs/apk/debug/app-debug.apk`，也可通过根目录 `start-android.cmd` 调用。它使用 `adb install -r` 保留登录和语言设置。应用包名仍是 `com.agentsanywhere.app`；覆盖安装必须沿用原签名，不能通过卸载解决签名冲突。迁移源码不需要搬动 SDK、AVD 或设备数据。

## 开发入口

| 修改内容                   | `apps/android` 内的目录                                      |
| -------------------------- | ------------------------------------------------------------ |
| 页面和组件                 | `app/src/main/java/com/agentsanywhere/app/ui`                |
| 业务状态和操作             | `app/src/main/java/com/agentsanywhere/app/feature`           |
| HTTP、WebSocket 和数据类型 | `app/src/main/java/com/agentsanywhere/app/api`               |
| 应用入口和导航             | `app/src/main/java/com/agentsanywhere/app/app`、`navigation` |
| 简体中文文案               | `app/src/main/res/values-zh-rCN`                             |
| 依赖版本和协议检查         | `gradle/libs.versions.toml`、`build.gradle.kts`、`config`    |

Android Studio 直接打开 `apps/android`。分层规则见该目录的 `ARCHITECTURE.md`。Kotlin 保留现有官方风格；迁移不改 API、OAuth 回调或登录存储格式。

## 构建环境

需要 JDK 17、Android SDK API 36 和 Build Tools 34.0.0。项目固定 Gradle 8.10.2、AGP 8.7.3、Kotlin 2.2.0，本次不升级工具链。首次构建需要下载依赖。

构建脚本读取 `JAVA_HOME`、`ANDROID_HOME`、`GRADLE_USER_HOME`，也可创建被 Git 忽略的 `.superdsh-work/android-build.json`：

```json
{
  "java-home": "D:/Java/jdk-17",
  "sdk": "D:/Android/Sdk",
  "gradle-home": "D:/Android/gradle-cache",
  "server": "http://127.0.0.1:8000",
  "offline": false
}
```

本机配置复用已有 SDK 和 Gradle 缓存，默认离线构建。缓存缺少依赖时可运行 `node scripts/android.mjs build --online`；配置了本机 `init-script` 时还需要对应的仓库服务在线。该配置只用于当前机器，不写入产品 Gradle 文件。

`server` 仅设置 Debug APK 的默认服务器，不覆盖 App 已保存的地址。正式发布继续单独配置签名和下载地址。本机构建保留默认用户目录中的 Debug keystore；不要把构建的 `ANDROID_USER_HOME` 改为模拟器专用目录，否则可能生成不同签名。

不使用根命令时，可在 `apps/android` 下调用 Wrapper 的 Java 入口，避免 Windows 中文路径的批处理编码问题：

```powershell
& "$env:JAVA_HOME/bin/java.exe" -classpath gradle/wrapper/gradle-wrapper.jar `
  org.gradle.wrapper.GradleWrapperMain -Pandroid.overridePathCheck=true assembleDebug
```

`node scripts/android.mjs --help` 列出 SDK、缓存、离线模式等参数。构建目录、`local.properties`、签名文件不提交 Git。

## 模拟器与联通

启动脚本需要 Node 24、SDK Emulator / Platform Tools 和已有 AVD。运行 `node scripts/start-android.mjs --check` 只检查启动环境。

本机设置在 `.superdsh-work/android-launcher.json`：

```json
{
  "sdk": "D:/Android/Sdk",
  "avd": "YourAvdName",
  "port": 5580,
  "server": "http://127.0.0.1:8000",
  "gpu": "host"
}
```

自定义 AVD 可增加 `avd-home`、`user-home`。SDK 和 AVD 尽量使用英文路径；当前机器通过 `D:/SuperDshAndroidTest` 访问已有缓存。`--avd`、`--port`、`--apk` 可覆盖配置，`--headless` 用于无窗口验证。

脚本核对设备编号和 AVD 名称后复用已有模拟器，并保留原窗口模式；不会卸载 App、清数据或结束其他设备。启动参数 `--server` 或配置中的 `server` 只用于健康检查与本机 `adb reverse`，不会改写 App 已保存的服务器地址，也不会启动 Docker。切换环境后，必须在 App 登录页选择对应地址。

| 环境             | App 的平台服务地址       | 用途                                                      |
| ---------------- | ------------------------ | --------------------------------------------------------- |
| 本机开发 API     | `http://127.0.0.1:8000`  | 连接本机 Python API，网页开发地址 `5174` 不用于 App 登录  |
| 完整 Docker 部署 | `http://127.0.0.1:15174` | 连接部署后的 API，含服务端 Agent 的 Supervisor 和运行容器 |

启动脚本对本机地址自动反向映射对应端口。手动使用已经打开的模拟器时，开发 API 需要执行 `adb -s emulator-5580 reverse tcp:8000 tcp:8000`；完整 Docker 环境对应 `tcp:15174 tcp:15174`。设备编号以 `adb devices` 为准。仅 PG / Redis 的开发模式不提供服务端 Agent 容器；电脑模式需要目标 Connector/Harness 在线，完整部署方式见 [服务端说明](../apps/server/README.md)。

App 的首页头像 → `Language（语言）` → `简体中文` 可切换语言；网页授权页有自己的语言菜单。登录状态、中文设置和既有会话随 AVD 保留。

## 排错与验证边界

每次启动的日志、`result.json` 和 `started.png` 位于 `.superdsh-work/android-launcher/<时间>/`。成功要求系统启动完成、AVD 匹配、安装成功、App 进程存在且主 Activity 位于前台。

- 缺少 SDK、AVD、APK：查看错误路径；APK 必须先从 `apps/android` 构建。
- 端口占用或设备不符：指定其他偶数 `--port`，不自动清理其他进程。
- 签名冲突：使用原 keystore 重新构建，保留安装数据。
- 构建警告：当前 AGP 对 API 36、D8 对 Kotlin 2.2 有兼容提示；不得把 Debug 构建成功当作签名发布验收。
- 检查覆盖：三个静态检查不等于单元测试；JVM 测试覆盖产品状态和协议行为，不代表模拟器界面或手机实机验收。测试和 APK 构建分别运行。
- 已知问题：API 36 / WebView 133 的登录页曾出现黑屏，原生首页和聊天正常；目录迁移和启动脚本不代表该问题已修复。

迁移后的设备验收应包括同签名覆盖安装、登录和中文设置保持、原会话恢复、安卓发消息与桌面消息实时同步。旧测试截图和日志保留原路径，作为历史记录。
