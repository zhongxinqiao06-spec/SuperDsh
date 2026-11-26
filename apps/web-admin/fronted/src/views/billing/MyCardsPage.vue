<script setup lang="ts">
import PageHeader from '@/components/layout/PageHeader.vue'
import SettingsCard from '@/components/settings/SettingsCard.vue'
import { usePreferences } from '@/store/modules/preferences'
import CreditCards from './components/CreditCards.vue'
import '@/assets/styles/billing.css'
const { tr } = usePreferences()
</script>
<template>
  <section class="page settings-page billing-page">
    <PageHeader :title="tr('我的额度卡', 'My credit cards')" />
    <SettingsCard :title="tr('持卡明细', 'Card activity')"
      ><CreditCards
    /></SettingsCard>
  </section>
</template>
