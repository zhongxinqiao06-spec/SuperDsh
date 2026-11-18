<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppIcon from '@/components/base/AppIcon.vue'
import { usePreferences } from '@/store/modules/preferences'
import PublicBrand from './components/PublicBrand.vue'
import StudioShowcase from './components/StudioShowcase.vue'
import OfficeShowcase from './components/OfficeShowcase.vue'
import OfficeResources from './components/OfficeResources.vue'
import '@/assets/styles/product-website.css'
import '@/assets/styles/website/studio-landing.css'
import { studioChapters } from '@/utils/website/studio-showcase'

/** 公开产品切换使用路由查询态，支持复制地址、刷新与回退，无需读取账号。 */
const route = useRoute()
const router = useRouter()
const preferences = usePreferences()
const { tr } = preferences
const product = computed(() =>
  route.query.product === 'office' ? 'office' : 'entertainment',
)
const products = [
  { key: 'entertainment', title: ['星桥娱乐', 'Studio'] },
  { key: 'office', title: ['星桥办公', 'Office'] },
] as const
const officeSections = [
  ['website-capabilities', '产品能力', 'Capabilities'],
  ['website-scenarios', '应用场景', 'Scenarios'],
  ['website-architecture', '平台架构', 'Architecture'],
  ['website-connected', '多端体验', 'Connected'],
  ['website-faq', '常见问题', 'FAQ'],
] as const
const sections = computed(() =>
  product.value === 'office'
    ? officeSections
    : studioChapters.map(
        (item) => [item.id, item.title[0], item.title[1]] as const,
      ),
)
const studio = ref<InstanceType<typeof StudioShowcase>>()
const menu = ref<HTMLElement>()
const menuButton = ref<HTMLButtonElement>()
const menuOpen = ref(false)
function productLocation(key: string) {
  return { path: route.path, query: { ...route.query, product: key } }
}
function closeMenu(focus = false) {
  menuOpen.value = false
  if (focus) menuButton.value?.focus()
}
function outside(event: PointerEvent) {
  if (!menu.value?.contains(event.target as Node)) closeMenu()
}
async function jump(id: string) {
  closeMenu()
  if (
    product.value === 'entertainment' &&
    studioChapters.some((item) => item.id === id)
  ) {
    studio.value?.jump(id)
    return
  }
  if (
    officeSections.some(([key]) => key === id) &&
    product.value !== 'office'
  ) {
    await router.push(productLocation('office'))
  }
  await nextTick()
  const section = document.getElementById(id)
  if (!section) return
  section.setAttribute('tabindex', '-1')
  section.focus({ preventScroll: true })
  section.scrollIntoView({
    behavior: matchMedia('(prefers-reduced-motion: reduce)').matches
      ? 'instant'
      : 'smooth',
    block: 'start',
  })
}
watch(
  product,
  () => {
    closeMenu()
    window.scrollTo(0, 0)
  },
  { flush: 'post' },
)
onMounted(() => document.addEventListener('pointerdown', outside))
onBeforeUnmount(() => document.removeEventListener('pointerdown', outside))
</script>

<template>
  <div
    class="starbridge-public product-website"
    :class="{ 'studio-landing': product === 'entertainment' }"
    :data-product="product"
  >
    <a
      class="skip"
      href="#website-main"
      @click.prevent="jump('website-main')"
      >{{ tr('跳至主要内容', 'Skip to main content') }}</a
    >
    <header class="masthead">
      <div class="mast-inner">
        <PublicBrand />
        <nav
          class="product-nav"
          :aria-label="tr('浏览产品', 'Browse products')"
        >
          <router-link
            v-for="item in products"
            :key="item.key"
            v-slot="{ href, navigate }"
            custom
            :to="productLocation(item.key)"
          >
            <a
              :href="href"
              :aria-current="product === item.key ? 'page' : undefined"
              @click="navigate"
              >{{ tr(item.title[0], item.title[1]) }}</a
            >
          </router-link>
        </nav>
        <div class="public-actions">
          <router-link class="mast-cta" to="/products"
            ><AppIcon name="panel-left" /><span>{{
              tr('选择工作台', 'Workspaces')
            }}</span></router-link
          >
          <div
            ref="menu"
            class="site-utilities"
            @keydown.esc.stop="closeMenu(true)"
            @focusout="
              !menu?.contains($event.relatedTarget as Node) && closeMenu()
            "
          >
            <button
              ref="menuButton"
              type="button"
              class="utility-button"
              :aria-expanded="menuOpen"
              aria-controls="website-navigation"
              :aria-label="tr('打开导航', 'Open navigation')"
              @click="menuOpen = !menuOpen"
            >
              <AppIcon name="menu" />
            </button>
            <nav
              v-if="menuOpen"
              id="website-navigation"
              class="utility-menu"
              :aria-label="tr('官网导航', 'Website navigation')"
            >
              <a
                v-for="[id, zh, en] in sections"
                :key="id"
                :href="`#${id}`"
                @click.prevent="jump(id)"
                >{{ tr(zh, en) }}</a
              >
              <router-link to="/privacy">{{
                tr('隐私说明', 'Privacy notice')
              }}</router-link>
              <button
                type="button"
                @click="
                  preferences.locale =
                    preferences.locale === 'zh-CN' ? 'en' : 'zh-CN'
                "
              >
                {{ preferences.locale === 'zh-CN' ? 'English' : '中文' }}
              </button>
            </nav>
          </div>
        </div>
      </div>
    </header>
    <main id="website-main" tabindex="-1">
      <StudioShowcase v-if="product === 'entertainment'" ref="studio" />
      <template v-else
        ><OfficeShowcase @jump="jump" /><OfficeResources
      /></template>
    </main>
    <footer v-if="product === 'office'" class="site-footer wrap">
      <b>{{ tr('星桥', 'Starbridge') }} <span>STARBRIDGE</span></b>
      <div>
        <router-link to="/privacy">{{
          tr('隐私说明', 'Privacy notice')
        }}</router-link>
        <router-link to="/products"
          >{{ tr('选择工作台', 'Workspaces') }} <AppIcon name="arrow-right"
        /></router-link>
      </div>
    </footer>
  </div>
</template>
