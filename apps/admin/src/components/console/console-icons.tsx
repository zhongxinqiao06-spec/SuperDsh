import {
  Bot,
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
  User,
  Users,
} from 'lucide-react'

const icons = {
  bot: Bot,
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
  user: User,
  users: Users,
}

export function ConsoleIcon({ name }: { name: string }) {
  const Icon = icons[name as keyof typeof icons] ?? Folder
  return <Icon className="size-4 shrink-0" aria-hidden="true" />
}
