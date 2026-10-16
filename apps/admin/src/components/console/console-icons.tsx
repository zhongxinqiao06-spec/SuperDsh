import {
  Bot,
  BookOpen,
  Folder,
  Gauge,
  History,
  KeyRound,
  Menu,
  Monitor,
  Paintbrush,
  Settings,
  Shield,
  Smartphone,
  Sparkles,
  User,
  Users,
  Wrench,
} from 'lucide-react'

const icons = {
  bot: Bot,
  'book-open': BookOpen,
  folder: Folder,
  gauge: Gauge,
  history: History,
  key: KeyRound,
  menu: Menu,
  monitor: Monitor,
  paintbrush: Paintbrush,
  settings: Settings,
  shield: Shield,
  smartphone: Smartphone,
  sparkles: Sparkles,
  user: User,
  users: Users,
  wrench: Wrench,
}

export function ConsoleIcon({ name }: { name: string }) {
  const Icon = icons[name as keyof typeof icons] ?? Folder
  return <Icon className="size-4 shrink-0" aria-hidden="true" />
}
