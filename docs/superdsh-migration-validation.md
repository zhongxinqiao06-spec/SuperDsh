# SuperDsh 桌面架构验收记录

2026-09-24，Windows x64，Node 24.20.0、Yarn 4.18.0，中文工作目录 `D:\项目\SuperDsh`。本记录覆盖本次 UI/Core 产品控制权重构，替代前一次拆分的产物记录。

## 实现结果

| 范围       | 当前实现                                                                                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 产品控制权 | `ui/src/app/ProductApp.tsx` 创建产品根，应用自己管理导航；必需 Harness 启动失败进入诊断/重试/恢复，业务界面不提前开放。                                             |
| 开发目录   | 自有界面在 `apps/desktop/ui`；状态、服务、main/preload/后端/契约在 `apps/desktop/core`；引擎适配在 `apps/desktop/plugins/harness`。                                 |
| 第三方兼容 | 旧插件使用独立 renderer。Electron 为产品控制的 WebContentsView；浏览器为无 opener 的独立窗口。保留原模块 ID、Slots、Cordis、Remote 和认证。                         |
| 前端来源   | 70 个内置动态模块加产品/兼容/辅助页面由 UI 独立构建。摘要覆盖实际参与构建的 UI 源码和 Core 浏览器产物；缺少自有产物不回退到 vendor 界面。                           |
| 业务模型   | 桌面设置状态、序列化写入、LAN 状态跟踪和 Profile 操作迁入 Core/client；界面拆为独立控件、Profile 视图与编排。                                                       |
| 市场       | 42 个实现文件进入 UI/Core，根市场包仅保留可选插件身份、构建和独立依赖树；285 项原市场测试保留。                                                                     |
| 代码治理   | 统一 Prettier/ESLint/TS 配置；UI 全源码类型检查，边界检查拒绝 UI 的 Node/Electron/后端深导入及 Core/client 的平台依赖。清除23个多余转发源文件；组装开发依赖207→17。 |
| 生命周期   | 新退出协调器阻止重复退出提前结束清理；即使某一步失败也会继续释放其余资源。兼容媒体授权只接受当前受控主框架、正确来源、焦点和用户操作。                              |
| 数据与手机 | 保留既有数据目录、空目标导入/备份/回退、Profile 与手机协议；原 Harness/Agents Anywhere 固定子模块未修改。                                                           |

## 本轮验证

| 检查          | 结果与证据                                                                                                                                         |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 安装锁文件    | `yarn install --immutable` 成功；仍有固定上游 peer 范围警告，无本次依赖解析失败。                                                                  |
| 构建          | 根 `yarn build` 成功；最终 UI sourceDigest 前缀 `e8a0f1260e09`。辅助窗口存在 >500KB chunk 提示，不影响构建。                                       |
| 类型检查      | Core main/preload/browser 三组、Harness、完整UI的1065个源/工具文件、组装和市场通过。                                                               |
| 规范          | 根 lint 零错误零警告，统一格式检查通过；第三方、生成代码和固定子模块不人工格式化。                                                                 |
| 单元/治理测试 | Core288、Harness99、UI14+12、组装8、市场285、根门禁43，共749项通过；3项平台相关既有跳过未计为通过。                                                |
| 布局与来源    | `check:layout` 通过；4个自有workspace、309个固定Harness包、AA来源、市场依赖方向和真实构建输入均验证。                                              |
| 真实 Host     | 安装/移除插件、可选市场与AA切换、必需插件保护、Profile切换、安全模式、恢复、鉴权与进程关闭通过。                                                   |
| 真实 Agent 流 | 本地模型夹具验证增量流、在途重连不重复提交、取消中止请求、审批重连、旧连接拒绝、重复审批幂等和取消后迟到答复。                                     |
| 浏览器UI      | `check:ui` 通过：引导、设置、Profile、恢复、桌面导航与浏览器面板、普通浏览器分支。预加载接口在Chromium中模拟，不等同于全部原生Electron交互。       |
| 产品控制权    | 未修改接口的第三方root插件可在兼容页激活，不能在产品上下文执行或接管根；pagehide真实disposer关闭该renderer连接。                                   |
| Windows产物   | NSIS、PE、依赖闭包、UI产物、许可证和Electron fuses通过；使用随包Electron启动真实Host、会话持久化、AA、浏览器门槛和重启通过。未安装到当前用户系统。 |

测试使用独立临时Home与本地模型服务，不读取真实账号或向外部模型提交任务。日志在仓库 `.superdsh-work/desktop-governance-*.log`，浏览器截图在 `apps/desktop/.superdsh/verification`。

## 安装包

- 文件：`apps/desktop/dist/SuperDsh-2.0.14-x64-Setup.exe`
- 未签名、store模式，1,584,011,029字节。
- SHA256：`AAD2944AB921BD8E6126150A527F333EBA4B2AD04CC32508CB85E0A8077CC51F`
- 对应解包应用：`apps/desktop/dist/win-unpacked`。

## 尚未完成的环境验收

| 项目            | 边界                                                                                                                                                |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 手机实机        | 实际登录AA，与桌面操作同一会话及移动网络变化；本轮只证明本机Bridge和协议可用。                                                                      |
| Windows干净安装 | 在未安装Node/Yarn的机器或虚拟机安装，验证原生窗口、系统权限、终端及原生浏览器。当前随包Host检查没有使用开发Node启动子进程，但不等同于干净系统验收。 |
| 模型/外部功能   | 实际供应商登录、真实附件/模型能力、工作流业务场景以及系统媒体授权；本轮使用本地夹具和组件/接口回归。                                                |
| macOS/Linux     | 保留平台构建与CI检查；原生权限、签名、更新安装和跨平台原生renderer行为需对应系统执行。                                                              |
| 正式发布        | 自有更新服务、签名与发布凭据需配置；本次没有发布或上传安装包。                                                                                      |

## 旧源码清理完成

2026-09-28 08:39（UTC+8），[本机 PowerShell 清理脚本](../scripts/cleanup-retired-sources.ps1) 执行成功，退出码为 0。执行前已重新备份并检查目录边界与用户数据，10 个目标及清空后的 `packages`、`plugins` 父目录已物理移除：

- 旧桌面：`dsh-plugin-desktop`、`dsh-desktop-next`。
- 旧工作空间：`packages/{backend,contracts,desktop-ui}`、根 `plugins/harness`。
- 旧组装副本：`apps/desktop/shared`、`apps/desktop/src`、`apps/desktop/tsdown.config.ts`、`apps/desktop/vite.native-ui.config.ts`。
- 活跃的 `apps/desktop/vitest.config.ts` 保留并纳入代码治理；导入兼容标识、门禁反例和历史契约文档仍保留。

本次备份为 `.superdsh-work/physical-cleanup-20260928-083946-9c8dc892.tar.gz`，SHA256 为 `BF07D27AD97C0735AC0E5EE57143A2AFB24F9D90B2C903D9C5BDF791C1A8D0CF`；完成时间、删除清单与备份信息记录在 `.superdsh-work/physical-cleanup-result.json`。较早的两套桌面和旧自有包快照也保留在 `.superdsh-work`。

此前清理曾被自动审批以 `blocked by policy` 拒绝；用户再次明确授权后，本次执行完成，旧目录残留已解决。

清理后复验：根 `yarn build` 与 `yarn check:layout` 通过，70 个自有浏览器模块正常构建；桌面组装 8 项测试、代码治理与双语校验 5 项测试通过。本轮未重新生成安装包，也未追加手机或其他系统的实机验收。

当前开发入口与具体文件见 [README](../README.md)。
