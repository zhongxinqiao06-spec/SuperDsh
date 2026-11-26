<script setup lang="ts">
import { computed } from 'vue'
import CardFundingHint from '@/views/billing/components/CardFundingHint.vue'
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
import ExpandableText from '@/components/base/ExpandableText.vue'
import type { GenerationPlan } from '@/types/studio/production'
/** 逐项说明生成范围、跳过原因和用量，禁止将预检直接当成提交。 */
const open = defineModel<boolean>({ required: true })
const props = defineProps<{
  plan: GenerationPlan
  busy: boolean
  error: string
}>()
const emit = defineEmits<{ confirm: [] }>()
const selected = computed(() => props.plan.items.filter((i) => i.selected))
const items = computed(() =>
  props.plan.items.map((item) => {
    // 镜号来自预检返回的显示标签；稳定 target 仍用于提交，不按数组位置猜镜号。
    const label = /^镜\s*(\d+)\s*·\s*([\s\S]*)$/.exec(item.label)
    const kind =
      (
        { video: '镜头视频', speech: '角色配音', image: '参考画面' } as Record<
          string,
          string
        >
      )[item.kind] ?? '制作任务'
    return {
      ...item,
      title: label ? `第 ${label[1]} 镜 · ${kind}` : kind,
      description: label?.[2] ?? item.label,
    }
  }),
)
const groups = computed(() =>
  [
    {
      title: '需要处理',
      open: true,
      items: items.value.filter((item) =>
        ['blocked', 'uncertain'].includes(item.status),
      ),
    },
    {
      title: '本次提交',
      open: true,
      items: items.value.filter(
        (item) =>
          item.selected && !['blocked', 'uncertain'].includes(item.status),
      ),
    },
    {
      title: '已跳过，不重复生成',
      open: false,
      items: items.value.filter(
        (item) =>
          !item.selected && !['blocked', 'uncertain'].includes(item.status),
      ),
    },
  ].filter((group) => group.items.length),
)
const imageCount = computed(
  () => selected.value.filter((item) => item.kind === 'image').length,
)
const states: Record<string, string> = {
  missing: '尚未制作',
  outdated: '输入已变更',
  failed: '生成失败',
  active: '正在制作，跳过',
  ready: '已有候选，跳过',
  uncertain: '受理待核对',
  recoverable: '可恢复原回执，跳过',
  blocked: '检查未通过',
}
</script>
<template>
  <ManagementDialog
    v-model="open"
    title="制作前检查"
    :busy="busy"
    :error="error"
    :submit-disabled="!!plan.issues.length || !selected.length"
    :submit-text="
      plan.usageQuote
        ? `确认用量并提交 · ${plan.usageQuote.totalPoints} 点`
        : '确认用量并提交'
    "
    @submit="emit('confirm')"
  >
    <div class="stack">
      <p>
        本次生成：{{
          selected.filter((i) => i.kind === 'video').length
        }}
        个镜头视频、{{
          selected.filter((i) => i.kind === 'speech').length
        }}
        句配音<template v-if="imageCount"
          >、{{ imageCount }} 张新增参考画面</template
        >。
      </p>
      <section
        v-if="plan.usageQuote"
        class="panel studio-panel form-stack"
        aria-label="本次报价"
      >
        <strong>本次上限 {{ plan.usageQuote.totalPoints }} 点</strong
        ><span v-for="(line, i) in plan.usageQuote.items" :key="i"
          >{{ selected[i]?.label }} · {{ line.spec }} · {{ line.quantity }}
          {{
            { second: '秒', character: '字', image: '张', call: '次' }[
              line.unit
            ]
          }}
          · {{ line.payer === 'personal' ? '本人凭据' : '平台模型' }} ·
          {{ line.points }} 点</span
        ><small
          >报价有效至
          {{
            new Date(plan.usageQuote.expiresAt).toLocaleTimeString()
          }}，确认后按此价格预留创作点。</small
        >
        <CardFundingHint :points="plan.usageQuote.totalPoints" />
      </section>
      <p v-else class="studio-meta">
        视频共
        {{ selected.reduce((n, i) => n + (i.seconds ?? 0), 0) }} 秒，配音共
        {{ selected.reduce((n, i) => n + (i.characters ?? 0), 0) }}
        字。费用按供应商实际用量结算；本页检查不会调用生成模型。
      </p>
      <el-alert
        v-for="issue in plan.issues"
        :key="issue.target + issue.message"
        type="error"
        :closable="false"
        :title="
          (items.find((item) => item.target === issue.target)?.title ||
            '制作范围') +
          '：' +
          issue.message
        "
      />
      <p v-if="!selected.length">
        当前范围没有需要新生成的内容。已有候选请审看采用；执行中和待核对任务请到任务记录处理。
      </p>
      <details
        v-for="group in groups"
        :key="group.title"
        :open="group.open"
        class="production-check-group"
      >
        <summary>{{ group.title }} · {{ group.items.length }}</summary>
        <article
          v-for="item in group.items"
          :key="item.kind + item.target"
          class="panel studio-panel form-stack"
        >
          <div class="toolbar">
            <strong>{{ item.title }}</strong
            ><el-tag :type="item.selected ? 'warning' : 'info'">{{
              item.selected ? '本次提交' : '不重复提交'
            }}</el-tag>
          </div>
          <ExpandableText
            :text="item.description"
            :label="item.kind === 'speech' ? '台词' : '镜头要求'"
            :lines="3"
          />
          <span
            >{{ states[item.status] ?? item.status
            }}<template v-if="item.message">
              · {{ item.message }}</template
            ></span
          >
          <small v-if="item.model || item.references !== undefined"
            >{{ item.model
            }}<template v-if="item.seconds"> · {{ item.seconds }} 秒</template
            ><template v-if="item.voice"> · 音色 {{ item.voice }}</template
            ><template
              v-if="
                (item.kind === 'video' || item.kind === 'image') &&
                item.references !== undefined
              "
            >
              · 输入参考图 {{ item.references }} 张</template
            ></small
          >
        </article>
      </details>
    </div>
  </ManagementDialog>
</template>

<style scoped>
.production-check-group > summary {
  font-weight: 600;
  cursor: pointer;
  padding-block: var(--control-gap);
}
</style>
