<script setup lang="ts">
import PageHeader from '@/components/layout/PageHeader.vue'
import { usePreferences } from '@/store/modules/preferences'
import SettingsCard from '@/components/settings/SettingsCard.vue'
/** 外观与工作台侧栏偏好即时生效，只持久化非敏感设置。 */
const preferences = usePreferences()
</script>
<template>
  <section class="page settings-page">
    <PageHeader
      :title="preferences.tr('外观与语言', 'Appearance and language')"
    />
    <SettingsCard :title="preferences.tr('外观', 'Appearance')"
      ><div class="appearance-options">
        <label
          v-for="choice in [
            {
              value: 'light',
              title: ['浅色', 'Light'],
              description: ['明亮界面', 'Light appearance'],
            },
            {
              value: 'dark',
              title: ['深色', 'Dark'],
              description: ['暗色界面', 'Dark appearance'],
            },
            {
              value: 'system',
              title: ['自动', 'System'],
              description: ['跟随系统', 'Follow system'],
            },
          ]"
          :key="choice.value"
          class="appearance-option"
          ><input
            v-model="preferences.theme"
            type="radio"
            name="theme"
            :value="choice.value"
            :aria-label="
              preferences.tr(choice.title[0] ?? '', choice.title[1] ?? '')
            "
          /><span
            >{{ preferences.tr(choice.title[0] ?? '', choice.title[1] ?? '')
            }}<small>{{
              preferences.tr(
                choice.description[0] ?? '',
                choice.description[1] ?? '',
              )
            }}</small></span
          ></label
        >
      </div></SettingsCard
    >
    <SettingsCard
      :title="preferences.tr('侧边栏', 'Sidebar')"
      :description="
        preferences.tr(
          '选择侧边栏中会话的组织方式。',
          'Choose how sessions are organized in the sidebar.',
        )
      "
      ><div class="settings-row">
        <div>
          {{ preferences.tr('侧边栏显示会话', 'Show sessions in sidebar') }}
          <p>
            {{
              preferences.tr(
                '直接显示会话，而不是按项目分组显示。',
                'Show sessions directly instead of project groups.',
              )
            }}
          </p>
        </div>
        <el-switch
          v-model="preferences.sidebarSessions"
          :aria-label="
            preferences.tr('侧边栏显示会话', 'Show sessions in sidebar')
          "
        /></div
    ></SettingsCard>
    <SettingsCard
      :title="preferences.tr('语言', 'Language')"
      :description="
        preferences.tr(
          '选择此浏览器的界面语言。',
          'Choose the interface language for this browser.',
        )
      "
      ><template #action
        ><el-select
          v-model="preferences.locale"
          class="settings-language"
          :aria-label="preferences.tr('语言', 'Language')"
          ><el-option value="zh-CN" label="简体中文" /><el-option
            value="en"
            label="English" /></el-select></template
    ></SettingsCard>
  </section>
</template>
