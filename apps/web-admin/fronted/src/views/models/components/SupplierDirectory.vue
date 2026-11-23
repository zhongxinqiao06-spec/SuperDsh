<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue'
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
import { checkKeyTransport, modelsApi } from '@/api/models/models-api'
import { passwordProof } from '@/api/auth/auth-api'
import { useAuthStore } from '@/store/modules/auth-store'
import { errorMessage } from '@/utils/errors'
import type {
  ModelConfiguration,
  ModelConnection,
  SupplierInspection,
} from '@/types/models/models'

/** 仅在管理员主动查询时读取上游，明文密钥随弹层关闭或切换账号立即清除。 */
const props = defineProps<{
  connections: ModelConnection[]
  configurations: ModelConfiguration[]
}>()
const emit = defineEmits<{
  edit: [value: ModelConnection | 'new']
  addModel: [connection: string, model: string]
}>()
const auth = useAuthStore()
const selected = ref('')
const row = computed(() =>
  props.connections.find((c) => c.id === selected.value),
)
const isAliyunPlan = computed(
  () =>
    row.value &&
    new URL(row.value.baseUrl).origin ===
      'https://token-plan.cn-beijing.maas.aliyuncs.com',
)
const percent = new Intl.NumberFormat('zh-CN', {
  style: 'percent',
  maximumFractionDigits: 2,
})
const beijingTime = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})
const configured = computed(() =>
  props.configurations.filter((c) => c.connectionId === selected.value),
)
const inspection = ref<SupplierInspection>(),
  mode = ref<'detail' | 'key'>('detail')
const password = ref(''),
  key = ref(''),
  error = ref(''),
  busy = ref(false)
let pending: AbortController | undefined,
  hideTimer: ReturnType<typeof setTimeout> | undefined
