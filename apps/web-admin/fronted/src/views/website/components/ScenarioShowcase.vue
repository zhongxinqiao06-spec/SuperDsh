<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { websiteScenarios } from '@/utils/website/content'
import { usePreferences } from '@/store/modules/preferences'
const { tr } = usePreferences(),
  active = ref(0),
  slide = ref(0),
  tabs = ref<HTMLButtonElement[]>([])
const scenario = computed(
  () => websiteScenarios[active.value] ?? websiteScenarios[0],
)
async function keyboard(event: KeyboardEvent) {
  const next =
    event.key === 'ArrowRight'
      ? (active.value + 1) % 3
      : event.key === 'ArrowLeft'
        ? (active.value + 2) % 3
        : event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? 2
            : null
  if (next !== null) {
    event.preventDefault()
    active.value = next
    await nextTick()
    tabs.value[next]?.focus()
  }
}
const slides = [
  [
    '每一份积累，都在连接下一次增长。',
    'Every insight connects to the next opportunity.',
  ],
  ['把数据看清，让行动更有方向。', 'Clear data gives action direction.'],
  [
    '聚焦关键区域，延续有效的工作方法。',
    'Focus on key regions and proven practices.',
  ],
] as const
function text(value: readonly string[]) {
  return tr(value[0] ?? '', value[1] ?? '')
}
</script>
<template>
  <section id="website-scenarios" class="website-section">
    <div class="eyebrow">FROM A TASK TO AN OUTCOME</div>
    <h2>
      {{
        tr(
          '交给 AI 一个任务，带回一份真正的成果。',
          'Give AI a task. Bring back a deliverable.',
        )
      }}
    </h2>
    <div
      class="website-tabs"
      role="tablist"
      :aria-label="tr('业务应用场景', 'Business scenarios')"
    >
      <button
        v-for="(item, index) in websiteScenarios"
        :id="`scenario-tab-${index}`"
        :key="index"
        ref="tabs"
        role="tab"
        :aria-selected="active === index"
        aria-controls="website-scenario-panel"
        :tabindex="active === index ? 0 : -1"
        @click="active = index"
        @keydown="keyboard"
      >
        {{ text(item.name) }}
      </button>
    </div>
    <div
      id="website-scenario-panel"
      role="tabpanel"
      :aria-labelledby="`scenario-tab-${active}`"
      tabindex="0"
      class="website-scenario"
    >
      <article>
        <h3>{{ text(scenario.title) }}</h3>
        <p>{{ text(scenario.text) }}</p>
        <ul>
          <li v-for="step in scenario.steps" :key="step[0]">
            {{ text(step) }}
          </li>
        </ul>
        <router-link to="/login"
          >{{ tr('在工作台开始', 'Start in the workspace') }} ↗</router-link
        >
      </article>
      <div class="website-demo">
        <span class="muted">{{
          tr(
            '场景示意 · 虚构业务数据',
            'Illustration · fictional business data',
          )
        }}</span
        ><template v-if="active === 0"
          ><h3>
            {{
              tr(
                '星河商贸 · 季度经营概览',
                'Example company · Quarterly performance',
              )
            }}
          </h3>
          <strong class="website-demo-number">¥1,286,000.00</strong>
          <div class="website-sales-bars">
            <div v-for="(value, index) in [38.6, 41.6, 48.4]" :key="value">
              <span>{{ value }}</span
              ><i :style="{ height: `${value * 2}px` }" /><span
                >{{ index + 7 }}{{ tr('月', ' month') }}</span
              >
            </div>
          </div>
          <a href="/images/website/sales-example.csv" download
            >{{ tr('下载示例数据', 'Download example data') }} ↓</a
          ></template
        ><template v-else-if="active === 1"
          ><div class="website-slide">
            <small>0{{ slide + 1 }} / 03</small>
            <h3>{{ text(slides[slide] ?? slides[0]) }}</h3>
            <p>
              {{
                tr(
                  '星河商贸 · 第三季度经营汇报',
                  'Example company · Third-quarter business review',
                )
              }}
            </p>
          </div>
          <div class="website-tabs">
            <button
              :aria-label="tr('上一页', 'Previous slide')"
              @click="slide = (slide + 2) % 3"
            >
              ←</button
            ><span>{{ slide + 1 }} / 3</span
            ><button
              :aria-label="tr('下一页', 'Next slide')"
              @click="slide = (slide + 1) % 3"
            >
              →
            </button>
          </div></template
        ><template v-else
          ><h3>
            {{ tr('差旅费用如何报销？', 'How do travel reimbursements work?') }}
          </h3>
          <p>
            {{
              tr(
                '请按差旅制度提交行程、发票与审批记录。超出标准的费用需要额外审批。',
                'Submit your itinerary, receipts and approval records according to the travel policy. Expenses over the limit require additional approval.',
              )
            }}
          </p>
          <details>
            <summary>{{ tr('查看资料来源', 'View source') }}</summary>
            <p>
              {{
                tr(
                  '差旅报销制度.pdf · 第3节（虚构示例）',
                  'Travel policy.pdf · Section 3 (fictional example)',
                )
              }}
            </p>
          </details></template
        >
      </div>
    </div>
  </section>
</template>
