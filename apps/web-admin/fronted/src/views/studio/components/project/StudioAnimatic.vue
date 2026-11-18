<script setup lang="ts">
import { toRef, type ComponentPublicInstance } from 'vue'
import StudioMedia from '../StudioMedia.vue'
import type { StudioProject } from '@/types/studio/studio'
import { useStudioAnimatic } from '@/composables/studio/use-studio-animatic'
/** 已采用画面或参考图与配音的预演视图，播放生命周期交给组合函数。 */
const props = defineProps<{ project: StudioProject }>()
const {
  playing,
  loading,
  index,
  elapsed,
  error,
  shot,
  picture,
  videoUrl,
  videoPlayer,
  length,
  currentLines,
  play,
  pause,
} = useStudioAnimatic(toRef(props, 'project'))
function bindVideo(element: Element | ComponentPublicInstance | null) {
  videoPlayer.value = element instanceof HTMLVideoElement ? element : undefined
}
</script>
<template>
  <section class="panel preparation-animatic" aria-label="分镜预演">
    <div class="toolbar">
      <div>
        <span class="eyebrow">在正式制作前看节奏</span>
        <h2>分镜预演</h2>
      </div>
      <span class="toolbar-spacer" /><el-button
        :disabled="!shot || loading"
        type="primary"
        @click="playing ? pause() : play()"
        >{{ playing ? '暂停预演' : '播放分镜预演' }}</el-button
      >
    </div>
    <div class="animatic-screen">
      <video
        v-if="videoUrl"
        :ref="bindVideo"
        :src="videoUrl"
        muted
        playsinline
        preload="metadata"
        class="studio-frame"
        aria-label="当前镜头预演画面"
      />
      <StudioMedia
        v-else-if="picture"
        :project="project.id"
        :asset="picture.id"
        kind="image"
      />
      <div v-else class="animatic-placeholder">
        {{ shot?.action || '添加镜头后，即可预演全片' }}
      </div>
      <div class="animatic-captions">
        <p v-for="line in currentLines" :key="line.id">
          {{ line.subtitle ?? line.text }}
        </p>
      </div>
    </div>
    <div class="toolbar">
      <el-button :disabled="index <= 0" @click="index--">上一镜</el-button
      ><span
        >镜 {{ shot ? index + 1 : 0 }} / {{ project.document.shots.length }} ·
        {{ (elapsed / 1000).toFixed(1) }} /
        {{ (length / 1000).toFixed(1) }} 秒</span
      ><el-button
        :disabled="index >= project.document.shots.length - 1"
        @click="index++"
        >下一镜</el-button
      >
    </div>
    <p class="studio-meta">
      按已采用画面、配音、音效和音乐预演，暂无画面时展示参考图。未采用配音的台词以字幕展示；超长配音会延长本镜预演，正式时长请在剪辑中确认。正式导出另行生成。
    </p>
    <p v-if="error" role="alert">{{ error }}</p>
  </section>
</template>
