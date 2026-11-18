<script setup lang="ts">
import ExpandableText from '@/components/base/ExpandableText.vue'
import { computed, ref, watch } from 'vue'
import type { StudioAsset, StudioProject } from '@/types/studio/studio'
import StudioMedia from './StudioMedia.vue'
import { uploadFile } from '@/api/files/upload-api'
import { useAuthStore } from '@/store/modules/auth-store'
import type { studioApi } from '@/api/studio/studio-api'
import { assetKinds, mediaKind } from '@/utils/studio/media-labels'
import { createUuid } from '@/utils/uuid'
const auth = useAuthStore()
const props = defineProps<{
  readonly?: boolean
  project: StudioProject
  voices: string[]
  busy: boolean
  create: (
    body: Parameters<typeof studioApi.asset>[0],
    link: boolean,
  ) => Promise<boolean>
}>()
const emit = defineEmits<{
  draft: [boolean]
  link: [string]
  favorite: [StudioAsset]
}>()
const kind = ref<StudioAsset['kind']>('character'),
  name = ref(''),
  description = ref(''),
  voice = ref(''),
  fileId = ref<string | null>(null),
  parent = ref<string | null>(null),
  personal = ref(false)
const adopted = ref(''),
  filter = ref(''),
  scope = ref('project'),
  use = ref(''),
  uploading = ref(false),
  error = ref('')
const mode = ref(props.readonly ? 'library' : 'edit')
const fileInput = ref<HTMLInputElement>()
const fields = computed(() => ({
  name: name.value,
  kind: kind.value,
  description: description.value,
  voice: voice.value,
  fileId: fileId.value,
  parent: parent.value,
  project: personal.value ? null : props.project.id,
}))
const hasDraft = computed(
  () =>
    !!(
      name.value ||
      description.value ||
      fileId.value ||
      voice.value ||
      parent.value ||
      uploading.value
    ),
)
watch(hasDraft, (value) => emit('draft', value))
const used = (id: string) =>
  props.project.document.shots.filter(
    (s) => s.references.includes(id) || s.lines.some((l) => l.role === id),
  )
const isAdopted = (a: StudioAsset) =>
  props.project.document.shots.some(
    (s) =>
      a.sourceJob &&
      (s.candidate === a.sourceJob ||
        s.lines.some((l) => l.audio === a.sourceJob)),
  )
