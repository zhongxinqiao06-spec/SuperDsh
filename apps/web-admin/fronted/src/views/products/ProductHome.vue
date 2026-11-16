<script setup lang="ts">
import AppIcon from '@/components/base/AppIcon.vue'
import PublicBrand from '@/views/website/components/PublicBrand.vue'
import { useAuthStore } from '@/store/modules/auth-store'
import { usePreferences } from '@/store/modules/preferences'
import '@/assets/styles/product-website.css'

/** 登录后的双资格入口沿用各产品路由及其服务端授权，只展示本账号能进入的工作台。 */
const auth = useAuthStore()
const { tr } = usePreferences()
const choices = [
  {
    path: '/entertainment',
    permission: 'products.entertainment',
    style: 'film',
    brand: 'STARBRIDGE STUDIO',
    image: 'film',
    title: ['星桥娱乐', 'Starbridge Studio'],
    blurb: [
      '从剧本、角色和分镜，制作多角色配音短片。',
      'Turn scripts, characters and storyboards into voiced short films.',
    ],
    action: ['进入创作台', 'Open Studio'],
  },
  {
    path: '/office',
    permission: 'products.office',
    style: 'office',
    brand: 'STARBRIDGE OFFICE',
    image: 'paper',
    title: ['星桥办公', 'Starbridge Office'],
    blurb: [
      '在对话中核对资料，交付可编辑的文档、表格和简报。',
      'Verify sources in conversation and deliver editable documents, spreadsheets and briefs.',
    ],
    action: ['进入办公台', 'Open Office'],
  },
] as const
</script>
<template>
  <div class="starbridge-public product-launch">
    <header class="launch-header">
      <div class="mast-inner">
        <PublicBrand /><router-link class="launch-back" to="/"
          ><AppIcon name="arrow-left" />{{
            tr('返回官网', 'Back to website')
          }}</router-link
        >
      </div>
    </header>
    <main class="launch-main">
      <header class="launch-heading">
        <h1>{{ tr('选择工作台', 'Choose a workspace') }}</h1>
        <p>
          {{
            tr(
              '进入后可从页头切换工作台。',
              'You can switch workspaces from the header.',
            )
          }}
        </p>
      </header>
      <div class="workspace-choices">
        <template v-for="choice in choices" :key="choice.path">
          <router-link
            v-if="auth.can(choice.permission)"
            :class="['choice', 'choice-' + choice.style]"
            :to="choice.path"
            :aria-label="
              tr(choice.title[0], choice.title[1]) +
              ' · ' +
              tr(choice.action[0], choice.action[1])
            "
          >
            <div class="choice-image">
              <img :src="'/images/website/' + choice.image + '.webp'" alt="" />
              <div
                :class="choice.style === 'film' ? 'edge-mark' : 'paper-edge'"
                aria-hidden="true"
              ></div>
            </div>
            <div class="choice-copy">
              <div class="choice-sub">{{ choice.brand }}</div>
              <h2>{{ tr(choice.title[0], choice.title[1]) }}</h2>
              <p>{{ tr(choice.blurb[0], choice.blurb[1]) }}</p>
              <span class="choice-action"
                >{{ tr(choice.action[0], choice.action[1]) }}
                <AppIcon name="arrow-right"
              /></span>
            </div>
          </router-link>
        </template>
      </div>
    </main>
  </div>
</template>
