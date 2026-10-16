import type { Metadata, Viewport } from 'next'

export const websiteMetadata: Metadata = {
  title: '星桥智能平台 · 让企业经验，成为团队的 AI 能力',
  description:
    '星桥智能平台连接企业知识、业务模板、技能与智能体，让公司自己的资料和工作方法，转化为可复用的 AI 能力与真实办公成果。',
  applicationName: '星桥智能平台',
  openGraph: {
    title: '星桥智能平台 · 企业自己的 AI 工作平台',
    description: '连接知识与行动，让每一份企业经验创造新的价值。',
    locale: 'zh_CN',
    type: 'website',
  },
}

export const websiteViewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  themeColor: '#090c0b',
  colorScheme: 'dark light',
}
