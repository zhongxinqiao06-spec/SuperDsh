<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import StudioChapterFoot from './StudioChapterFoot.vue'
import StudioMotionToggle from './StudioMotionToggle.vue'
import AppIcon from '@/components/base/AppIcon.vue'
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
import { usePreferences } from '@/store/modules/preferences'
import { useShowcaseScroll } from '@/composables/website/use-showcase-scroll'
import {
  studioArtwork as art,
  studioChapters,
} from '@/utils/website/studio-showcase'
import StudioPremiere from './StudioPremiere.vue'
import StudioCreationCards from './StudioCreationCards.vue'
import StudioProcessCards from './StudioProcessCards.vue'
import StudioAdvantages from './StudioAdvantages.vue'

const { tr } = usePreferences()
const viewport = ref<HTMLElement>()
const { active, jump, onKeydown } = useShowcaseScroll(viewport)
const preview = ref({ src: '', title: '' })
const previewOpen = ref(false)
// 全站展示共享同一动效开关；离屏、切走标签或查看大图时停止背景运动。
const ambient = ref(true)
const media = window.matchMedia('(prefers-reduced-motion: reduce)')
const reduced = ref(media.matches)
const hidden = ref(document.hidden)
const visible = computed(() => !hidden.value && !previewOpen.value)
const animating = computed(
  () => visible.value && ambient.value && !reduced.value,
)
function syncPreference() {
  reduced.value = media.matches
}
function syncVisibility() {
  hidden.value = document.hidden
}
onMounted(() => {
  media.addEventListener('change', syncPreference)
  document.addEventListener('visibilitychange', syncVisibility)
})
onBeforeUnmount(() => {
  media.removeEventListener('change', syncPreference)
  document.removeEventListener('visibilitychange', syncVisibility)
})
function showPreview(src: string, title: string) {
  preview.value = { src, title }
  previewOpen.value = true
}
defineExpose({ jump, active })
</script>

