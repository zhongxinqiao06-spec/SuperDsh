import { lucideIcons, type IconNode } from '@/assets/icons/lucide-icons'

/** 自有界面可选的静态图标名；服务端菜单仍允许传入未知名称。 */
export type AppIconName = keyof typeof lucideIcons

/** 只解析已收录的图标；未知配置使用文件夹，避免将字符串当成 SVG。 */
export function resolveIcon(name: string): readonly IconNode[] {
  return Object.hasOwn(lucideIcons, name)
    ? lucideIcons[name as AppIconName]
    : lucideIcons.folder
}