const matches = computed(() =>
  props.project.assets.filter(
    (a) =>
      (!filter.value || a.kind === filter.value) &&
      (!adopted.value || isAdopted(a) === (adopted.value === 'yes')) &&
      (scope.value === 'personal'
        ? a.project === null
        : props.project.document.assets.includes(a.id)) &&
      (!use.value || used(a.id).some((s) => s.id === use.value)),
  ),
)
function revise(a: StudioAsset) {
  mode.value = 'edit'
  kind.value = a.kind
  name.value = a.name
  description.value = a.description
  voice.value = a.voice
  fileId.value = a.fileId
  parent.value = a.id
  personal.value = false
}
async function upload(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  uploading.value = true
  error.value = ''
  try {
    fileId.value = (await uploadFile(file)).fileId ?? null
    if (!name.value) name.value = file.name
  } catch (e) {
    error.value = String(e)
  } finally {
    uploading.value = false
  }
}
function cancelVersion() {
  parent.value = null
  name.value = ''
  fileId.value = null
  description.value = ''
  voice.value = ''
  error.value = ''
  if (fileInput.value) fileInput.value.value = ''
}
async function submit() {
  const submitted = fields.value
  const signature = JSON.stringify(submitted)
  if (attempt?.signature !== signature)
    attempt = { signature, key: createUuid() }
  if (
    (await props.create(
      {
        ...submitted,
        requestKey: attempt.key,
        expectedVersionId: submitted.parent ?? undefined,
      },
      !personal.value,
    )) &&
    submitted === fields.value
  )
    cancelVersion()
}
let attempt: { signature: string; key: string } | undefined
</script>
<template>
  <div class="form-stack">
    <el-tabs v-model="mode" aria-label="本片素材维护"
      ><el-tab-pane
        v-if="!readonly && auth.can('studio.assets.write')"
        label="新建或编辑设定"
        name="edit" /><el-tab-pane label="本片素材" name="library"
    /></el-tabs>
    <form
      v-if="mode === 'edit' && !readonly && auth.can('studio.assets.write')"
      class="panel studio-panel studio-form"
      @submit.prevent="submit"
    >
      <h2>{{ parent ? '新素材版本' : '新增素材' }}</h2>
      <label class="field"
        >类型<select v-model="kind" class="native-control">
          <option v-for="(label, k) in assetKinds" :key="k" :value="k">
            {{ label }}
          </option>
        </select></label
      >
      <label class="field"
        >名称<input
          v-model="name"
          class="native-control"
          required
          maxlength="120" /></label
      ><label class="field"
        >外观或设定<textarea v-model="description" class="native-control" />
      </label>
      <label v-if="kind === 'character'" class="field"
        >默认音色<select v-model="voice" class="native-control">
          <option value="">待选</option>
          <option v-for="v in voices" :key="v">{{ v }}</option>
        </select></label
      >
      <label
        v-if="auth.can('files.write') && auth.can('files.read')"
        class="field"
        >上传参考文件<input
          ref="fileInput"
          class="native-control"
          type="file"
          @change="upload"
      /></label>
      <p v-if="fileId" class="studio-meta">已关联文件 {{ fileId }}</p>
      <label class="field"
        >保存到<select v-model="personal" class="native-control">
          <option :value="false">项目库</option>
          <option :value="true">个人库</option>
        </select></label
      >
      <p v-if="error" class="studio-error">{{ error }}</p>
      <div class="toolbar">
        <el-button
          :disabled="readonly || busy || uploading"
          type="primary"
          native-type="submit"
        >
          {{ uploading ? '上传中' : '保存素材版本' }}
        </el-button>
        <el-button v-if="parent" native-type="button" @click="cancelVersion">
          取消派生
        </el-button>
      </div>
    </form>
    <section v-if="mode === 'library'" class="panel studio-panel">
      <h2>{{ scope === 'project' ? '已引用项目素材' : '从个人库引用' }}</h2>
      <div class="studio-toolbar">
        <select v-model="scope" class="native-control" aria-label="素材库">
          <option value="project">项目素材</option>
          <option value="personal">从个人库引用</option>
        </select>
        <select v-model="filter" class="native-control" aria-label="素材类型">
          <option value="">全部类型</option>
          <option v-for="(label, k) in assetKinds" :key="k" :value="k">
            {{ label }}
          </option>
        </select>
        <select v-model="adopted" class="native-control" aria-label="采用状态">
          <option value="">全部采用状态</option>
          <option value="yes">已采用</option>
          <option value="no">未采用</option></select
        ><select v-model="use" class="native-control" aria-label="使用镜头">
          <option value="">全部镜头</option>
          <option
            v-for="(s, i) in project.document.shots"
            :key="s.id"
            :value="s.id"
          >
            镜 {{ i + 1 }}
          </option>
        </select>
      </div>
      <div class="asset-card-grid">
        <article v-for="a in matches" :key="a.id">
          <StudioMedia
            v-if="a.fileId && auth.can('files.read')"
            :project="project.id"
            :asset="a.id"
            :kind="mediaKind(a.kind)"
            controls
            lazy
          />
          <h3>
            {{ a.name }} <small>{{ assetKinds[a.kind] }}</small>
          </h3>
          <ExpandableText :text="a.description" label="设定" :lines="3" />
          <p class="studio-meta">
            版本 {{ a.version ?? a.id.slice(0, 8) }} ·
            {{ used(a.id).length }} 个镜头引用
          </p>
          <div class="studio-actions">
            <el-button
              v-if="!project.document.assets.includes(a.id)"
              :disabled="readonly || busy"
              @click="emit('link', a.id)"
            >
              引用此版本</el-button
            ><el-button
              :disabled="
                readonly ||
                !auth.can('studio.assets.write') ||
                busy ||
                (!!a.fileId && !auth.can('files.read'))
              "
              @click="revise(a)"
              >派生版本</el-button
            ><el-button
              v-if="a.project"
              :disabled="
                readonly ||
                !auth.can('studio.assets.write') ||
                busy ||
                (!!a.fileId && !auth.can('files.read'))
              "
              @click="emit('favorite', a)"
            >
              收藏到个人库
            </el-button>
          </div>
        </article>
      </div>
      <p v-if="!matches.length">没有符合条件的素材。</p>
    </section>
  </div>
</template>
<style scoped>
.asset-card-grid {
  display: grid;
  align-items: stretch;
  gap: 10px;
  margin: 12px 0;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 180px), 1fr));
}
.asset-card-grid article {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: var(--control-gap);
  min-width: 0;
}
.asset-card-grid .studio-actions {
  margin-top: auto;
}
.asset-card-grid h3 {
  font-size: 15px;
}
.asset-card-grid h3 small {
  font-weight: 400;
  color: var(--muted-foreground);
}
</style>
