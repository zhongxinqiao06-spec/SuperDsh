import { Website } from '@/components/website/website'
import {
  websiteMetadata,
  websiteViewport,
} from '@/components/website/website-metadata'

export const metadata = websiteMetadata
export const viewport = websiteViewport

export default function WebsitePage() {
  return <Website />
}
