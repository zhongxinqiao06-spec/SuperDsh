import { PublicSessionShare } from '@/components/session/public-session-share'

// 静态导出（NEXT_OUTPUT=export）无法预生成运行时才知道的 shareId。
// 这里只生成 /share/ 外壳，真实 id 由客户端从 URL 解析；Server 侧对
// /share/<id> 由 Next 路由到该外壳，内容通过 Node API v2 加载。
export function generateStaticParams() {
  return [{ shareId: [] as string[] }]
}

export default function SharePage() {
  return <PublicSessionShare />
}
