<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref } from 'vue'
import BailianAuthorization from './BailianAuthorization.vue'
import AppIcon from '@/components/base/AppIcon.vue'
import { modelsApi } from '@/api/models/models-api'
import { useAuthStore } from '@/store/modules/auth-store'
import {
  adapterNames,
  supplierPlan,
} from '@/utils/models/supplier-presentation'
import { errorMessage } from '@/utils/errors'
import type {
  ModelConfiguration,
  ModelConnection,
  SupplierInspection,
} from '@/types/models/models'

/** 只读详情直接使用已载入的目录；上游额度及模型仅按管理员操作查询。 */
const props = defineProps<{
  row: ModelConnection
  configurations: ModelConfiguration[]
}>()
const emit = defineEmits<{
  edit: []
  reveal: []
  back: []
  addModel: [model: string]
}>()
const auth = useAuthStore()
const heading = ref<HTMLElement>()
onMounted(() => heading.value?.focus({ preventScroll: true }))
const planInfo = computed(() => supplierPlan(props.row))
const plan = computed(() => props.row.subscription?.plan || planInfo.value.plan)
const configured = computed(() =>
  props.configurations.filter((c) => c.connectionId === props.row.id),
)
const isAliyunPlan = computed(
  () =>
    new URL(props.row.baseUrl).origin ===
    'https://token-plan.cn-beijing.maas.aliyuncs.com',
)
const inspection = ref<SupplierInspection>()
const usage = computed(() => inspection.value?.personalUsage)
const authorizationOpen = ref(false),
  busy = ref(false),
  error = ref('')
const controller = new AbortController()
onScopeDispose(() => controller.abort())
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

async function query() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  if (isAliyunPlan.value) inspection.value = undefined
  try {
    const result = await modelsApi.inspectConnection(
      props.row.id,
      controller.signal,
    )
    if (!controller.signal.aborted) inspection.value = result
  } catch (e) {
    if (!controller.signal.aborted) error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}
