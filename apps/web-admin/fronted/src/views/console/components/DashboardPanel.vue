<script setup lang="ts">
import PageHeader from '@/components/layout/PageHeader.vue'
import { computed, ref } from 'vue'
import { useDashboard } from '@/composables/console/use-dashboard'
import { usePreferences } from '@/store/modules/preferences'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
import AppIcon from '@/components/base/AppIcon.vue'
import DashboardTrend from '@/views/console/components/DashboardTrend.vue'
/** 运营看板沿用旧端的分类导航；统计请求与配置保存仍由原用例负责。 */
const vm = useDashboard(),
  { tr } = usePreferences()
const categories = [
  ['overview', '概览', 'Overview', 'chart-no-axes-combined'],
  ['usage', '使用', 'Usage', 'gauge'],
  ['users', '用户', 'Users', 'users'],
  ['devices', '设备', 'Devices', 'monitor'],
  ['agents', 'Agent', 'Agents', 'bot'],
] as const
const tab = ref<(typeof categories)[number][0]>('overview')
const metrics: Array<[string, string, string]> = [
  ['totalUsers', '总用户', 'Total users'],
  ['newUsers', '新增用户', 'New users'],
  ['dau', '日活跃', 'Daily active'],
  ['activeUsers', '范围活跃', 'Active users'],
  ['wau', '周活跃', 'Weekly active'],
  ['mau', '月活跃', 'Monthly active'],
  ['totalMessages', '消息数', 'Messages'],
  ['activeSessions', '活跃会话', 'Active sessions'],
  ['avgMessagesPerActiveUser', '人均消息', 'Messages per active user'],
  ['avgActiveSessionsPerActiveUser', '人均会话', 'Sessions per active user'],
  ['totalDevices', '设备总数', 'Total devices'],
  ['avgDevicesPerUser', '人均设备', 'Devices per user'],
]
const segments: Record<string, string[]> = {
  inactive: ['未活跃', 'Inactive'],
  light: ['轻度', 'Light'],
  medium: ['中度', 'Medium'],
  heavy: ['重度', 'Heavy'],
}
const metricKeys: Record<(typeof categories)[number][0], string[]> = {
  overview: ['dau', 'activeUsers', 'totalMessages', 'activeSessions'],
  usage: ['avgMessagesPerActiveUser', 'avgActiveSessionsPerActiveUser'],
  users: ['totalUsers', 'dau', 'activeUsers', 'newUsers', 'mau', 'wau'],
  devices: ['avgDevicesPerUser', 'totalDevices'],
  agents: [],
}
const visibleMetrics = computed(() =>
  metrics.filter(([key]) => metricKeys[tab.value].includes(key)),
)
const breakdownLabels: Array<
  [
    'deviceBreakdown' | 'agentBreakdown' | 'sessionAgentBreakdown',
    string,
    string,
  ]
