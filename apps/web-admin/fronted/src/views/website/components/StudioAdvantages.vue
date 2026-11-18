<script setup lang="ts">
import { ref } from 'vue'
import AppIcon from '@/components/base/AppIcon.vue'
import { usePreferences } from '@/store/modules/preferences'
import { studioArtwork as art } from '@/utils/website/studio-showcase'
const { tr } = usePreferences()
const chosen = ref(1)
defineEmits<{ preview: [src: string, title: string] }>()
</script>

<template>
  <div class="studio-benefits">
    <article class="studio-compare">
      <div class="studio-benefit-copy">
        <span class="studio-eyebrow">MAKE IT YOURS</span>
        <h3>
          {{ tr('先试一镜，再放心制作。', 'Try a shot. Find your direction.') }}
        </h3>
        <p>
          {{
            tr(
              '先看一段代表镜头的效果，再决定后续的制作范围。',
              'Review a representative shot before choosing what to produce next.',
            )
          }}
        </p>
        <h4>
          {{ tr('不满意的一镜，单独重做。', 'Refine a shot on its own.') }}
        </h4>
        <p>
          {{
            tr(
              '对比多个候选画面，选择更贴近故事的表达。',
              'Compare candidates and choose the expression that fits your story.',
            )
          }}
        </p>
        <small
          >{{
            tr('右侧可切换示意选择', 'Select a concept on the right')
          }}
          →</small
        >
      </div>
      <div
        class="studio-compare-frames"
        role="group"
        :aria-label="tr('候选画面对比示意', 'Candidate comparison demo')"
      >
        <button
          v-for="(src, index) in [art.actor, art.actor]"
          :key="index"
          :aria-pressed="chosen === index"
          @click="chosen = index"
        >
          <img :src="src" alt="" loading="lazy" /><span
            class="studio-take-number"
            >TAKE 0{{ index + 1 }}</span
          ><span class="studio-take-state"
            ><AppIcon v-if="chosen === index" name="check" />{{
              chosen === index
                ? tr('示意选中', 'Selected concept')
                : tr('选择这版', 'Choose concept')
            }}</span
          ><span class="studio-take-caption">{{
            index === 0
              ? tr('中景 · 留一点环境', 'Medium · A sense of place')
              : tr('近景 · 走近她的情绪', 'Close · A moment of emotion')
          }}</span>
        </button>
      </div>
    </article>
    <article class="studio-reuse">
      <div>
        <span class="studio-eyebrow">KEEP THE CONNECTION</span>
        <h3>
          {{ tr('角色与声音，下次接着用。', 'Keep your characters close.') }}
        </h3>
        <p>
          {{
            tr(
              '保存角色、场景与声音设定，复用已确认的素材，让下一段故事更快开始。',
              'Reuse confirmed characters, settings and voices when your next story begins.',
            )
          }}
        </p>
      </div>
      <div class="studio-reuse-visual">
        <div class="studio-face-stack">
          <img :src="art.actor" alt="" loading="lazy" /><img
            :src="art.character"
            alt=""
            loading="lazy"
          /><img :src="art.animation" alt="" loading="lazy" />
        </div>
        <div
          class="studio-sound-wave"
          :aria-label="tr('配音波形示意', 'Voice waveform illustration')"
        >
          <i
            v-for="(height, index) in [
              12, 22, 36, 16, 29, 44, 21, 38, 48, 26, 14, 32, 42, 20, 34, 15,
              24, 10,
            ]"
            :key="index"
            :style="{ height: height + 'px' }"
          />
        </div>
      </div>
    </article>
    <article class="studio-advice-card">
      <AppIcon name="sparkles" />
      <div>
        <h3>{{ tr('AI 提建议，你来定稿。', 'AI suggests. You decide.') }}</h3>
        <p>
          {{
            tr(
              '从剧本建议到候选画面，先看、再比较、再采用。故事的方向始终由你决定。',
              'Review suggestions and compare candidates before adopting them. The story stays yours.',
            )
          }}
        </p>
      </div>
      <span>YOUR FINAL CUT ↗</span>
    </article>
  </div>
</template>
