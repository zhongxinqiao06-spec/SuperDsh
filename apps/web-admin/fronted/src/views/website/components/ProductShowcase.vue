<script setup lang="ts">
import { ref } from 'vue'
import { websiteScreens } from '@/utils/website/content'
import { usePreferences } from '@/store/modules/preferences'
const { tr } = usePreferences(),
  selected = ref(0),
  preview = ref(false)
function text(value: readonly string[]) {
  return tr(value[0] ?? '', value[1] ?? '')
}
</script>
<template>
  <section id="website-connected" class="website-section website-section-light">
    <div class="eyebrow">YOUR WORK. WITHIN REACH.</div>
    <h2>
      {{
        tr(
          '大屏专注，随时接续。',
          'Focus on the big screen. Continue anywhere.',
        )
      }}
    </h2>
    <p>
      {{
        tr(
          '看得到任务过程，也拿得到工作成果。在电脑与手机浏览器中，打开你的 AI 工作台。',
          'Follow tasks and access deliverables from desktop and mobile browsers.',
        )
      }}
    </p>
    <div class="website-tabs">
      <button
        v-for="(item, index) in websiteScreens"
        :key="item.src"
        :aria-pressed="selected === index"
        @click="selected = index"
      >
        {{ text(item.title) }}
      </button>
    </div>
    <button
      class="website-screenshot"
      :aria-label="tr('放大查看截图', 'Enlarge screenshot')"
      @click="preview = true"
    >
      <img
        :src="websiteScreens[selected]?.src"
        :alt="text(websiteScreens[selected]?.title ?? websiteScreens[0].title)"
        loading="lazy"
        :class="{ 'mobile-screen': selected === 1 }"
      />
    </button>
    <p>
      {{
        tr(
          '官网截图使用虚构业务数据。',
          'Website screenshots use fictional business data.',
        )
      }}
    </p>
    <el-dialog
      v-model="preview"
      :title="text(websiteScreens[selected]?.title ?? websiteScreens[0].title)"
      width="min(1200px,96vw)"
      ><img
        :src="websiteScreens[selected]?.src"
        :alt="text(websiteScreens[selected]?.title ?? websiteScreens[0].title)"
        style="max-width: 100%; max-height: 80vh; display: block; margin: auto"
    /></el-dialog>
  </section>
</template>
