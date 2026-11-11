import { computed, reactive, ref, watch } from 'vue'
import { knowledgeApi } from '@/api/knowledge/knowledge-api'
import { agentsApi } from '@/api/agents/agents-api'
import { loadPreparedAgentResources } from '@/store/modules/agent-resources'
import { useResource } from '@/composables/use-resource'
import { useMutation } from '@/composables/use-mutation'
import { useAuthStore } from '@/store/modules/auth-store'
import {
  knowledgeDraft,
  embeddingDraft,
} from '@/utils/knowledge/knowledge-drafts'
import type {
  EmbeddingDraft,
  KnowledgeBase,
  KnowledgeSource,
} from '@/types/knowledge/knowledge'

/** 知识库用例维护选择代际；慢索引完成后不能覆盖已切换资料的结果。 */
export function useKnowledge() {
  const auth = useAuthStore(),
    mutation = useMutation(),
    indexMutation = useMutation(),
    embeddingMutation = useMutation()
  const allowed = computed(() => auth.can('agents.manage')),
    page = ref(1),
    pageSize = ref(10),
    query = ref(''),
    search = ref('')
  const resource = useResource((signal) =>
    allowed.value
      ? loadPreparedAgentResources(signal, () =>
          knowledgeApi.list(page.value, pageSize.value, search.value, signal),
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
  const health = useResource((signal) =>
    allowed.value ? knowledgeApi.status(signal) : Promise.resolve(null),
  )
  const selected = ref<KnowledgeBase | null>(null),
    editing = ref<KnowledgeBase | 'new' | null>(null),
    deleting = ref<KnowledgeBase | null>(null),
    draft = reactive(knowledgeDraft())
  const documents = useResource((signal) =>
    selected.value
      ? knowledgeApi.documents(selected.value.id, signal)
      : Promise.resolve({ items: [] }),
  )
  const question = ref(''),
    sources = ref<KnowledgeSource[]>([]),
    searched = ref(false),
    historyTarget = ref<KnowledgeBase | null>(null)
  const historyPage = ref(1),
    historySize = ref(10)
  const history = useResource((signal) =>
    historyTarget.value
      ? knowledgeApi.versions(
          historyTarget.value.id,
          signal,
          historyPage.value,
          historySize.value,
        )
      : Promise.resolve({ items: [], currentVersion: 0, total: 0 }),
  )
  const restoring = ref<KnowledgeBase | null>(null),
    embeddingOpen = ref(false),
    embedding = reactive(embeddingDraft())
  const profile = useResource((signal) =>
    auth.can('models.manage')
      ? knowledgeApi.embedding(signal)
      : Promise.resolve(null),
  )
  /** 接收编辑器的新草稿，状态写入只发生在所属用例。 */
  function updateEmbedding(value: EmbeddingDraft): void {
    Object.assign(embedding, value)
  }
  async function reload(): Promise<void> {
    await Promise.all([resource.reload(), catalog.reload(), health.reload()])
  }
  watch([page, pageSize, search], () => {
    void resource.reload()
  })
  watch(selected, () => {
    sources.value = []
    searched.value = false
    question.value = ''
    indexMutation.error.value = ''
    void documents.reload()
  })
  watch([historyPage, historySize], () => {
    void history.reload()
  })
  watch(
    () => auth.generation,
    () => {
      selected.value = null
      editing.value = null
      deleting.value = null
      historyTarget.value = null
      embeddingOpen.value = false
      embedding.apiKey = ''
      sources.value = []
    },
  )
  function filter(): void {
    page.value = 1
    search.value = query.value.trim()
    void resource.reload()
  }
  function edit(value: KnowledgeBase | 'new'): void {
    editing.value = value
    delete draft.version
    Object.assign(draft, knowledgeDraft(value === 'new' ? undefined : value))
    mutation.error.value = ''
  }
  async function save(): Promise<void> {
    const value = editing.value
    if (!value) return
    // 旧资源表单要求名称和用途说明，空白提交保留当前草稿。
    if (!draft.name.trim() || !draft.description.trim()) {
      mutation.error.value = '请填写知识库名称和用途说明'
      return
    }
    if (
      await mutation.run(() =>
        knowledgeApi.save(
          { ...draft, assetIds: [...draft.assetIds] },
          value === 'new' ? undefined : value.id,
        ),
      )
    ) {
      editing.value = null
      await resource.reload()
      if (
        selected.value &&
        selected.value.id === (value === 'new' ? '' : value.id)
      )
        selected.value =
          resource.data.value?.items.find(
            (item) => item.id === selected.value?.id,
          ) ?? null
    }
  }
  async function remove(): Promise<void> {
    const value = deleting.value
    if (value && (await mutation.run(() => knowledgeApi.delete(value.id)))) {
      if (selected.value?.id === value.id) selected.value = null
      deleting.value = null
      await resource.reload()
    }
  }
  async function showHistory(value: KnowledgeBase): Promise<void> {
    historyPage.value = 1
    historyTarget.value = value
    await history.reload()
  }
  async function restore(): Promise<void> {
    const target = historyTarget.value,
      version = restoring.value
    if (
      target &&
      version &&
      (await mutation.run(() =>
        knowledgeApi.restore(
          target.id,
          version.version,
          history.data.value?.currentVersion ?? target.version,
        ),
      ))
    ) {
      restoring.value = null
      await Promise.all([history.reload(), resource.reload()])
      selected.value = null
    }
  }
  async function index(assetId?: string): Promise<void> {
    const value = selected.value
    if (!value) return
    await indexMutation.run(() => knowledgeApi.index(value.id, assetId))
    if (selected.value?.id === value.id) await documents.reload()
    await health.reload()
  }
  async function testSearch(): Promise<void> {
    const value = selected.value,
      text = question.value.trim()
    if (!value || !text) return
    let found: KnowledgeSource[] = []
    if (
      (await indexMutation.run(async () => {
        found = (await knowledgeApi.search(value.id, text)).sources
      })) &&
      selected.value?.id === value.id
    ) {
      sources.value = found
      searched.value = true
    }
    if (selected.value?.id === value.id) await documents.reload()
  }
  function showEmbedding(): void {
    Object.assign(embedding, embeddingDraft(profile.data.value ?? undefined))
    embeddingOpen.value = true
    embeddingMutation.error.value = ''
  }
  async function saveEmbedding(): Promise<void> {
    if (
      await embeddingMutation.run(() =>
        knowledgeApi.saveEmbedding({ ...embedding }),
      )
    ) {
      embeddingOpen.value = false
      embedding.apiKey = ''
      await Promise.all([profile.reload(), health.reload(), documents.reload()])
    }
  }
  async function prepareLocal(): Promise<void> {
    if (await embeddingMutation.run(() => knowledgeApi.prepareLocal()))
      await health.reload()
  }
  return {
    updateEmbedding,
    auth,
    allowed,
    page,
    pageSize,
    query,
    resource,
    catalog,
    health,
    selected,
    editing,
    deleting,
    draft,
    mutation,
    indexMutation,
    documents,
    question,
    sources,
    searched,
    historyTarget,
    historyPage,
    historySize,
    history,
    restoring,
    embeddingOpen,
    embedding,
    profile,
    embeddingMutation,
    reload,
    filter,
    edit,
    save,
    remove,
    showHistory,
    restore,
    index,
    testSearch,
    showEmbedding,
    saveEmbedding,
    prepareLocal,
  }
}
