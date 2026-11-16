<script setup lang="ts">
import { computed, ref } from 'vue'
import AppIcon from '@/components/base/AppIcon.vue'
import StarbridgeMark from '@/components/base/StarbridgeMark.vue'
import { usePreferences } from '@/store/modules/preferences'

/** 公开样片只在浏览器内切镜，不会创建作品或启动生成任务。 */
const { tr } = usePreferences()
const shots = [
  {
    label: ['站台', 'Platform'],
    title: ['站台全景', 'Station panorama'],
    time: '00:00 – 00:04',
  },
  {
    label: ['车票', 'Ticket'],
    title: ['时刻表与车票', 'Timetable and tickets'],
    time: '00:04 – 00:07',
  },
  {
    label: ['雨棚', 'Canopy'],
    title: ['雨棚中景', 'Under the canopy'],
    time: '00:07 – 00:12',
  },
  {
    label: ['空车', 'Train'],
    title: ['远去的空车', 'Departing empty train'],
    time: '00:12 – 00:16',
  },
] as const
const selected = ref<number | null>(null)
const index = computed(() => selected.value ?? 1)
const shot = computed(() => shots[index.value] ?? shots[1])
const thumbnail = computed(() => `/images/website/shot-${index.value + 1}.webp`)
const steps = [
  {
    icon: 'file-text',
    title: ['剧本与导演', 'Script and direction'],
    text: [
      '拆解剧本，确认场景、台词与镜头草案。',
      'Break down the script and review scenes, dialogue and shots.',
    ],
  },
  {
    icon: 'monitor',
    title: ['分镜与候选', 'Storyboard and takes'],
    text: [
      '对比同一镜头的不同画面，选定采用版本。',
      'Compare takes of a shot and choose the one to use.',
    ],
  },
  {
    icon: 'settings',
    title: ['剪辑与导出', 'Edit and export'],
    text: [
      '在时间线上对齐画面、台词和字幕，导出成片。',
      'Align video, voices and subtitles on the timeline, then export.',
    ],
  },
] as const
defineEmits<{ jump: [id: string] }>()
</script>

<template>
  <section class="film-hero" aria-labelledby="film-title">
    <div class="film-inner">
      <div class="film-copy">
        <p class="product-caption"><i></i>STARBRIDGE STUDIO</p>
        <h1 id="film-title">
          {{ tr('把剧本', 'Turn scripts') }}<br />{{
            tr('做成短片', 'into films')
          }}<span>{{ tr('。', '.') }}</span>
        </h1>
        <p class="film-lede">
          {{
            tr(
              '从分镜草案到可编辑的时间线，在同一个作品中',
              'From a storyboard to an editable timeline, choose your takes,',
            )
          }}<br class="wide-break" />{{
            tr(
              '挑选镜头、编排配音、导出成片。',
              ' arrange voices and export a short film in one project.',
            )
          }}
        </p>
        <div class="film-actions">
          <router-link class="button button-orange" to="/entertainment"
            >{{ tr('进入创作台', 'Open Studio')
            }}<AppIcon class="diagonal-arrow" name="arrow-right"
          /></router-link>
          <a
            class="secondary-link"
            href="#film-case"
            @click.prevent="$emit('jump', 'film-case')"
            >{{ tr('看制作流程', 'See the workflow') }}
            <AppIcon name="arrow-up" class="down-arrow"
          /></a>
        </div>
      </div>
      <section
        class="studio-preview"
        :aria-label="
          tr('雨后站台分镜预览', 'After the Rain storyboard preview')
        "
      >
        <div class="preview-bar">
          <div>
            <StarbridgeMark class="brand-mark" /><b>{{
              tr('星桥娱乐', 'Starbridge Studio')
            }}</b>
          </div>
          <span>{{ tr('创作工作台', 'Studio workspace') }}</span>
        </div>
        <div class="studio-preview-head">
          <div>
            <span>{{ tr('示例作品', 'Sample project') }}</span>
            <h2>{{ tr('雨后站台', 'After the Rain') }}</h2>
          </div>
          <span class="preview-current">{{ tr('分镜板', 'Storyboard') }}</span>
        </div>
        <div class="preview-view">
          <img
            :src="selected === null ? '/images/website/film.webp' : thumbnail"
            :alt="
              selected === null
                ? tr(
                    '镜头和时间线制作台静物',
                    'Camera lens and editing console',
                  )
                : tr(shot.title[0], shot.title[1])
            "
            fetchpriority="high"
          />
          <div class="preview-plaque">
            <span>{{
              selected === null
                ? tr('工作台概念图', 'Studio concept')
                : tr('镜头预览', 'Shot preview')
            }}</span>
          </div>
        </div>
        <div class="preview-meta" aria-live="polite">
          <div class="shot-detail">
            <img :src="thumbnail" alt="" /><strong
              >{{ tr('镜头', 'Shot') }} 0{{ index + 1 }} ·
              {{ tr(shot.title[0], shot.title[1]) }}</strong
            >
          </div>
          <span>{{ shot.time }}</span>
        </div>
        <div class="preview-sequence">
          <div class="preview-line">
            <span>{{ tr('分镜序列', 'Shot sequence') }}</span
            ><span>{{ tr('4 镜', '4 shots') }} / 00:16</span>
          </div>
          <div
            class="shot-selector"
            role="group"
            :aria-label="tr('选择示例镜头', 'Choose a sample shot')"
          >
            <button
              v-for="(item, i) in shots"
              :key="item.time"
              type="button"
              :aria-pressed="i === index"
              @click="selected = i"
            >
              <em>0{{ i + 1 }}</em
              >{{ tr(item.label[0], item.label[1]) }}
            </button>
          </div>
        </div>
      </section>
    </div>
  </section>
  <section id="film-case" class="film-case wrap">
    <div class="section-head">
      <h2>{{ tr('一部短片的制作现场', 'Inside a short film') }}</h2>
      <router-link class="text-link" to="/entertainment"
        >{{ tr('打开作品目录', 'Open projects') }} <AppIcon name="arrow-right"
      /></router-link>
    </div>
    <div class="case-steps">
      <article v-for="step in steps" :key="step.icon">
        <div class="process-icon"><AppIcon :name="step.icon" /></div>
        <h3>{{ tr(step.title[0], step.title[1]) }}</h3>
        <p>{{ tr(step.text[0], step.text[1]) }}</p>
      </article>
    </div>
  </section>
</template>
