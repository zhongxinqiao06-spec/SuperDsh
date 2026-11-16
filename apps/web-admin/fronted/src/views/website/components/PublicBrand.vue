<script setup lang="ts">
import StarbridgeMark from '@/components/base/StarbridgeMark.vue'
import { usePreferences } from '@/store/modules/preferences'

/** 官网、登录和启动页共用同一个品牌入口。 */
const { tr } = usePreferences()
</script>

<template>
  <router-link
    to="/"
    class="brand"
    :aria-label="tr('星桥官网首页', 'Starbridge home')"
  >
    <StarbridgeMark class="brand-mark" />
    <b>{{ tr('星桥', 'Starbridge') }}</b
    ><span aria-hidden="true">STARBRIDGE</span>
  </router-link>
</template>
