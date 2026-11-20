<script setup lang="ts">
import { ref } from 'vue'
import AppIcon from '@/components/base/AppIcon.vue'
import { usePreferences } from '@/store/modules/preferences'
import { studioArtwork as art } from '@/utils/website/studio-showcase'

/** 候选选择只切换官网示例中的前景画片，不会修改作品。 */
const { tr } = usePreferences()
const chosen = ref(1)
const takes = [
  [art.mediumTake, '中景', 'Medium shot'],
  [art.actor, '近景', 'Close-up'],
] as const
const voice = [
  12, 22, 36, 16, 29, 44, 21, 38, 48, 26, 14, 32, 42, 20, 34, 15, 24, 10,
]
</script>

<template>
  <div class="benefits-spread">
    <div class="benefit-lead">
      <div class="benefit-statement">
        <h3>
          {{ tr('先试一镜，', 'Try a shot.') }}<br />{{
            tr('再放心制作。', 'Then go further.')
          }}
        </h3>
        <p>
          {{
            tr(
              '不满意的镜头，可以单独重做。',
              'Refine one shot without remaking the rest.',
            )
          }}
        </p>
      </div>
      <div
        class="benefit-comparison"
        role="group"
        :aria-label="tr('候选画面对比示意', 'Candidate comparison demo')"
      >
        <button
          v-for="([src, zh, en], i) in takes"
          :key="src"
          class="benefit-take studio-print"
          type="button"
          :aria-pressed="i === chosen"
          :aria-label="tr('选择' + zh, 'Choose ' + en)"
          @click="chosen = i"
        >
          <img :src="src" alt="" loading="lazy" />
          <span class="take-caption">{{ tr(zh, en) }}</span>
          <span v-if="chosen === i" class="take-selected"
            ><AppIcon name="check" />{{ tr('已选', 'Selected') }}</span
          >
        </button>
      </div>
    </div>
    <div class="benefit-notes">
      <article class="benefit-reuse">
        <h3>
          {{ tr('角色与声音，', 'Cast and voice,') }}<br />{{
            tr('下次接着用。', 'ready to reuse.')
          }}
        </h3>
        <div class="reuse-portraits" aria-hidden="true">
          <img
            v-for="src in [art.actor, art.character, art.animation]"
            :key="src"
            :src="src"
            alt=""
            loading="lazy"
          />
        </div>
        <div
          class="reuse-wave"
          :aria-label="tr('配音波形示意', 'Voice waveform illustration')"
          role="img"
        >
          <i
            v-for="(v, i) in voice"
            :key="i"
            :style="{
              height: (v / 48) * 100 + '%',
              '--delay': i * -0.17 + 's',
            }"
          />
        </div>
      </article>
      <article class="benefit-direction">
        <h3>
          {{ tr('AI 提建议，', 'AI suggests.') }}<br />{{
            tr('你来定稿。', 'You decide.')
          }}
        </h3>
        <div class="revision-slip">
          <small>{{
            tr(
              '第 12 场 · 站台 · 夜 · 雨',
              'Scene 12 · Platform · Rain at night',
            )
          }}</small>
          <p>
            {{ tr('她抬起头，望向', 'She looks up at the ')
            }}<del>{{ tr('远方的', 'distant') }}</del
            ><ins>{{ tr('驶过的', 'passing') }}</ins
            >{{ tr('列车。', ' train.') }}
          </p>
        </div>
      </article>
    </div>
  </div>
</template>