function clear() {
  pending?.abort()
  pending = undefined
  clearTimeout(hideTimer)
  key.value = ''
  password.value = ''
  inspection.value = undefined
  error.value = ''
  busy.value = false
}
function close() {
  selected.value = ''
  clear()
}
watch(() => auth.generation, close, { flush: 'sync' })
onScopeDispose(clear)
function open(c: ModelConnection, next: 'detail' | 'key') {
  clear()
  selected.value = c.id
  mode.value = next
}
function provider(c: ModelConnection) {
  const url = new URL(c.baseUrl)
  if (url.hostname === 'api.deepseek.com')
    return {
      plan: '按量计费',
      unit: '',
      docs: 'https://api-docs.deepseek.com/api/get-user-balance/',
      note: '余额支持实时查询。',
    }
  if (url.hostname === 'token-plan.cn-beijing.maas.aliyuncs.com')
    return {
      plan: 'Token Plan',
      unit: 'Credits',
      docs: 'https://help.aliyun.com/zh/model-studio/token-plan-usage-quota',
      note: '',
    }
  if (
    url.hostname === 'ark.cn-beijing.volces.com' &&
    url.pathname.startsWith('/api/plan/')
  )
    return {
      plan: 'Agent Plan',
      unit: 'AFP',
      docs: 'https://docs.volcengine.com/docs/ark/get-afp-usage-api?lang=zh',
      note: '官方额度查询使用独立的云账号 Access Key，当前连接使用模型 API Key。',
    }
  return { plan: '未登记套餐', unit: '', docs: '', note: '' }
}
async function query() {
  if (!row.value || busy.value) return
  const controller = new AbortController(),
    id = row.value.id
  pending = controller
  busy.value = true
  error.value = ''
  try {
    if (mode.value === 'key') {
      checkKeyTransport()
      const proof = await passwordProof(
        auth.session?.username ?? auth.session?.email ?? '',
        password.value,
        controller.signal,
      )
      password.value = ''
      const result = await modelsApi.revealKey(id, proof, controller.signal)
      if (!controller.signal.aborted) {
        key.value = result.apiKey
        hideTimer = setTimeout(close, 45000)
      }
    } else {
      const result = await modelsApi.inspectConnection(id, controller.signal)
      if (!controller.signal.aborted) inspection.value = result
    }
  } catch (e) {
    if (!controller.signal.aborted) error.value = errorMessage(e)
  } finally {
    if (!controller.signal.aborted) {
      busy.value = false
      password.value = ''
    }
  }
}
function add(id: string, model: string) {
  close()
  emit('addModel', id, model)
}
</script>
<template>
  <section class="supplier-directory" aria-label="平台供应商">
    <div class="toolbar">
      <h2>平台供应商</h2>
      <el-button @click="emit('edit', 'new')">新增连接</el-button>
    </div>
    <div class="supplier-grid">
      <article v-for="c in connections" :key="c.id" class="supplier-card">
        <div class="supplier-title">
          <h3>{{ c.name }}</h3>
          <el-tag size="small" :type="c.enabled ? 'success' : 'info'">{{
            c.enabled ? '启用' : '停用'
          }}</el-tag>
        </div>
        <div class="supplier-facts">
          <span>{{ c.subscription?.plan || provider(c).plan }}</span
          ><span
            >{{
              configurations.filter((m) => m.connectionId === c.id).length
            }}
            项模型配置</span
          ><span>{{
            c.credentialConfigured ? 'Key 已配置' : '待配置 Key'
          }}</span>
          <span v-if="c.subscription?.remaining != null"
            >登记剩余 {{ c.subscription.remaining }}
            {{ c.subscription.unit }}</span
          >
        </div>
        <div class="supplier-actions">
          <el-button link type="primary" @click="open(c, 'detail')"
            >套餐、额度与模型</el-button
          ><el-button link @click="emit('edit', c)">编辑连接</el-button
          ><el-button
            v-if="
              c.credentialConfigured && auth.session?.roles.includes('admin')
            "
            link
            @click="open(c, 'key')"
            >查看 Key</el-button
          >
        </div>
      </article>
    </div>
  </section>
  <ManagementDialog
    :model-value="Boolean(row)"
    :title="
      (row?.name ?? '') + (mode === 'key' ? ' · 查看 API Key' : ' · 供应商详情')
    "
    readonly
    :error="error"
    @update:model-value="!$event && close()"
  >
    <template v-if="row && mode === 'key'">
      <template v-if="key"
        ><label class="field"
          >当前 API Key<input
            class="native-control"
            readonly
            :value="key"
            autocomplete="off"
            spellcheck="false" /></label
        ><small>45 秒后自动关闭。</small></template
      >
      <template v-else
        ><label class="field"
          >当前管理员账号密码<el-input
            v-model="password"
            type="password"
            autocomplete="current-password"
            @keydown.enter.prevent="password && query()"
        /></label>
        <div>
          <el-button
            type="primary"
            :loading="busy"
            :disabled="!password"
            @click="query"
            >确认并查看</el-button
          >
        </div></template
      >
    </template>
    <template v-else-if="row">
      <div class="supplier-title">
        <h3>{{ row.subscription?.plan || provider(row).plan }}</h3>
        <a
          v-if="provider(row).docs"
          :href="provider(row).docs"
          target="_blank"
          rel="noopener noreferrer"
          >官方说明 ↗</a
        >
      </div>
      <section
        v-if="isAliyunPlan"
        class="personal-usage"
        aria-label="Token Plan 用量"
      >
        <div class="supplier-title">
          <h3>
            {{
              inspection?.personalUsage ? '个人版月度用量' : 'Token Plan 用量'
            }}
          </h3>
          <a
            href="https://bailian.console.aliyun.com/cn-beijing/subscription/token-plan"
            title="在百炼查看剩余 Credits"
            target="_blank"
            rel="noopener noreferrer"
            >我的订阅<span aria-hidden="true"> ↗</span></a
          >
        </div>
        <dl v-if="inspection?.personalUsage" class="supplier-quota">
          <div>
            <dt>本月已用</dt>
            <dd>
              {{
                inspection.personalUsage.usedRatio == null
                  ? '暂无数据'
                  : percent.format(inspection.personalUsage.usedRatio)
              }}
            </dd>
            <progress
              v-if="inspection.personalUsage.usedRatio != null"
              max="1"
              :value="inspection.personalUsage.usedRatio"
              aria-label="本月已用比例"
            />
          </div>
          <div>
            <dt>重置时间（北京时间）</dt>
            <dd>
              {{
                inspection.personalUsage.resetAtMs == null
                  ? '暂无数据'
                  : beijingTime.format(inspection.personalUsage.resetAtMs)
              }}
            </dd>
          </div>
        </dl>
        <p v-if="inspection?.quotaError" role="status">
          {{ inspection.quotaError }}
        </p>
        <div class="supplier-title">
          <el-button :loading="busy" @click="query">查询上游</el-button>
          <small v-if="inspection"
            >更新于
            {{
              beijingTime.format(new Date(inspection.checkedAt))
            }}（北京时间）</small
          >
        </div>
      </section>
      <dl class="supplier-quota">
        <div>
          <dt>套餐总额度 · 人工登记</dt>
          <dd>
            {{ row.subscription?.quota ?? '未登记' }}
            {{ row.subscription?.unit || provider(row).unit }}
          </dd>
        </div>
        <div>
          <dt>剩余额度 · 人工登记</dt>
          <dd>
            {{ row.subscription?.remaining ?? '未登记' }}
            {{ row.subscription?.unit || provider(row).unit }}
          </dd>
        </div>
      </dl>
      <p v-if="provider(row).note">{{ provider(row).note }}</p>
      <div class="toolbar">
        <h3>已配置模型</h3>
        <el-button link @click="add(row.id, '')">添加模型配置</el-button>
      </div>
      <ul v-if="configured.length" class="supplier-models">
        <li v-for="m in configured" :key="m.id">
          <span>{{ m.name }} · {{ m.modelId }}</span
          ><small>{{ m.enabled ? '启用' : '停用' }}</small>
        </li>
      </ul>
      <p v-else>尚未配置模型。</p>
      <div class="toolbar">
        <h3>供应商实时数据</h3>
        <el-button v-if="!isAliyunPlan" :loading="busy" @click="query"
          >查询上游</el-button
        >
      </div>
      <template v-if="inspection"
        ><small v-if="!isAliyunPlan"
          >查询时间 {{ new Date(inspection.checkedAt).toLocaleString() }}</small
        >
        <p v-for="b in inspection.balances" :key="b.currency">
          账户可用余额 {{ b.amount }} {{ b.currency }}
        </p>
        <p v-if="inspection.balanceError">
          余额查询：{{ inspection.balanceError }}
        </p>
        <dl v-if="inspection.quotaItems?.length" class="supplier-quota">
          <div v-for="item in inspection.quotaItems" :key="item.type">
            <dt>{{ item.type }} 席位 · 剩余 / 总额度</dt>
            <dd>
              {{ item.remaining.toLocaleString() }} /
              {{ item.quota.toLocaleString() }} Credits
            </dd>
          </div>
        </dl>
        <p v-if="!isAliyunPlan && inspection.quotaError">
          {{ inspection.quotaError }}
        </p>
        <p v-if="inspection.modelError">
          模型目录：{{ inspection.modelError }}
        </p>
        <ul v-else class="supplier-models">
          <li v-for="id in inspection.models" :key="id">
            <span>{{ id }}</span
            ><el-button link @click="add(row.id, id)">配置</el-button>
          </li>
        </ul>
        <p v-if="!inspection.modelError && !inspection.models.length">
          此 Key 的上游目录为空。
        </p>
      </template>
    </template>
  </ManagementDialog>