<template>
  <div
    ref="viewport"
    class="studio-pages"
    :data-motion="animating ? 'running' : 'paused'"
    tabindex="0"
    :aria-label="tr('星桥娱乐分屏展示', 'Starbridge Studio chapters')"
    @keydown="onKeydown"
  >
    <section
      id="studio-intro"
      class="studio-chapter studio-intro"
      data-chapter
      tabindex="-1"
      aria-labelledby="studio-title"
    >
      <StudioPremiere
        v-model="ambient"
        :visible="active === 0 && visible"
        :reduced="reduced"
        @preview="showPreview"
        @process="jump('film-case')"
      />
    </section>
    <section
      id="studio-creations"
      class="studio-chapter studio-creations"
      data-chapter
      :data-active="active === 1"
      tabindex="-1"
      aria-labelledby="creations-title"
    >
      <div class="studio-chapter-inner editorial-page">
        <header class="studio-section-head">
          <h2 id="creations-title">
            {{ tr('你的', 'Your ') }}<em>{{ tr('故事', 'story') }}</em
            >{{ tr('，不止一种样子。', ', in more than one form.') }}
          </h2>
          <p>
            {{
              tr(
                '选一种表达，让故事开场。',
                'Choose a format and let the story begin.',
              )
            }}
          </p>
        </header>
        <StudioCreationCards
          :playing="active === 1 && animating"
          @preview="showPreview"
        />
        <StudioChapterFoot
          v-model="ambient"
          :show-motion="!reduced && active === 1"
          :label="tr('从灵感，到成片', 'From idea to film')"
          @next="jump('film-case')"
        />
      </div>
    </section>
    <section
      id="film-case"
      class="studio-chapter studio-process"
      data-chapter
      :data-active="active === 2"
      tabindex="-1"
      aria-labelledby="process-title"
    >
      <div class="studio-chapter-inner editorial-page">
        <header class="studio-section-head">
          <div>
            <p class="studio-eyebrow">
              {{
                tr('《雨后站台》制作手记', 'After the Rain · Production notes')
              }}
            </p>
            <h2 id="process-title">
              {{ tr('一个故事，怎样成为一部', 'How a story becomes a ')
              }}<em>{{ tr('短片', 'film') }}</em
              >{{ tr('。', '.') }}
            </h2>
          </div>
        </header>
        <StudioProcessCards
          :playing="active === 2 && animating"
          @preview="showPreview"
        />
        <StudioChapterFoot
          v-model="ambient"
          :show-motion="!reduced && active === 2"
          :label="tr('为什么值得开始', 'Why start here')"
          @next="jump('studio-advantages')"
        />
      </div>
    </section>
    <section
      id="studio-advantages"
      class="studio-chapter studio-advantages"
      data-chapter
      :data-active="active === 3"
      tabindex="-1"
      aria-labelledby="advantages-title"
    >
      <div class="studio-chapter-inner editorial-page">
        <header class="studio-section-head">
          <div>
            <p class="studio-eyebrow">
              03 / {{ tr('创作优势', 'Creative advantages') }}
            </p>
            <h2 id="advantages-title">
              {{ tr('把精力，留给真正想讲的', 'Focus on the ')
              }}<em>{{ tr('故事', 'story') }}</em
              >{{ tr('。', ' you want to tell.') }}
            </h2>
          </div>
        </header>
        <StudioAdvantages />
        <StudioChapterFoot
          v-model="ambient"
          :show-motion="!reduced && active === 3"
          :label="tr('开启我的故事', 'Start my story')"
          @next="jump('studio-start')"
        />
      </div>
    </section>
    <section
      id="studio-start"
      class="studio-chapter studio-start"
      :data-active="active === 4"
      data-chapter
      tabindex="-1"
      aria-labelledby="start-title"
    >
      <div class="studio-chapter-inner">
        <div class="studio-closing-panel">
          <img
            class="closing-panorama"
            :src="art.mountains"
            alt=""
            loading="lazy"
          />
          <img class="closing-mist" :src="art.cloud" alt="" loading="lazy" />
          <div class="closing-contact" aria-hidden="true">
            <img
              v-for="(src, index) in [
                art.mountains,
                art.crystalCity,
                art.mountains,
              ]"
              :key="index"
              :src="src"
              alt=""
              loading="lazy"
            />
          </div>
          <div class="studio-closing-copy">
            <h2 id="start-title">
              {{ tr('你的下一个故事，', 'Your next story') }}<br /><em>{{
                tr('从这里开场。', 'starts here.')
              }}</em>
            </h2>
            <p>
              {{
                tr(
                  '先把心里的那个画面，写下来。',
                  'Write down the scene in your mind.',
                )
              }}
            </p>
            <router-link class="studio-button" to="/entertainment"
              >{{ tr('开始我的创作', 'Start creating') }}
              <AppIcon name="arrow-right"
            /></router-link>
          </div>
        </div>
        <footer class="studio-footer">
          <b>星桥 <span>STARBRIDGE</span></b>
          <div>
            <StudioMotionToggle
              v-if="!reduced && active === 4"
              v-model="ambient"
            />
            <router-link :to="{ query: { product: 'office' } }">{{
              tr('星桥办公', 'Starbridge Office')
            }}</router-link
            ><router-link
              :to="{ path: '/privacy', query: { product: 'entertainment' } }"
              >{{ tr('隐私说明', 'Privacy notice') }}</router-link
            ><router-link
              :to="{ path: '/products', query: { product: 'entertainment' } }"
              >{{ tr('选择工作台', 'Workspaces') }}</router-link
            ><button @click="jump('studio-intro')">
              {{ tr('回到开场', 'Back to top') }} ↑
            </button>
          </div>
        </footer>
      </div>
    </section>
  </div>
  <nav
    class="studio-chapter-nav"
    :aria-label="tr('章节导航', 'Chapter navigation')"
  >
    <button
      v-for="(chapter, index) in studioChapters"
      :key="chapter.id"
      :aria-label="tr(chapter.title[0], chapter.title[1])"
      :aria-current="active === index ? 'step' : undefined"
      @click="jump(chapter.id)"
    >
      <span>{{ tr(chapter.title[0], chapter.title[1]) }}</span
      ><i />
    </button>
  </nav>
  <ManagementDialog
    v-model="previewOpen"
    :title="preview.title"
    readonly
    width="min(960px, calc(100vw - 32px))"
    ><figure class="website-art-preview">
      <img :src="preview.src" :alt="preview.title" />
      <figcaption>
        {{
          tr(
            '原创视觉示意，用于展示创作方向。',
            'Original concept artwork illustrating creative possibilities.',
          )
        }}
      </figcaption>
    </figure></ManagementDialog
  >
</template>
