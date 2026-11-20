<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import { studioArtwork as art } from '@/utils/website/studio-showcase'

/** 画格和齿孔共用闭合轨道及片速。暂停整个 SVG 时会保留走片位置。 */
const props = defineProps<{ playing: boolean; gallery?: boolean }>()
const reel = ref<SVGSVGElement>()
const uid = 'film-' + useId().replace(/[^\w-]/g, '')
const trackId = uid + '-track'
const maskId = uid + '-perforations'
const tintId = uid + '-tint'
const film = [art.world, art.forest, art.premiere, art.character, art.portrait]
const frames = 36
const seconds = 72
const phone = matchMedia('(max-width: 900px)')
const narrow = ref(phone.matches)
const track = computed(() =>
  props.gallery
    ? 'M 8 312 C 12 154 214 69 406 65 S 750 -32 889 22 S 1004 280 962 368 S 770 365 610 423 S 283 515 123 466 S -6 385 8 312 Z'
    : narrow.value
      ? 'M 30 168 C 5 78 190 14 340 54 S 718 178 920 73 C 1040 8 1007 313 925 356 S 655 447 420 406 S 76 333 30 168 Z'
      : 'M 409 256 C 405 145 447 59 544 31 S 894 -12 951 38 C 1013 91 1016 203 964 255 S 786 341 638 344 C 489 348 359 293 212 308 S 8 346 17 397 C 29 470 239 480 440 448 S 747 332 888 348 C 996 360 1022 433 939 456 S 689 486 562 426 S 410 337 409 256 Z',
)
function syncMotion() {
  if (props.playing && !document.hidden) reel.value?.unpauseAnimations()
  else reel.value?.pauseAnimations()
}
function resize() {
  narrow.value = phone.matches
}
watch(() => props.playing, syncMotion)
onMounted(() => {
  // 在动效初始即暂停时也先采样轨道位置，避免所有画格堆叠在 SVG 原点。
  reel.value?.setCurrentTime(0.02)
  syncMotion()
  phone.addEventListener('change', resize)
  document.addEventListener('visibilitychange', syncMotion)
})
onBeforeUnmount(() => {
  phone.removeEventListener('change', resize)
  document.removeEventListener('visibilitychange', syncMotion)
})
</script>

<template>
  <svg
    ref="reel"
    class="premiere-film-loop"
    viewBox="0 0 1000 500"
    preserveAspectRatio="none"
    aria-hidden="true"
    focusable="false"
  >
    <defs>
      <path :id="trackId" :d="track" pathLength="2880" fill="none" />
      <linearGradient :id="tintId" x1="0" x2="1" y1="0" y2=".7">
        <stop offset="0" stop-color="var(--showcase-accent)" />
        <stop offset=".31" stop-color="var(--showcase-peach)" />
        <stop offset=".55" stop-color="var(--showcase-accent)" />
        <stop offset=".78" stop-color="var(--showcase-playhead)" />
        <stop offset="1" stop-color="var(--showcase-accent)" />
      </linearGradient>
      <mask
        :id="maskId"
        maskUnits="userSpaceOnUse"
        x="-50"
        y="-50"
        width="1100"
        height="600"
      >
        <rect x="-50" y="-50" width="1100" height="600" fill="white" />
        <use
          :href="'#' + trackId"
          stroke="black"
          stroke-width="26"
          stroke-dasharray="3 5"
        >
          <animate
            attributeName="stroke-dashoffset"
            from="0"
            to="-2880"
            :dur="seconds + 's'"
            repeatCount="indefinite"
          />
        </use>
        <use :href="'#' + trackId" stroke="white" stroke-width="20" />
      </mask>
      <image
        v-for="(src, index) in film"
        :id="uid + '-still-' + index"
        :key="src"
        :href="src"
        x="-23"
        y="-8.5"
        width="46"
        height="17"
        preserveAspectRatio="xMidYMid slice"
      />
    </defs>
    <g :mask="'url(#' + maskId + ')'">
      <use
        :href="'#' + trackId"
        stroke="var(--showcase-accent)"
        stroke-width="30"
      />
      <use
        :href="'#' + trackId"
        :stroke="'url(#' + tintId + ')'"
        stroke-width="28.5"
      />
      <g v-for="n in frames" :key="n" opacity=".54">
        <use :href="'#' + uid + '-still-' + ((n - 1) % film.length)" />
        <animateMotion
          :dur="seconds + 's'"
          :begin="(-(n - 1) * seconds) / frames + 's'"
          repeatCount="indefinite"
          rotate="auto"
          calcMode="paced"
        >
          <mpath :href="'#' + trackId" />
        </animateMotion>
      </g>
    </g>
  </svg>
</template>
