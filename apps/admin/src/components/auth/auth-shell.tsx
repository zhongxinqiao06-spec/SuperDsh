'use client'

import { LocaleSwitcher } from '@/components/locale-switcher'

export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-dvh flex-col overflow-y-auto bg-background">
      {/* Top nav */}
      <header className="flex shrink-0 items-center justify-between px-8 py-5">
        <a href="/" className="flex items-center gap-2 text-sm font-semibold">
          <img src="/icon.svg" alt="" width={30} height={30} />
          <span>星桥智能平台</span>
        </a>
        <nav className="flex items-center gap-4 text-sm text-muted-foreground">
          <a
            href="/"
            className="hidden transition-colors hover:text-foreground md:inline"
          >
            了解星桥
          </a>
          <LocaleSwitcher
            size="sm"
            variant="ghost"
            className="text-foreground"
          />
        </nav>
      </header>

      {/* Centered content */}
      <main className="flex flex-1 shrink-0 items-center justify-center px-4 py-12">
        <div className="w-full max-w-sm">{children}</div>
      </main>
    </div>
  )
}