</template>
<style scoped>
.supplier-directory {
  display: grid;
  gap: var(--space-3, 12px);
}
.personal-usage {
  display: grid;
  gap: var(--space-3, 12px);
  border-block: 1px solid var(--border);
  padding-block: var(--space-4, 16px);
}
.personal-usage h3,
.personal-usage p {
  margin: 0;
}
.personal-usage progress {
  width: 100%;
  height: 6px;
  accent-color: var(--el-color-primary);
}
.supplier-directory h2,
.supplier-title h3,
.toolbar h3,
.supplier-quota,
.supplier-quota dd {
  margin: 0;
}
.supplier-directory h2,
.supplier-title h3,
.toolbar h3 {
  font-size: 1rem;
}
.supplier-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr));
  gap: var(--space-3, 12px);
}
.supplier-card,
.supplier-quota > div {
  min-width: 0;
  border: 1px solid var(--border);
  background: var(--el-bg-color);
  border-radius: var(--el-border-radius-base);
  padding: var(--space-4, 16px);
}
.supplier-card {
  display: grid;
  gap: var(--space-3, 12px);
}
.supplier-title,
.supplier-actions,
.supplier-facts,
.supplier-models li {
  display: flex;
  align-items: center;
  gap: var(--space-2, 8px);
  flex-wrap: wrap;
  overflow-wrap: anywhere;
}
.supplier-title,
.supplier-models li {
  justify-content: space-between;
}
.supplier-facts,
.supplier-quota dt,
.supplier-models small {
  color: var(--muted-foreground);
  font-size: 0.85rem;
}
.supplier-actions .el-button {
  margin: 0;
}
.supplier-quota {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 175px), 1fr));
  gap: var(--space-2, 8px);
}
.supplier-quota dd {
  font-weight: 600;
  margin-top: var(--space-2, 8px);
}
.supplier-models {
  list-style: none;
  padding: 0;
  margin: 0;
}
.supplier-models li {
  padding-block: var(--space-2, 8px);
  border-bottom: 1px solid var(--border);
}
@media (max-width: 700px) {
  .supplier-grid {
    grid-auto-flow: column;
    grid-template-columns: none;
    grid-auto-columns: min(86%, 320px);
    overflow-x: auto;
    scroll-snap-type: x proximity;
  }
  .supplier-card {
    scroll-snap-align: start;
  }
}
</style>
