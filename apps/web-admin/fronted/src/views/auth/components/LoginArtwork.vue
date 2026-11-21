<script setup lang="ts">
import PublicBrand from '@/views/website/components/PublicBrand.vue'
import { usePreferences } from '@/store/modules/preferences'

/** 认证页的公开剧照。胶片边光与原图共用画布坐标，响应式裁切时同步移动。 */
const { tr } = usePreferences()
</script>
<template>
  <aside class="login-art" :aria-label="tr('星桥', 'Starbridge')">
    <div class="film-exposure" aria-hidden="true">
      <div class="film-negative">
        <img
          src="/images/website/login-mirror-lake.jpg"
          alt=""
          width="989"
          height="906"
          fetchpriority="high"
        />
        <svg class="film-edge" viewBox="0 0 989 906" focusable="false">
          <defs>
            <filter
              id="login-halation"
              x="-8%"
              y="-15%"
              width="116%"
              height="130%"
            >
              <feGaussianBlur stdDeviation="3" />
            </filter>
          </defs>
          <path
            pathLength="100"
            class="glow"
            stroke-width="6"
            filter="url(#login-halation)"
            d="M-4 473C173 381 395 350 528 341S810 322 900 289Q953 266 925 233"
          />
          <path
            pathLength="100"
            stroke-width="1.6"
            d="M-4 473C173 381 395 350 528 341S810 322 900 289Q953 266 925 233"
          />
          <path
            class="reflection"
            pathLength="100"
            stroke-width="2"
            filter="url(#login-halation)"
            d="M48 905C294 813 467 724 660 612S891 477 947 407"
          />
        </svg>
      </div>
    </div>
    <PublicBrand class="film-brand" label="星桥" />
    <p class="film-caption">
      {{ tr('故事短片 · 镜湖', 'Short film · Mirror Lake') }}
    </p>
  </aside>
</template>
<style scoped>
.login-art {
  position: relative;
  overflow: hidden;
  isolation: isolate;
  min-width: 0;
  background: var(--showcase-projector);
  color: var(--showcase-poster-canvas);
}
.film-exposure {
  position: absolute;
  inset: 0;
  container-type: size;
  animation: film-project 24s ease-in-out infinite alternate;
}
.film-negative {
  position: absolute;
  width: max(100cqw, 109.1612cqh);
  aspect-ratio: 989/906;
  left: 52%;
  top: 58%;
  transform: translate(-52%, -58%);
}
.film-negative img,
.film-edge {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
}
.film-edge {
  mix-blend-mode: screen;
  pointer-events: none;
}
.film-edge path {
  fill: none;
  stroke: var(--showcase-pencil-paper);
  stroke-linecap: round;
  stroke-dasharray: 8 116;
  animation: film-edge-pass 9s cubic-bezier(0.36, 0.12, 0.45, 0.95) infinite;
}
.film-edge .glow {
  stroke: var(--orange-400);
}
.film-edge .reflection {
  stroke: var(--showcase-playhead);
  stroke-dasharray: 4 120;
  animation-delay: -3s;
  animation-duration: 13s;
}
@keyframes film-edge-pass {
  0% {
    stroke-dashoffset: 10;
    opacity: 0;
  }
  12%,
  79% {
    opacity: 0.85;
  }
  94%,
  100% {
    stroke-dashoffset: -103;
    opacity: 0;
  }
}
@keyframes film-project {
  to {
    transform: scale(1.024) translateX(-0.35%);
  }
}
.login-art::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background:
    linear-gradient(145deg, rgb(26 24 22 / 58%), transparent 27%),
    linear-gradient(0deg, rgb(34 25 19 / 38%), transparent 13%);
}
.film-brand,
.film-caption {
  position: absolute;
  z-index: 1;
  left: clamp(26px, 3.7vw, 76px);
  display: flex;
  align-items: center;
  gap: var(--control-gap);
}
.film-brand {
  top: clamp(25px, 4.4vh, 52px);
  color: inherit;
}
.film-brand :deep(.brand-mark) {
  width: 30px;
  height: 30px;
}
.film-brand :deep(b) {
  font: 600 22px var(--showcase-display-font);
  letter-spacing: 0.05em;
}
.film-brand :deep(span) {
  margin-left: 3px;
  font-size: 9px;
  letter-spacing: 0.19em;
}
.film-caption {
  bottom: 29px;
  margin: 0;
  font-size: 11px;
  letter-spacing: 0.13em;
}
.film-caption::before {
  content: '';
  width: 24px;
  height: 1px;
  background: var(--showcase-playhead);
}
@media (max-width: 760px) {
  .login-art {
    min-height: clamp(144px, 24svh, 208px);
  }
  .film-negative {
    left: 50%;
    top: 67%;
    transform: translate(-50%, -67%);
  }
  .film-brand {
    top: var(--space-4);
    left: 22px;
  }
  .film-brand :deep(.brand-mark) {
    width: 25px;
    height: 25px;
  }
  .film-brand :deep(b) {
    font-size: 18px;
  }
  .film-caption {
    display: none;
  }
}
@media (prefers-reduced-motion: reduce) {
  .film-exposure,
  .film-edge path {
    animation: none;
  }
  .film-edge {
    display: none;
  }
}
</style>
