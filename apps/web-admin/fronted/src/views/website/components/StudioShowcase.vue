<script setup lang="ts">
import { ref } from 'vue'
import AppIcon from '@/components/base/AppIcon.vue'
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
import { usePreferences } from '@/store/modules/preferences'
import { useShowcaseScroll } from '@/composables/website/use-showcase-scroll'
import {
  studioArtwork as art,
  studioChapters,
} from '@/utils/website/studio-showcase'
import StudioCreationCards from './StudioCreationCards.vue'
import StudioProcessCards from './StudioProcessCards.vue'
import StudioAdvantages from './StudioAdvantages.vue'

const { tr } = usePreferences()
const viewport = ref<HTMLElement>()
const { active, jump, onKeydown } = useShowcaseScroll(viewport)
const preview = ref({ src: '', title: '' })
const previewOpen = ref(false)
function showPreview(src: string, title: string) {
  preview.value = { src, title }
  previewOpen.value = true
}
defineExpose({ jump })
</script>

<template>
  <div
    ref="viewport"
    class="studio-pages"
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
      <div class="studio-chapter-inner">
        <div class="studio-hero-grid">
          <div class="studio-hero-copy">
            <p class="studio-eyebrow"><i /> STARBRIDGE STUDIO</p>
            <h1 id="studio-title">
              {{ tr('让想象，', 'Let imagination') }}<br /><em>{{
                tr('有声有色', 'come to life')
              }}</em
              >{{ tr('地发生。', '.') }}
            </h1>
            <p class="studio-lede">
              {{
                tr(
                  '从一个想法、一段剧本或一本故事开始，',
                  'Start with an idea, a script or a story.',
                )
              }}<br />{{
                tr(
                  '创作有角色、有对白、有情绪的影片。',
                  'Create films with characters, voices and emotion.',
                )
              }}
            </p>
            <div class="studio-actions">
              <router-link class="studio-button" to="/entertainment"
                >{{ tr('进入创作台', 'Open Studio') }}
                <AppIcon name="arrow-right"
              /></router-link>
              <button
                class="studio-button studio-button-outline"
                @click="jump('film-case')"
              >
                {{ tr('看看怎样创作', 'See how it works') }}
                <AppIcon name="arrow-right" />
              </button>
            </div>
            <div class="studio-hero-note">
              <b>01 — 08</b
              ><span>{{
                tr(
                  '让故事、镜头与声音，在同一个作品中相遇。',
                  'Story, shots and sound. Together in one project.',
                )
              }}</span>
            </div>
          </div>
          <div class="studio-hero-art">
            <button
              class="studio-art-main"
              :aria-label="
                tr('查看水下幻想画面', 'View underwater fantasy artwork')
              "
              @click="
                showPreview(
                  art.underwater,
                  tr('水下幻想', 'Underwater fantasy'),
                )
              "
            >
              <img :src="art.underwater" alt="" fetchpriority="high" /><span
                >01 / {{ tr('想象，不设边界', 'Beyond the everyday') }}</span
              >
            </button>
            <button
              class="studio-art-world"
              :aria-label="tr('查看未来世界画面', 'View future world artwork')"
              @click="showPreview(art.world, tr('未来世界', 'Future worlds'))"
            >
              <img :src="art.world" alt="" /><span
                >{{ tr('构建一个世界', 'Build a world') }} ↗</span
              >
            </button>
            <button
              class="studio-art-character"
              :aria-label="
                tr('查看古风角色画面', 'View period character artwork')
              "
              @click="
                showPreview(
                  art.character,
                  tr('让角色鲜活', 'Bring characters to life'),
                )
              "
            >
              <img :src="art.character" alt="" /><span
                >{{ tr('让角色鲜活', 'Give characters life') }} ↗</span
              >
            </button>
            <div class="studio-art-label">
              <span>STORY TO SCREEN</span
              ><b>{{
                tr('你的故事，值得被看见。', 'Your story deserves a screen.')
              }}</b>
            </div>
          </div>
        </div>
        <div class="studio-chapter-foot">
          <span>{{
            tr(
              '原创视觉示意 · 探索你的创作可能',
              'Original concept artwork · Explore the possibilities',
            )
          }}</span
          ><button @click="jump('studio-creations')">
            {{ tr('向下探索', 'Scroll to explore') }}
            <AppIcon name="arrow-up" />
          </button>
        </div>
      </div>
    </section>
    <section
      id="studio-creations"
      class="studio-chapter studio-creations"
      data-chapter
      tabindex="-1"
      aria-labelledby="creations-title"
    >
      <div class="studio-chapter-inner">
        <div class="studio-section-head">
          <div>
            <p class="studio-eyebrow">
              01 / {{ tr('创作，不止一种可能', 'MADE FOR YOUR IMAGINATION') }}
            </p>
            <h2 id="creations-title">
              {{
                tr(
                  '你的故事，不止一种样子。',
                  'One story. Endless possibilities.',
                )
              }}
            </h2>
          </div>
          <p>
            {{
              tr(
                '有故事想讲，有角色想创造，',
                'A story to tell. A character to create.',
              )
            }}<br />{{
              tr(
                '就从你最喜欢的表达开始。',
                'Start with the format that feels like you.',
              )
            }}
          </p>
        </div>
        <StudioCreationCards @preview="showPreview" />
        <div class="studio-chapter-foot">
          <span>{{
            tr(
              '故事短片 / 角色动画 / 竖屏内容',
              'Narrative films / Character animation / Vertical stories',
            )
          }}</span
          ><button @click="jump('film-case')">
            {{ tr('从灵感，到成片', 'From idea to film') }}
            <AppIcon name="arrow-up" />
          </button>
        </div>
      </div>
    </section>
    <section
      id="film-case"
      class="studio-chapter studio-process"
      data-chapter
      tabindex="-1"
      aria-labelledby="process-title"
    >
      <div class="studio-chapter-inner">
        <div class="studio-section-head">
          <div>
            <p class="studio-eyebrow">02 / STORY TO SCREEN</p>
            <h2 id="process-title">
              {{
                tr(
                  '一个故事，怎样成为一部短片。',
                  'How a story becomes a film.',
                )
              }}
            </h2>
          </div>
          <p>
            {{
              tr(
                '八个步骤，四段创作旅程。',
                'Eight steps. Four creative chapters.',
              )
            }}<br />{{
              tr(
                '每一次选择，都朝你的想象更近一点。',
                'Every choice brings your vision closer.',
              )
            }}
          </p>
        </div>
        <StudioProcessCards @preview="showPreview" />
        <div class="studio-chapter-foot">
          <span>{{
            tr(
              '从剧本到导出，创作过程连贯可回看。',
              'A connected, reviewable journey from script to export.',
            )
          }}</span
          ><button @click="jump('studio-advantages')">
            {{ tr('为什么值得开始', 'Why start here') }}
            <AppIcon name="arrow-up" />
          </button>
        </div>
      </div>
    </section>
    <section
      id="studio-advantages"
      class="studio-chapter studio-advantages"
      data-chapter
      tabindex="-1"
      aria-labelledby="advantages-title"
    >
      <div class="studio-chapter-inner">
        <div class="studio-section-head">
          <div>
            <p class="studio-eyebrow">03 / YOUR STORY, YOUR CHOICE</p>
            <h2 id="advantages-title">
              {{
                tr(
                  '把精力，留给真正想讲的故事。',
                  'Keep your focus on the story.',
                )
              }}
            </h2>
          </div>
          <p>
            {{
              tr(
                'AI 提供可能，你决定表达。',
                'AI opens possibilities. You make the choices.',
              )
            }}<br />{{
              tr(
                '试得更轻松，做得更连贯。',
                'Explore freely. Create with continuity.',
              )
            }}
          </p>
        </div>
        <StudioAdvantages @preview="showPreview" />
        <div class="studio-chapter-foot">
          <span>{{
            tr(
              '少一些重复准备，多一些创作空间。',
              'Less repeated setup. More room to create.',
            )
          }}</span
          ><button @click="jump('studio-start')">
            {{ tr('开启我的故事', 'Start my story') }}
            <AppIcon name="arrow-up" />
          </button>
        </div>
      </div>
    </section>
    <section
      id="studio-start"
      class="studio-chapter studio-start"
      data-chapter
      tabindex="-1"
      aria-labelledby="start-title"
    >
      <div class="studio-chapter-inner">
        <div class="studio-closing-panel">
          <img :src="art.mountains" alt="" loading="lazy" />
          <div class="studio-closing-copy">
            <p class="studio-eyebrow">04 / EVERY STORY STARTS SOMEWHERE</p>
            <h2 id="start-title">
              {{ tr('你的下一个故事，', 'Your next story') }}<br /><em>{{
                tr('从这里开场。', 'starts here.')
              }}</em>
            </h2>
            <p>
              {{
                tr(
                  '不必等一切准备好。先把心里的那个画面，写下来。',
                  'You don’t need every answer. Start with the scene in your mind.',
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
            <router-link :to="{ query: { product: 'office' } }">{{
              tr('星桥办公', 'Starbridge Office')
            }}</router-link
            ><router-link to="/privacy">{{
              tr('隐私说明', 'Privacy notice')
            }}</router-link
            ><router-link to="/products">{{
              tr('选择工作台', 'Workspaces')
            }}</router-link
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
