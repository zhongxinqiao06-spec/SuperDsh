# 管理端本地字体

保留原界面的 Geist、Geist Mono、Instrument Serif 和 Caveat，使用 Fontsource 5.3.0 发布包中未修改的 Latin WOFF2 字体。Instrument Serif 同时保留正体和斜体；其余使用可变字重。中文继续使用浏览器的中文后备字体。

`../fonts.ts` 使用 `next/font/local`，四个原 CSS 变量保持不变。构建与运行无需访问 Google Fonts，也没有用系统字体替换品牌字体。

`sources.json` 记录每个发布包的固定 URL、SHA-512 完整性信息及本地字体 SHA-256。每个字体目录内的 `LICENSE.txt` 保留原始 OFL-1.1 许可证。更新字体时核对归档完整性、保留许可证，并同步资源清单；`test/local-fonts.test.mjs` 检查本地文件与清单一致。

来源：[Fontsource](https://fontsource.org/)，加载方式：[Next.js 本地字体](https://nextjs.org/docs/app/getting-started/fonts#local-fonts)。
