import type { Row } from '../infrastructure/database.ts'
import { knowledgeChunks } from './knowledge-index.ts'

/** Deterministic keyword ranking for diagnostics and offline acceptance; runtime uses hybrid Qdrant. */
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
      knowledgeChunks(row).map((source) => ({
        ...source,
        score: [...terms].reduce(
          (score, term) =>
            score +
            (source.content.toLowerCase().includes(term)
              ? Math.min(term.length, 12)
              : 0),
          0,
        ),
      })),
    )
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(({ score: _score, ...entry }) => entry)
}
