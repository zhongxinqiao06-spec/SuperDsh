<script setup lang="ts">
import { usePreferences } from '@/store/modules/preferences'
const { tr } = usePreferences()
const layers = [
  [['Web / 桌面 / 手机', 'Web / Desktop / Mobile']],
  [
    ['业务智能体', 'Business agents'],
    ['会话与成果', 'Conversations and deliverables'],
  ],
  [
    ['企业知识', 'Company knowledge'],
    ['业务技能', 'Business skills'],
    ['授权工具', 'Authorized tools'],
    ['模型能力', 'Model capabilities'],
  ],
  [
    ['身份与权限', 'Identity and permissions'],
    ['数据与存储', 'Data and storage'],
    ['执行与审计', 'Execution and audit'],
  ],
] as const
function text(value: readonly string[]) {
  return tr(value[0] ?? '', value[1] ?? '')
}
</script>
<template>
  <section id="website-architecture" class="website-section">
    <div class="eyebrow">PLATFORM ARCHITECTURE</div>
    <h2>
      {{
        tr(
          '从企业知识，到业务行动。',
          'From company knowledge to business action.',
        )
      }}
    </h2>
    <p>
      {{
        tr(
          '将资料、业务方法和执行能力连接起来，让每一次积累，都能服务下一次业务行动。',
          'Connect knowledge, methods and execution so every lesson supports the next task.',
        )
      }}
    </p>
    <figure
      class="website-architecture"
      :aria-label="
        tr(
          '星桥智能平台四层架构示意',
          'Starbridge four-layer platform architecture',
        )
      "
    >
      <div v-for="(layer, index) in layers" :key="index">
        <span v-for="item in layer" :key="item[0]">{{ text(item) }}</span>
      </div>
    </figure>
    <div class="capabilities-grid">
      <article>
        <h3>
          {{ tr('业务能力，持续沉淀', 'Reusable business capabilities') }}
        </h3>
        <p>
          {{
            tr(
              '让知识、模板与工作方法，成为可复用的企业资产。',
              'Keep knowledge, templates and methods as reusable assets.',
            )
          }}
        </p>
      </article>
      <article>
        <h3>{{ tr('执行过程，人可掌控', 'People stay in control') }}</h3>
        <p>
          {{
            tr(
              '从工具调用到关键审批，让任务过程清晰可见。',
              'Keep tool calls, approvals and progress visible.',
            )
          }}
        </p>
      </article>
      <article>
        <h3>
          {{ tr('开放连接，分步拓展', 'Open connections, gradual expansion') }}
        </h3>
        <p>
          {{
            tr(
              '围绕业务需要，逐步连接模型、工具与企业系统。',
              'Connect models, tools and enterprise systems as needed.',
            )
          }}
        </p>
      </article>
    </div>
  </section>
</template>
