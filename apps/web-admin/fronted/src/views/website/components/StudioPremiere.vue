<script setup lang="ts">
import { computed, toRef } from 'vue'
import StudioFilmLoop from './StudioFilmLoop.vue'
import StudioMotionToggle from './StudioMotionToggle.vue'
import AppIcon from '@/components/base/AppIcon.vue'
import { usePreferences } from '@/store/modules/preferences'
import { usePremiereDemo } from '@/composables/website/use-premiere-demo'
import { studioArtwork as art } from '@/utils/website/studio-showcase'

/** 公开首页开场，案例复用官网图片预览，流程入口定位到现有八步业务章节。 */
const props = defineProps<{ visible: boolean; reduced: boolean }>()
const ambient = defineModel<boolean>({ required: true })
defineEmits<{ preview: [src: string, title: string]; process: [] }>()
const { tr } = usePreferences()
const { seam, paper, stage, playback, toggle, select, chooseStage } =
  usePremiereDemo(toRef(props, 'visible'), toRef(props, 'reduced'))
const running = computed(() => props.visible && ambient.value && !props.reduced)
const action = computed(() => {
  if (playback.value === 'playing') return tr('暂停演示', 'Pause demo')
  if (playback.value === 'paused') return tr('继续演示', 'Resume demo')
  if (playback.value === 'finished') return tr('再看一次', 'Replay demo')
  if (props.reduced && (paper.value || seam.value === 100))
    return tr('看下一步', 'Next stage')
  return tr('看创作过程', 'Watch the process')
})
const steps = [
  ['script', '剧本', 'Script'],
  ['board', '分镜', 'Storyboard'],
  ['film', '成片', 'Film'],
] as const
const examples = [
  [art.world, '故事短片', 'Story films'],
  [art.forest, '角色动画', 'Character animation'],
  [art.portrait, '竖屏内容', 'Vertical stories'],
] as const
function scrub(event: Event) {
  const slider = event.currentTarget as HTMLInputElement
  select(slider.valueAsNumber)
}
</script>

<template>
  <div
    class="studio-chapter-inner premiere"
    :data-motion="running ? 'running' : 'paused'"
  >
    <div class="premiere-lead">
      <div class="premiere-copy">
        <p class="premiere-eyebrow">
          {{ tr('星桥创作室', 'Starbridge Studio') }}<i aria-hidden="true" />{{
            tr('故事到成片', 'Story to screen')
          }}
        </p>
        <h1 id="studio-title">
          <span>{{ tr('让想象，', 'Let imagination') }}</span
          ><span
            ><em>{{ tr('有声有色', 'come to life') }}</em
            >{{ tr('地发生。', '.') }}</span
          >
        </h1>
        <p class="premiere-desc">
          {{
            tr(
              '写下故事，定下角色与镜头，',
              'Write your story and choose your cast and shots.',
            )
          }}<br />{{
            tr(
              '让对白、声音和画面一起成为短片。',
              'Bring dialogue, sound and picture together in a short film.',
            )
          }}
        </p>
        <div class="premiere-actions">
          <router-link class="studio-button" to="/entertainment"
            >{{ tr('进入创作台', 'Open Studio')
            }}<AppIcon class="diagonal-arrow" name="arrow-right"
          /></router-link>
          <button class="premiere-watch" type="button" @click="toggle">
            <AppIcon
              :name="playback === 'playing' ? 'circle-pause' : 'circle-play'"
            />
            <b>{{ action }}</b>
          </button>
        </div>
      </div>
      <div class="premiere-wall">
        <StudioFilmLoop :playing="running" />
        <div class="premiere-stage">
          <div
            class="premiere-projector"
            :style="{
              '--seam': seam + '%',
              '--progress': (paper ? 0 : 100 - seam / 2) + '%',
            }"
          >
            <div
              class="premiere-frame"
              role="group"
              :aria-label="
                tr(
                  '同一镜头的分镜与成片对照',
                  'Compare storyboard and final frame',
                )
              "
            >
              <img
                class="premiere-color"
                :src="art.premiere"
                fetchpriority="high"
                :alt="
                  tr(
                    '旅人抬头，金色夕阳落在脸上',
                    'A traveller looks up into the evening sun',
                  )
                "
              />
              <img class="premiere-pencil" :src="art.board" alt="" />
              <div
                v-show="!paper && seam > 0 && seam < 100"
                class="premiere-cursor"
                aria-hidden="true"
              >
                <span>‹ ›</span>
              </div>
              <div v-if="paper" class="premiere-script">
                <small>{{
                  tr('外景 · 老城街口 · 黄昏', 'EXT. OLD TOWN — DUSK')
                }}</small>
                <p>
                  {{ tr('他停下脚步，抬头。', 'He stops and looks up.')
                  }}<br />{{
                    tr(
                      '最后一束光落在他脸上。',
                      'The last light falls across his face.',
                    )
                  }}
                </p>
                <span>{{
                  tr('近景，缓慢推近。', 'Close shot. Slowly push in.')
                }}</span>
              </div>
              <input
                type="range"
                class="premiere-drag"
                min="0"
                max="100"
                :value="seam"
                :aria-label="
                  tr('调整分镜画面占比', 'Adjust storyboard coverage')
                "
                :aria-valuetext="
                  paper
                    ? tr('剧本页', 'Script page')
                    : tr('分镜占 ' + seam + '%', seam + '% storyboard')
                "
                @input="scrub"
              />
            </div>
            <div
              class="premiere-transport"
              role="group"
              :aria-label="tr('选择创作阶段', 'Choose a stage')"
            >
              <button
                v-for="[key, zh, en] in steps"
                :key="key"
                type="button"
                :aria-pressed="stage === key"
                @click="chooseStage(key)"
              >
                {{ tr(zh, en) }}
              </button>
              <div class="premiere-timeline" aria-hidden="true"><i /></div>
            </div>
          </div>
        </div>
        <div
          class="premiere-examples"
          role="group"
          :aria-label="tr('作品示例', 'Example artwork')"
        >
          <button
            v-for="([src, zh, en], index) in examples"
            :key="src"
            type="button"
            :aria-label="tr('查看' + zh + '画面', 'View ' + en)"
            @click="$emit('preview', src, tr(zh, en))"
          >
            <span class="premiere-print">
              <img :src="src" alt="" />
              <i
                v-if="index === 1"
                class="premiere-glints"
                aria-hidden="true"
              />
              <i
                v-if="index === 2"
                class="premiere-reflection"
                aria-hidden="true"
              />
              <span class="premiere-caption">{{ tr(zh, en) }}</span>
            </span>
          </button>
        </div>
        <img class="premiere-backprint" :src="art.character" alt="" />
      </div>
    </div>
    <div class="premiere-foot">
      <button type="button" class="premiere-discover" @click="$emit('process')">
        {{ tr('探索八步创作流程', 'Explore all eight steps')
        }}<AppIcon name="chevron-down" />
      </button>
      <StudioMotionToggle
        v-if="!reduced && visible"
        v-model="ambient"
        class="premiere-motion-switch"
      />
    </div>
  </div>
</template>
