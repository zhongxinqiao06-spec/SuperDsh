import { reactive, ref, watch } from 'vue'
import { agentsApi } from '@/api/agents/agents-api'
import { loadPreparedAgentResources } from '@/store/modules/agent-resources'
import { skillsApi } from '@/api/skills/skills-api'
import { toolsApi } from '@/api/tools/tools-api'
import { useResource } from '@/composables/use-resource'
import { useMutation } from '@/composables/use-mutation'
import { readPackage } from '@/composables/tools/read-package'
import {
  programToolDependencies,
  validateProgram,
} from '@/utils/skills/program'
import type {
  SkillCandidate,
  SkillDraft,
  SkillResource,
} from '@/types/skills/skills'
const blank = (): SkillDraft => ({
  name: '',
  description: '',
  enabled: true,
  instructions: '',
  requiredToolIds: [],
  programDraft: null,
})

/** 草稿保存与发布分离；导入、匹配预览和回退不会触发Agent执行。 */
export function useSkills() {
  const page = ref(1),
    pageSize = ref(10),
    search = ref(''),
    query = ref(''),
    mutation = useMutation()
  const resource = useResource((signal) =>
      loadPreparedAgentResources(signal, () =>
        skillsApi.list(page.value, pageSize.value, search.value, signal),
      ),
    ),
    catalog = useResource((signal) =>
      loadPreparedAgentResources(signal, () => agentsApi.catalog(signal)),
    ),
    sources = useResource(toolsApi.sources)
  const editing = ref<SkillResource | 'new' | null>(null),
    deleting = ref<SkillResource | null>(null),
    publishing = ref<SkillResource | null>(null),
    history = ref<SkillResource | null>(null),
    draft = reactive(blank())
  const importing = ref(false),
    importTarget = ref<SkillResource | null>(null),
    importKind = ref('package'),
    selectedFile = ref<File | null>(null),
    importTools = ref<string[]>([]),
    sourceId = ref(''),
    sourceVersion = ref(''),
    sourceSkill = ref('')
  const matching = ref(false),
    matchRequest = ref(''),
    matchExtensions = ref<string[]>([]),
    matchSkills = ref<string[]>([]),
    candidates = ref<SkillCandidate[] | null>(null)
  watch([page, pageSize], () => void resource.reload())
  // 阶段依赖必须同步进入技能声明，避免界面选了工具而保存后被服务端授权校验拒绝。
  watch(
    () => draft.programDraft,
    (program) => {
      if (!editing.value) return
      draft.requiredToolIds = [
        ...new Set([
          ...draft.requiredToolIds,
          ...programToolDependencies(program, catalog.data.value?.skills ?? []),
        ]),
      ]
    },
    { deep: true },
  )
  watch(sourceId, (id) => {
    const source = sources.data.value?.find((value) => value.id === id)
    sourceVersion.value = source?.activeVersion ?? ''
    sourceSkill.value = ''
  })
  function filter() {
    page.value = 1
    search.value = query.value.trim()
    void resource.reload()
  }
  function edit(value: SkillResource | 'new') {
    editing.value = value
    mutation.error.value = ''
    for (const key of Object.keys(draft) as Array<keyof SkillDraft>)
      delete draft[key]
    Object.assign(
      draft,
      value === 'new'
        ? blank()
        : {
            name: value.name,
            description: value.description,
            enabled: value.enabled,
            instructions: value.instructions,
            version: value.version,
            requiredToolIds: [...value.requiredToolIds],
            programDraft: structuredClone(
              value.programDraft ?? value.program ?? null,
            ),
            references: value.references,
            packageSha256: value.packageSha256,
          },
    )
    void catalog.reload()
  }
  async function changed() {
    await Promise.all([resource.reload(), catalog.reload()])
  }
  async function save() {
    const invalid = validateProgram(draft.programDraft)
    if (invalid) {
      mutation.error.value = invalid
      return
    }
    if (
      !draft.name.trim() ||
      !draft.description.trim() ||
      !draft.instructions.trim()
    ) {
      mutation.error.value = '请填写技能名称、用途说明和执行要求'
      return
    }
    const id =
      editing.value && editing.value !== 'new' ? editing.value.id : undefined
    if (
      await mutation.run(() =>
        skillsApi.save({ ...draft, name: draft.name.trim() }, id),
      )
    ) {
      editing.value = null
      await changed()
    }
  }
  async function remove() {
    if (
      deleting.value &&
      (await mutation.run(() => skillsApi.delete(deleting.value!.id)))
    ) {
      deleting.value = null
      await changed()
    }
  }
  async function publish() {
    const value = publishing.value
    if (
      value &&
      (await mutation.run(() => skillsApi.publish(value.id, value.version)))
    ) {
      publishing.value = null
      await changed()
    }
  }
  function openImport(value?: SkillResource) {
    importTarget.value = value ?? null
    importTools.value = value?.requiredToolIds ? [...value.requiredToolIds] : []
    importing.value = true
    selectedFile.value = null
    sourceId.value = ''
    sourceVersion.value = ''
    sourceSkill.value = ''
    mutation.error.value = ''
    void sources.reload()
  }
  function fileSelected(event: Event) {
    selectedFile.value = (event.target as HTMLInputElement).files?.[0] ?? null
  }
  async function importPackage() {
    if (
      await mutation.run(async () => {
        const value = importTarget.value
        if (importKind.value === 'extension')
          await skillsApi.importExtension(
            sourceId.value,
            sourceVersion.value,
            sourceSkill.value,
            importTools.value,
            value?.id,
            value?.version,
          )
        else {
          if (!selectedFile.value)
            throw new Error('请选择技能ZIP包 / Choose a skill ZIP')
          await skillsApi.import(
            await readPackage(selectedFile.value, 12 * 1024 * 1024),
            importTools.value,
            value?.id,
            value?.version,
          )
        }
      })
    ) {
      importing.value = false
      selectedFile.value = null
      await changed()
    }
  }
  async function match() {
    let result: SkillCandidate[] | null = null
    if (
      await mutation.run(async () => {
        result = (
          await skillsApi.match(
            matchRequest.value,
            matchExtensions.value,
            matchSkills.value,
          )
        ).candidates
      })
    )
      candidates.value = result
  }
  return {
    resource,
    catalog,
    sources,
    mutation,
    page,
    pageSize,
    query,
    editing,
    deleting,
    publishing,
    history,
    draft,
    importing,
    importTarget,
    importKind,
    selectedFile,
    importTools,
    sourceId,
    sourceVersion,
    sourceSkill,
    matching,
    matchRequest,
    matchExtensions,
    matchSkills,
    candidates,
    filter,
    edit,
    changed,
    save,
    remove,
    publish,
    openImport,
    fileSelected,
    importPackage,
    match,
  }
}
