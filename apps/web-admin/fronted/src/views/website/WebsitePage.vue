<script setup lang="ts">
import { usePreferences } from '@/store/modules/preferences'
import { ref } from 'vue'
import { websiteFaqs } from '@/utils/website/content'
import ScenarioShowcase from '@/views/website/components/ScenarioShowcase.vue'
import ProductShowcase from '@/views/website/components/ProductShowcase.vue'
import WebsiteArchitecture from '@/views/website/components/WebsiteArchitecture.vue'
/** 官网展示与业务执行分离；锚点滚动不覆盖应用的 Hash 路由。 */
const preferences = usePreferences(),
  { tr } = preferences,
  menuOpen = ref(false)
const links = [
  ['website-capabilities', '产品能力', 'Capabilities'],
  ['website-scenarios', '应用场景', 'Scenarios'],
  ['website-architecture', '平台架构', 'Architecture'],
  ['website-connected', '多端体验', 'Connected'],
  ['website-faq', '常见问题', 'FAQ'],
] as const
function scroll(id: string) {
  menuOpen.value = false
  document.getElementById(id)?.scrollIntoView({
    behavior: matchMedia('(prefers-reduced-motion: reduce)').matches
      ? 'instant'
      : 'smooth',
    block: 'start',
  })
}
const capabilities = [
  [
    '01',
    '你的知识，有据可循',
    'Knowledge with sources',
    '集中维护制度、产品资料和业务文档。回答附上来源，方便团队核对与持续补充。',
    'Maintain documents and verify answers against their sources.',
  ],
  [
    '02',
    '你的方法，反复复用',
    'Methods you can reuse',
    '把分析口径、操作步骤和审核规则沉淀为技能，让团队复用验证过的方法。',
    'Turn proven methods and review rules into reusable skills.',
  ],
  [
    '03',
    '你的标准，落在成果里',
    'Standards in every deliverable',
    '结合企业模板生成可编辑的 Excel 与 PPT，让结论成为可检查、可修改的工作文件。',
    'Create editable documents from your templates and check the results.',
  ],
  [
    '04',
    '你的智能体，为业务而生',
    'Agents built for your work',
    '组合模型、资料、技能和授权工具，配置经营分析、汇报等专属助手。',
    'Combine models, knowledge, skills and authorized tools.',
  ],
] as const
</script>

