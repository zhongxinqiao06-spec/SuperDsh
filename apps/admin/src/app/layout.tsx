import type { Metadata, Viewport } from 'next'
import 'katex/dist/katex.min.css'
import './globals.css'
import { ThemeProvider } from '@/components/theme-provider'
import { ToasterProvider } from '@/components/toaster-provider'
import { I18nProvider } from '@/i18n/client-provider'
import { sans, mono, serif, brand } from './fonts'

export const metadata: Metadata = {
  title: '星桥智能平台',
  description: '星桥智能平台 · 企业管理与 AI 智能体工作台',
  applicationName: '星桥智能平台',
  manifest: '/site.webmanifest',
  icons: {
    icon: [
      {
        url: '/favicon-dark-mode.png',
        type: 'image/png',
        media: '(prefers-color-scheme: dark)',
      },
      {
        url: '/favicon-light-mode.png',
        type: 'image/png',
        media: '(prefers-color-scheme: light)',
      },
      {
        url: '/favicon-dark-mode.png',
        type: 'image/png',
      },
    ],
    apple: [
      {
        url: '/apple-touch-icon.png',
        sizes: '180x180',
        type: 'image/png',
      },
    ],
  },
  appleWebApp: {
    capable: true,
    title: '星桥智能平台',
    statusBarStyle: 'black-translucent',
  },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  colorScheme: 'dark light',
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#0a0a0b' },
    { media: '(prefers-color-scheme: light)', color: '#fafaf9' },
  ],
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${sans.variable} ${mono.variable} ${serif.variable} ${brand.variable} antialiased`}
      >
        <I18nProvider>
          <ThemeProvider defaultTheme="dark">
            {children}
            <ToasterProvider />
          </ThemeProvider>
        </I18nProvider>
      </body>
    </html>
  )
}
