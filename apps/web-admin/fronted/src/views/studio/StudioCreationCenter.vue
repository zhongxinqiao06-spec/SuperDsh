<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import AppIcon from '@/components/base/AppIcon.vue'
import { useAuthStore } from '@/store/modules/auth-store'
import { usePreferences } from '@/store/modules/preferences'
import { studioArtwork as art } from '@/utils/website/studio-showcase'

/** 模式配图复用官网素材。进入引导页只展示入口，创建动作留给对应的编辑流程。 */
const auth = useAuthStore()
const writable = computed(() => auth.can('studio.projects.write'))
const { tr } = usePreferences()
const modes = [
  {
    id: 'quick',
    title: ['快速创作', 'Quick creation'],
    copy: [
      '写一句描述，或上传一张参考图，做成单条视频。',
      'Turn a prompt or a reference image into a single video.',
    ],
    image: art.underwater,
    path: '/entertainment/quick/new',
  },
  {
    id: 'storyboard',
    title: ['分镜创作', 'Storyboard film'],
    copy: [
      '把一个故事拆成镜头，逐镜制作，再剪成短片。',
      'Break a story into shots and edit them together into a short film.',
    ],
    image: art.stationBoards,
    path: '/entertainment/storyboard/new',
  },
  {
    id: 'series',
    title: ['系列短剧', 'Episodic series'],
    copy: [
      '设定共用的角色与世界，编排分集，逐集制作。',
      'Build a shared cast and world, then plan and produce each episode.',
    ],
    image: art.crystalCity,
    path: '/entertainment/series/new',
  },
] as const
</script>

<template>
  <div class="page creation-center">
    <header class="creation-hero">
      <div class="creation-intro">
        <h1>
          {{ tr('创作', 'Creation') }}<em>{{ tr('中心', ' Studio') }}</em>
        </h1>
        <p>
          {{
            tr(
              '从一个镜头、一段故事，或一整季短剧开始。',
              'Start with a single shot, a story, or a whole season.',
            )
          }}
        </p>
        <router-link class="works-link" to="/entertainment/works">
          <AppIcon name="folder" :size="16" />
          {{ tr('查看我的作品', 'View my works') }}
          <AppIcon name="chevron-right" :size="14" />
        </router-link>
      </div>
      <div class="creation-stills" aria-hidden="true">
        <div class="pencil-still"><img :src="art.board" alt="" /></div>
        <div class="film-still">
          <img :src="art.premiere" alt="" fetchpriority="high" />
        </div>
      </div>
    </header>
    <el-alert
      v-if="!writable"
      :title="
        tr(
          '当前账号只有查看权限，可前往「我的作品」浏览已有作品。',
          'You have viewing access. Open My works to browse existing projects.',
        )
      "
      type="info"
      :closable="false"
    />
    <section class="creation-choices" aria-labelledby="creation-choices-title">
      <h2 id="creation-choices-title">
        {{ tr('选择创作方式', 'Choose a creation mode') }}
      </h2>
      <div
        class="mode-grid"
        role="group"
        :aria-label="tr('选择创作模式', 'Creation modes')"
      >
        <component
          :is="writable ? RouterLink : 'article'"
          v-for="mode in modes"
          :key="mode.id"
          v-bind="writable ? { to: mode.path } : {}"
          :aria-label="tr(mode.title[0], mode.title[1])"
          :aria-describedby="'mode-copy-' + mode.id"
          class="mode-card"
        >
          <div class="mode-cover"><img :src="mode.image" alt="" /></div>
          <div class="mode-body">
            <h3>{{ tr(mode.title[0], mode.title[1]) }}</h3>
            <span v-if="writable" class="mode-arrow" aria-hidden="true"
              ><AppIcon name="arrow-right" :size="18"
            /></span>
            <p :id="'mode-copy-' + mode.id">
              {{ tr(mode.copy[0], mode.copy[1]) }}
            </p>
          </div>
        </component>
      </div>
    </section>
  </div>
</template>

<style scoped src="../../assets/styles/studio-creation-center.css"></style>