<template>
  <div class="website">
    <a
      class="skip-link"
      href="#website-main"
      @click.prevent="scroll('website-main')"
      >{{ tr('跳至主要内容', 'Skip to main content') }}</a
    >
    <header class="website-header" @keydown.esc="menuOpen = false">
      <a href="#/" class="website-logo">✦ 星桥<span>STARBRIDGE</span></a>
      <button
        class="website-menu-toggle"
        :aria-expanded="menuOpen"
        aria-controls="website-navigation"
        :aria-label="tr('打开导航', 'Open navigation')"
        @click="menuOpen = !menuOpen"
      >
        ☰
      </button>
      <nav
        id="website-navigation"
        :class="{ 'is-open': menuOpen }"
        :aria-label="tr('官网导航', 'Website navigation')"
      >
        <a
          v-for="[id, zh, en] in links"
          :key="id"
          :href="`#${id}`"
          @click.prevent="scroll(id)"
          >{{ tr(zh, en) }}</a
        >
        <button
          class="website-language"
          @click="
            preferences.locale = preferences.locale === 'zh-CN' ? 'en' : 'zh-CN'
          "
        >
          {{ preferences.locale === 'zh-CN' ? 'English' : '中文' }}
        </button>
        <router-link to="/login" class="website-cta"
          >{{ tr('进入工作台', 'Open workspace') }} ↗</router-link
        >
      </nav>
    </header>
    <main id="website-main" tabindex="-1">
      <section class="website-hero">
        <img
          src="/images/website/starbridge-hero.webp"
          alt="由青柠色光束与深色金属构成的星桥，连接企业知识与业务行动"
          class="hero-art"
        />
        <div class="hero-copy">
          <div class="eyebrow">
            ● {{ tr('企业自己的 AI 工作平台', 'Your team’s AI workspace') }}
          </div>
          <h1>
            {{ tr('让企业经验，', 'Turn experience') }}<br />{{
              tr('成为团队的', 'into your team’s')
            }}<br /><em>{{ tr('AI 能力。', 'AI capability.') }}</em>
          </h1>
          <p>
            {{
              tr(
                '把资料、模板和业务方法，变成专属智能体。',
                'Turn knowledge, templates and methods into your own agents.',
              )
            }}
          </p>
          <router-link to="/login" class="website-cta hero-button"
            >{{ tr('进入工作台', 'Open workspace') }} ↗</router-link
          >
        </div>
        <div class="hero-footnote">KNOWLEDGE · SKILLS · TOOLS · AGENTS</div>
      </section>
      <ScenarioShowcase />
      <section class="website-section website-section-light">
        <div class="eyebrow">MAKE EXPERTISE REPEATABLE</div>
        <h2>
          {{
            tr(
              '四步，把企业经验交给 AI。',
              'Four steps to put experience to work.',
            )
          }}
        </h2>
        <div class="capabilities-grid">
          <article
            v-for="(item, index) in [
              [
                '带入企业资产',
                'Bring your assets',
                '上传资料、业务规则与办公模板',
                'Upload knowledge, rules and templates',
              ],
              [
                '组合业务能力',
                'Compose capabilities',
                '选择模型、技能及允许使用的工具',
                'Choose models, skills and authorized tools',
              ],
              [
                '试用并发布',
                'Try and publish',
                '验证过程与成果，固定配置版本',
                'Validate outcomes and publish a configuration',
              ],
              [
                '在工作中复用',
                'Reuse at work',
                '员工发起任务，经验持续沉淀',
                'Apply proven methods to everyday tasks',
              ],
            ]"
            :key="index"
          >
            <span>0{{ index + 1 }}</span>
            <h3>{{ tr(item[0] ?? '', item[1] ?? '') }}</h3>
            <p>{{ tr(item[2] ?? '', item[3] ?? '') }}</p>
          </article>
        </div>
      </section>
      <WebsiteArchitecture />
      <ProductShowcase />
      <section id="website-faq" class="website-section">
        <div class="eyebrow">A LITTLE MORE CLARITY</div>
        <h2>{{ tr('你可能还想了解', 'A little more clarity') }}</h2>
        <details v-for="faq in websiteFaqs" :key="faq[0]" class="website-faq">
          <summary>{{ tr(faq[0], faq[1]) }}</summary>
          <p>{{ tr(faq[2], faq[3]) }}</p>
        </details>
      </section>
      <section class="website-section website-section-light">
        <div class="eyebrow">BUILD YOUR NEXT WAY OF WORKING</div>
        <h2>
          {{
            tr(
              '你的企业，值得拥有自己的 AI。',
              'Your company deserves its own AI.',
            )
          }}
        </h2>
        <p>
          {{
            tr(
              '从一份资料、一个模板、一次真实任务开始。',
              'Start with one document, one template, one real task.',
            )
          }}
        </p>
        <router-link to="/login" class="website-cta"
          >{{ tr('开启星桥工作台', 'Open your workspace') }} ↗</router-link
        >
      </section>
      <section id="website-capabilities" class="website-capabilities">
        <div class="eyebrow">
          {{ tr('从企业资产，到业务行动', 'From knowledge to action') }}
        </div>
        <h2>{{ tr('让经验持续复用。', 'Make experience reusable.') }}</h2>
        <div class="capabilities-grid">
          <article v-for="item in capabilities" :key="item[0]">
            <span>{{ item[0] }}</span>
            <h3>{{ tr(item[1], item[2]) }}</h3>
            <p>{{ tr(item[3], item[4]) }}</p>
          </article>
        </div>
      </section>
    </main>
    <footer class="website-footer">
      <span>星桥智能平台 · STARBRIDGE</span
      ><router-link to="/privacy">{{
        tr('隐私说明', 'Privacy notice')
      }}</router-link
      ><router-link to="/login"
        >{{ tr('进入工作台', 'Open workspace') }} ↗</router-link
      >
    </footer>
  </div>
</template>
