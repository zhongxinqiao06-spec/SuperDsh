import { computed, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { agentsApi } from '@/api/agents/agents-api'
import { loadPreparedAgentResources } from '@/store/modules/agent-resources'
import { stageAgentTrial } from '@/api/workbench/trial'
import { useResource } from '@/composables/use-resource'
import { useMutation } from '@/composables/use-mutation'
import { useAuthStore } from '@/store/modules/auth-store'
import { agentDraft } from '@/utils/agents/agent-drafts'
import { agentFieldIssue } from '@/utils/agents/editor-validation'
import type {
  AgentDefinition,
  AgentDraft,
  AgentReadiness,
} from '@/types/agents/agents'

/** 智能体列表、发布、检查、资源选择与试用草稿的响应式用例。 */
export function useAgents() {
  const auth = useAuthStore(),
    router = useRouter(),
    mutation = useMutation()
  const allowed = computed(() => auth.can('agents.manage')),
    page = ref(1),
    pageSize = ref(10),
    query = ref(''),
    search = ref('')
  const resource = useResource((signal) =>
    allowed.value
      ? loadPreparedAgentResources(signal, () =>
          agentsApi.list(page.value, pageSize.value, search.value, signal),
        )
      : Promise.resolve({ items: [], total: 0, page: 1, pageSize: 12 }),
  )
  const catalog = useResource((signal) =>
    allowed.value
      ? loadPreparedAgentResources(signal, () => agentsApi.catalog(signal))
      : Promise.resolve({
          assets: [],
          knowledgeBases: [],
          skills: [],
          tools: [],
        }),
  )
  const editing = ref<AgentDefinition | 'new' | null>(null),
    deleting = ref<AgentDefinition | null>(null),
    draft = reactive(agentDraft()),
    readiness = ref<{ agent: AgentDefinition; result: AgentReadiness } | null>(
      null,
    )
  const originalDraft = ref('')
  const dirty = computed(
    () =>
      Boolean(editing.value) && JSON.stringify(draft) !== originalDraft.value,
  )
  /** 接收编辑器的新草稿，状态写入只发生在所属用例。 */
  function updateDraft(value: AgentDraft): void {
    Object.assign(draft, value)
  }
  async function reload(): Promise<void> {
    await Promise.all([resource.reload(), catalog.reload()])
  }
  watch([page, pageSize, search], () => {
    void resource.reload()
  })
  watch(
    () => auth.generation,
    () => {
      editing.value = null
      deleting.value = null
      readiness.value = null
      Object.assign(draft, agentDraft())
    },
  )
  function filter(): void {
    page.value = 1
    search.value = query.value.trim()
    void resource.reload()
  }
  function edit(value: AgentDefinition | 'new'): void {
    editing.value = value
    delete draft.version
    delete draft.skillPolicy
    Object.assign(draft, agentDraft(value === 'new' ? undefined : value))
    originalDraft.value = JSON.stringify(draft)
    mutation.error.value = ''
  }
  async function save(): Promise<void> {
    const value = editing.value
    if (!value) return
    // 与旧编辑器的必填边界一致；不能依赖服务端报错后才发现空白草稿。
    const issue = agentFieldIssue(draft)
    if (issue) {
      mutation.error.value = '请填写智能体名称、用途说明和工作要求'
      return
    }
    if (
      await mutation.run(() =>
        agentsApi.save(
          {
            ...draft,
            recommendedPrompts: draft.recommendedPrompts
              .map((item) => item.trim())
              .filter(Boolean),
            inputRequirements: draft.inputRequirements
              .map((item) => item.trim())
              .filter(Boolean),
            outputExamples: draft.outputExamples
              .map((item) => item.trim())
              .filter(Boolean),
          },
          value === 'new' ? undefined : value.id,
        ),
      )
    ) {
      editing.value = null
      await reload()
    }
  }
  async function remove(): Promise<void> {
    const value = deleting.value
    if (value && (await mutation.run(() => agentsApi.delete(value.id)))) {
      deleting.value = null
      await resource.reload()
    }
  }
  async function check(agent: AgentDefinition): Promise<void> {
    let result: AgentReadiness | undefined
    if (
      (await mutation.run(async () => {
        result = await agentsApi.readiness(agent.id)
      })) &&
      result
    )
      readiness.value = { agent, result }
  }
  async function publish(agent: AgentDefinition): Promise<void> {
    const value = agentDraft(agent)
    value.published = !agent.published
    if (await mutation.run(() => agentsApi.save(value, agent.id)))
      await resource.reload()
  }
  async function trial(agent: AgentDefinition): Promise<void> {
    if (!agent.published || !auth.can('sessions.run')) return
    stageAgentTrial(agent.id, agent.recommendedPrompts?.[0])
    await router.push('/workspace')
  }
  async function initialize(copyLatest = false): Promise<void> {
    if (!allowed.value) return
    if (await mutation.run(() => agentsApi.initialize(copyLatest)))
      await reload()
  }
  return {
    dirty,
    updateDraft,
    auth,
    allowed,
    page,
    pageSize,
    query,
    resource,
    catalog,
    mutation,
    editing,
    deleting,
    draft,
    readiness,
    filter,
    edit,
    save,
    remove,
    check,
    publish,
    trial,
    initialize,
    reload,
  }
}