> = [
  ['deviceBreakdown', '设备类型', 'Device types'],
  ['agentBreakdown', '消息智能体', 'Message agents'],
  ['sessionAgentBreakdown', '会话智能体', 'Session agents'],
]
const breakdownPanels = computed(() =>
  breakdownLabels.filter(([key]) =>
    tab.value === 'devices'
      ? key === 'deviceBreakdown'
      : key !== 'deviceBreakdown',
  ),
)
</script>
<template>
  <section class="page dashboard-page">
    <PageHeader :title="tr('看板', 'Dashboard')" />
    <form
      class="toolbar toolbar-panel dashboard-filters"
      @submit.prevent="vm.resource.reload"
    >
      <label class="field"
        >{{ tr('开始日期', 'From')
        }}<el-input v-model="vm.query.from" type="date" /></label
      ><label class="field"
        >{{ tr('结束日期', 'To')
        }}<el-input v-model="vm.query.to" type="date" /></label
      ><label class="field"
        >{{ tr('时区', 'Timezone') }}<el-input v-model="vm.query.tz" /></label
      ><el-button native-type="submit" :loading="vm.resource.loading.value">{{
        tr('查询', 'Apply')
      }}</el-button
      ><el-button @click="vm.openSettings">{{
        tr('统计设置', 'Statistics settings')
      }}</el-button
      ><el-button :loading="vm.mutation.busy.value" @click="vm.snapshot">{{
        tr('重算结束日期快照', 'Recompute end-date snapshot')
      }}</el-button>
    </form>
    <div class="dashboard-workspace">
      <nav
        class="dashboard-categories"
        :aria-label="tr('看板分类', 'Dashboard categories')"
      >
        <button
          v-for="[id, zh, en, icon] in categories"
          :key="id"
          type="button"
          :class="{ active: tab === id }"
          :aria-current="tab === id ? 'page' : undefined"
          @click="tab = id"
        >
          <AppIcon :name="icon" />{{ tr(zh, en) }}
        </button>
      </nav>
      <div class="dashboard-content stack">
        <ResourceStatus
          :loading="vm.resource.loading.value"
          :error="vm.resource.error.value || vm.mutation.error.value"
          @retry="vm.resource.reload"
        />
        <template v-if="vm.resource.data.value"
          ><div v-if="visibleMetrics.length" class="dashboard-metrics">
            <article
              v-for="[key, zh, en] in visibleMetrics"
              :key="key"
              class="panel"
            >
              <span class="muted">{{ tr(zh, en) }}</span
              ><strong>{{ vm.resource.data.value.summary[key] ?? '—' }}</strong>
            </article>
          </div>
          <DashboardTrend
            v-if="tab === 'overview' || tab === 'users'"
            :series="vm.resource.data.value.series"
            :users="tab === 'users'"
          />
          <div v-if="tab === 'usage'" class="dashboard-distributions">
            <div
              v-for="[key, zh, en] in [
                ['messageHistogram', '消息分布', 'Message distribution'],
                ['sessionHistogram', '会话分布', 'Session distribution'],
              ] as const"
              :key="key"
              class="panel"
            >
              <h2>{{ tr(zh, en) }}</h2>
              <div
                v-for="bin in vm.resource.data.value[key]"
                :key="bin.key"
                class="histogram-row"
              >
                <span>{{ bin.label }}</span
                ><meter
                  min="0"
                  :max="
                    Math.max(vm.resource.data.value.summary.totalUsers ?? 0, 1)
                  "
                  :value="bin.count"
                  :aria-label="bin.label"
                /><strong>{{ bin.count }}</strong>
              </div>
            </div>
            <div class="panel">
              <h2>{{ tr('用户活跃分层', 'Activity segments') }}</h2>
              <dl class="details">
                <template
                  v-for="item in vm.resource.data.value.userSegments"
                  :key="item.segment"
                  ><dt>
                    {{
                      tr(
                        segments[item.segment]?.[0] ?? item.segment,
                        segments[item.segment]?.[1] ?? item.segment,
                      )
                    }}
                  </dt>
                  <dd>{{ item.count }}</dd></template
                >
              </dl>
            </div>
          </div>
          <div
            v-if="tab === 'devices' || tab === 'agents'"
            class="dashboard-distributions"
          >
            <div
              v-for="[key, zh, en] in breakdownPanels"
              :key="key"
              class="panel"
            >
              <h2>{{ tr(zh, en) }}</h2>
              <el-empty
                v-if="!vm.resource.data.value[key].length"
                :description="tr('暂无记录', 'No records')"
              />
              <div
                v-for="item in vm.resource.data.value[key]"
                :key="item.key"
                class="histogram-row"
              >
                <span>{{ item.label }}</span
                ><meter
                  min="0"
                  max="100"
                  :value="item.percent"
                  :aria-label="item.label"
                /><span>{{ item.value }} · {{ item.percent }}%</span>
              </div>
            </div>
          </div>
        </template>
      </div>
    </div>
    <ManagementDialog
      v-model="vm.editing.value"
      :title="tr('统计设置', 'Statistics settings')"
      :busy="vm.mutation.busy.value"
      :error="vm.mutation.error.value"
      @submit="vm.saveSettings"
      ><label class="field"
        >{{ tr('轻度用户消息上限', 'Light activity message limit')
        }}<el-input-number
          v-model="vm.settings.value.intensity.lightMax"
          :min="0" /></label
      ><label class="field"
        >{{ tr('中度用户消息上限', 'Medium activity message limit')
        }}<el-input-number
          v-model="vm.settings.value.intensity.mediumMax"
          :min="vm.settings.value.intensity.lightMax" /></label
      ><label class="field"
        >{{
          tr(
            '消息分段边界（逗号分隔）',
            'Message bin boundaries (comma-separated)',
          )
        }}<el-input v-model="vm.bins.messages" /></label
      ><label class="field"
        >{{
          tr(
            '会话分段边界（逗号分隔）',
            'Session bin boundaries (comma-separated)',
          )
        }}<el-input v-model="vm.bins.sessions" /></label
    ></ManagementDialog>
  </section>
</template>
