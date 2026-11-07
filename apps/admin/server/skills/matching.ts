import type { AgentSkill } from '../agents/resource-contracts.ts'
import type { SkillPolicy } from '@superdsh/core/contracts/skills'

/** Scores describe matched rules, not a model's probability. No attachment instructions. */
export function matchSkills(
  skills: AgentSkill[],
  request: string,
  extensions: string[] = [],
  policy?: SkillPolicy,
) {
  const query = request.normalize('NFKC').toLowerCase()
  return skills
    .filter(
      (skill) =>
        skill.enabled &&
        skill.program &&
        (policy?.mode !== 'fixed' || skill.id === policy.fixedSkillId),
    )
    .map((skill) => {
      const match = skill.program!.match
      const excluded = match.excludePhrases.some((term) =>
        query.includes(term.toLowerCase()),
      )
      const reasons = match.phrases
        .filter((term) => query.includes(term.toLowerCase()))
        .map((term) => `需求包含“${term}”`)
      const inputMatch =
        match.inputExtensions.length === 0 ||
        extensions.length === 0 ||
        extensions.some((ext) => match.inputExtensions.includes(ext))
      const score =
        excluded || !inputMatch
          ? -1
          : reasons.length * 10 + (policy?.mode === 'fixed' ? 100 : 0)
      return {
        id: skill.id,
        name: skill.name,
        score,
        reasons: excluded
          ? ['命中排除条件']
          : !inputMatch
            ? ['输入格式不适用']
            : reasons,
        description: skill.description,
        outputTypes: match.outputTypes,
        examples: match.examples,
      }
    })
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
}
