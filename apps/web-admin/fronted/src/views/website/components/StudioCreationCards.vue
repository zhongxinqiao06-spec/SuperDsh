<script setup lang="ts">
import AppIcon from '@/components/base/AppIcon.vue'
import { usePreferences } from '@/store/modules/preferences'
import { studioArtwork as art } from '@/utils/website/studio-showcase'
const { tr } = usePreferences()
defineEmits<{ preview: [src: string, title: string] }>()
</script>

<template>
  <div class="studio-creation-grid">
    <button
      class="studio-creation-card studio-story-card"
      @click="$emit('preview', art.story, tr('故事短片', 'Narrative films'))"
    >
      <img :src="art.story" alt="" loading="lazy" />
      <span class="studio-card-index"
        >01 / {{ tr('故事短片', 'NARRATIVE FILMS') }}</span
      >
      <div class="studio-poster-copy">
        <span>A STORY WORTH TELLING</span>
        <h3>
          {{ tr('把一句话，', 'One idea.') }}<br />{{
            tr('讲成一个故事。', 'A whole story.')
          }}
        </h3>
        <p>
          {{
            tr(
              '让情绪有画面，让对白有回响。',
              'Give emotion a scene and dialogue a voice.',
            )
          }}
        </p>
      </div>
      <span
        class="studio-card-open"
        :aria-label="tr('查看画面', 'View artwork')"
        ><AppIcon name="arrow-up"
      /></span>
    </button>
    <button
      class="studio-creation-card studio-animation-card"
      @click="
        $emit('preview', art.animation, tr('角色动画', 'Character animation'))
      "
    >
      <div class="studio-animation-image">
        <img :src="art.animation" alt="" loading="lazy" /><span
          class="studio-card-index"
          >02 / {{ tr('角色动画', 'ANIMATION') }}</span
        >
      </div>
      <div class="studio-animation-caption">
        <div>
          <span>MEET YOUR CHARACTERS</span>
          <h3>
            {{ tr('让想象中的它，', 'Let your character') }}<br />{{
              tr('有自己的世界。', 'find their world.')
            }}
          </h3>
          <p>
            {{
              tr(
                '从角色设定，到一段鲜活的冒险。',
                'From a character sketch to a living adventure.',
              )
            }}
          </p>
        </div>
        <AppIcon name="arrow-right" />
      </div>
    </button>
    <button
      class="studio-creation-card studio-portrait-card"
      @click="
        $emit('preview', art.portrait, tr('竖屏内容', 'Vertical stories'))
      "
    >
      <span class="studio-card-index"
        >03 / {{ tr('竖屏内容', 'VERTICAL STORIES') }}</span
      >
      <div class="studio-portrait-copy">
        <span>SMALL SCREEN, BIG STORIES</span>
        <h3>
          {{ tr('小屏幕，', 'Small screen.') }}<br />{{
            tr('也有大故事。', 'Big stories.')
          }}
        </h3>
        <p>
          {{ tr('为竖屏设计节奏，', 'Find a vertical rhythm.') }}<br />{{
            tr('把精彩留在每一帧。', 'Make every frame count.')
          }}
        </p>
        <span class="studio-format"><AppIcon name="smartphone" /> 9:16</span>
      </div>
      <div class="studio-phone-frame">
        <img :src="art.portrait" alt="" loading="lazy" /><span
          >STORY 003 <i
        /></span>
      </div>
    </button>
  </div>
</template>
