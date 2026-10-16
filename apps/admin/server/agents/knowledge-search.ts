import { text } from '../http/api-router.ts'
import type { Row } from '../infrastructure/database.ts'

/** Bounded lexical retrieval for the demo; no vector index or invented evidence. */
export function knowledgeExcerpts(rows: Row[], query: string) {
  const normalized = query.trim().toLowerCase().slice(0, 200)
  const terms = new Set(normalized.match(/[\p{L}\p{N}]+/gu) ?? [])
  for (const segment of normalized.match(/[\p{Script=Han}]+/gu) ?? []) {
    for (let index = 0; index < segment.length - 1; index++) {
      terms.add(segment.slice(index, index + 2))
    }
  }
  return rows
    .flatMap((row) =>
      (text(row.extracted_text).match(/[\s\S]{1,900}/g) ?? []).map(
        (content, index) => ({
          assetId: row.id,
          filename: row.name,
          paragraph: index + 1,
          sha256: row.sha256,
          content,
          score: [...terms].reduce(
            (score, term) =>
              score +
              (content.toLowerCase().includes(term)
                ? Math.min(term.length, 12)
                : 0),
            0,
          ),
        }),
      ),
    )
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(({ score: _score, ...entry }) => entry)
}