function toggleAuthorization() {
  authorizationOpen.value = !authorizationOpen.value
  if (authorizationOpen.value && !inspection.value) void query()
}
</script>
<template>
  <header class="detail-masthead">
    <el-button link class="detail-back" @click="emit('back')"
      ><AppIcon name="arrow-left" :size="16" />返回供应商列表</el-button
    >
    <div class="detail-masthead-row">
      <div class="detail-identity">
        <h1 ref="heading" tabindex="-1">{{ row.name }}</h1>
        <span class="status-badge" :class="{ 'is-active': row.enabled }">{{
          row.enabled ? '已启用' : '已停用'
        }}</span>
      </div>
      <el-button type="primary" @click="emit('edit')"
        ><AppIcon name="settings" :size="16" />编辑连接</el-button
      >
    </div>
  </header>
  <div class="detail-spread">
    <section class="detail-section">
      <h2>连接信息</h2>
      <dl class="details">
        <dt>连接名称</dt>
        <dd>{{ row.name }}</dd>
        <dt>适配器</dt>
        <dd>{{ adapterNames[row.adapter] || row.adapter }}</dd>
        <dt>区域</dt>
        <dd>{{ row.region || '未登记' }}</dd>
        <dt>访问凭据</dt>
        <dd class="detail-action-value">
          <span
            ><span
              v-if="row.credentialConfigured"
              class="credential-mask"
              aria-hidden="true"
              >••••••••</span
            >{{ row.credentialConfigured ? '已配置' : '未配置' }}</span
          ><el-button
            v-if="
              row.credentialConfigured && auth.session?.roles.includes('admin')
            "
            link
            type="primary"
            @click="emit('reveal')"
            >查看 Key</el-button
          >
        </dd>
      </dl>
    </section>
    <section class="detail-section">
      <h2>套餐用量</h2>
      <section
        v-if="isAliyunPlan"
        class="personal-usage"
        aria-label="Token Plan 用量"
        :aria-busy="busy"
      >
        <strong class="detail-plan">{{ plan }}</strong>
        <dl v-if="usage" class="usage-metrics">
          <div>
            <dt>本月已用</dt>
            <dd :class="{ 'usage-value': usage.usedRatio != null }">
              {{
                usage.usedRatio == null
                  ? '暂无数据'
                  : percent.format(usage.usedRatio)
              }}
            </dd>
            <progress
              v-if="usage.usedRatio != null"
              max="1"
              :value="usage.usedRatio"
              aria-label="本月已用比例"
            />
            <div
              v-if="usage.usedRatio != null"
              class="meter-scale"
              aria-hidden="true"
            >
              <span>0%</span><span>50%</span><span>100%</span>
            </div>
          </div>
          <div>
            <dt>重置时间（北京时间）</dt>
            <dd>
              {{
                usage.resetAtMs == null
                  ? '暂无数据'
                  : beijingTime.format(usage.resetAtMs)
              }}
            </dd>
          </div>
        </dl>
        <div class="detail-action-value">
          <a
            href="https://bailian.console.aliyun.com/cn-beijing/subscription/token-plan/personal"
            title="在百炼查看剩余 Credits"
            target="_blank"
            rel="noopener noreferrer"
            >我的订阅<span aria-hidden="true"> ↗</span></a
          >
        </div>
        <div
          v-if="!inspection || inspection.cliRamAccount"
          class="usage-account"
        >
          <span v-if="inspection?.cliRamAccount"
            >百炼 CLI · RAM 账号
            <strong>{{ inspection.cliRamAccount.name }}</strong></span
          >
          <el-tag
            v-if="inspection?.cliRamAccount"
            disable-transitions
            size="small"
            :type="inspection.cliRamAccount.verified ? 'success' : 'info'"
            >{{
              inspection.cliRamAccount.verified ? '身份已核验' : '身份待核验'
            }}</el-tag
          >
          <el-button
            v-if="auth.session?.roles.includes('admin')"
            size="small"
            plain
            type="primary"
            :aria-expanded="authorizationOpen"
            @click="toggleAuthorization"
            >{{
              authorizationOpen
                ? '收起授权步骤'
                : inspection?.cliRamAccount?.verified
                  ? '重新授权百炼账号'
                  : '授权百炼账号'
            }}</el-button
          >
        </div>
        <small v-else-if="usage" class="usage-meta"
          >百炼 · AccessKey 查询</small
        >
        <p
          v-if="authorizationOpen && inspection && !inspection.cliRamAccount"
          class="usage-note"
          role="status"
        >
          此连接尚未绑定用于个人订阅查询的 RAM 账号。
        </p>
        <BailianAuthorization
          v-if="
            authorizationOpen &&
            (!inspection || inspection.cliRamAccount) &&
            auth.session?.roles.includes('admin')
          "
          :account="inspection?.cliRamAccount"
          :busy="busy"
          @verify="query"
        />
        <p v-if="inspection?.quotaError" class="usage-note" role="status">
          {{ inspection.quotaError }}
        </p>
        <div class="detail-action-value">
          <el-button :loading="busy" @click="query">查询上游</el-button>
          <small v-if="inspection" class="usage-meta"
            >本次查询
            {{
              beijingTime.format(new Date(inspection.checkedAt))
            }}（北京时间）</small
          >
          <small v-else class="usage-meta" role="status">{{
            busy ? '正在查询百炼…' : error ? '本次查询失败' : '尚未查询'
          }}</small>
        </div>
      </section>

      <strong v-else class="detail-plan">{{ plan }}</strong>
      <details class="detail-disclosure" :open="!isAliyunPlan">
        <summary>人工登记额度</summary>
        <dl class="detail-facts">
          <div>
            <dt>套餐总额度 · 人工登记</dt>
            <dd>
              {{ row.subscription?.quota ?? '未登记' }}
              {{ row.subscription?.unit || planInfo.unit }}
            </dd>
          </div>
          <div>
            <dt>剩余额度 · 人工登记</dt>
            <dd>
              {{ row.subscription?.remaining ?? '未登记' }}
              {{ row.subscription?.unit || planInfo.unit }}
            </dd>
          </div>
        </dl>
      </details>
      <p v-if="planInfo.note" class="muted">{{ planInfo.note }}</p>
      <a
        v-if="planInfo.docs"
        :href="planInfo.docs"
        target="_blank"
        rel="noopener noreferrer"
        class="detail-docs"
        >官方说明 ↗</a
      >
    </section>
  </div>
  <el-alert
    v-if="error"
    :title="error"
    type="error"
    :closable="false"
    show-icon
  />
  <section class="detail-section detail-models">
    <div class="detail-section-heading">
      <h2>已配置模型</h2>
      <el-button link @click="emit('addModel', '')">添加模型配置</el-button>
    </div>
    <ul v-if="configured.length" class="detail-records">
      <li v-for="m in configured" :key="m.id">
        <span>{{ m.name }} · {{ m.modelId }}</span
        ><small>{{ m.enabled ? '启用' : '停用' }}</small>
      </li>
    </ul>
    <p v-else>尚未配置模型。</p>
  </section>
  <section class="detail-section detail-models">
    <div class="detail-section-heading">
      <h2>供应商实时数据</h2>
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
      <dl v-if="inspection.quotaItems?.length" class="detail-facts">
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
      <p v-if="inspection.modelError">模型目录：{{ inspection.modelError }}</p>
      <ul v-else class="detail-records">
        <li v-for="id in inspection.models" :key="id">
          <span>{{ id }}</span
          ><el-button link @click="emit('addModel', id)">配置</el-button>
        </li>
      </ul>
      <p v-if="!inspection.modelError && !inspection.models.length">
        此 Key 的上游目录为空。
      </p>
    </template>
  </section>
</template>
