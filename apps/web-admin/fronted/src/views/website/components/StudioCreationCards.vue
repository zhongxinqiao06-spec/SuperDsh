<script setup lang="ts">
import { computed, ref } from 'vue'
import AppIcon from '@/components/base/AppIcon.vue'
import StudioFilmLoop from './StudioFilmLoop.vue'
import { usePreferences } from '@/store/modules/preferences'
import { studioArtwork as art } from '@/utils/website/studio-showcase'

/** 三种作品分别以宽银幕、角色设定页和竖幅展出，预览只读取公开配图。 */
defineProps<{ playing: boolean }>()
defineEmits<{ preview: [src: string, title: string] }>()
const { tr } = usePreferences()
const frames = [
  [art.crystalCity, '水晶城远景', 'Crystal city'],
  [art.premiere, '旅人近景', 'The traveller'],
  ['/images/website/shot-2.webp', '车票特写', 'The ticket'],
] as const
const selected = ref(0)
const frame = computed(() => frames[selected.value] ?? frames[0])
</script>

<template>
  <div class="creation-exhibition">
    <StudioFilmLoop gallery :playing="playing" />
    <article class="creation-film studio-print">
      <button
        class="creation-film-cover"
        type="button"
        :aria-label="tr('放大故事短片', 'Enlarge narrative still')"
        @click="$emit('preview', frame[0], tr('故事短片', 'Narrative film'))"
      >
        <img :src="frame[0]" :alt="tr(frame[1], frame[2])" loading="lazy" />
        <span class="creation-film-title">{{
          tr('故事短片', 'Story films')
        }}</span>
      </button>
      <div
        class="studio-contact-strip"
        role="group"
        :aria-label="tr('故事短片镜头', 'Narrative stills')"
      >
        <button
          v-for="([src, zh, en], index) in frames"
          :key="src"
          type="button"
          :aria-label="tr(zh, en)"
          :aria-pressed="selected === index"
          @click="selected = index"
        >
          <img :src="src" alt="" loading="lazy" />
        </button>
      </div>
    </article>
    <button
      class="creation-sheet"
      type="button"
      :aria-label="tr('放大角色动画', 'Enlarge character artwork')"
      @click="
        $emit('preview', art.forest, tr('角色动画', 'Character animation'))
      "
    >
      <span class="sheet-surface studio-print">
        <span class="creation-sheet-head">{{
          tr('角色动画', 'Character animation')
        }}</span>
        <img class="creation-forest" :src="art.forest" alt="" loading="lazy" />
        <img
          class="creation-study"
          :src="art.expressions"
          :alt="tr('角色铅笔表情稿', 'Character expression sketches')"
          loading="lazy"
        />
        <span class="creation-swatches" aria-hidden="true"
          ><i /><i /><i
        /></span>
      </span>
    </button>
    <button
      class="creation-vertical"
      type="button"
      :aria-label="tr('放大竖屏内容', 'Enlarge vertical still')"
      @click="
        $emit('preview', art.rainPortrait, tr('竖屏内容', 'Vertical story'))
      "
    >
      <span class="vertical-surface studio-print">
        <img :src="art.rainPortrait" alt="" loading="lazy" />
        <span class="creation-vertical-head"
          >{{ tr('竖屏内容', 'Vertical stories') }}<small>9:16</small></span
        >
        <span class="creation-subtitle">{{
          tr('雨停之前，再走一站。', 'One more stop before the rain ends.')
        }}</span>
        <span class="creation-enlarge"
          ><AppIcon name="arrow-up" />{{ tr('查看画面', 'View still') }}</span
        >
      </span>
    </button>
  </div>
</template>
