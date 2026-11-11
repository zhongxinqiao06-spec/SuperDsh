<script setup lang="ts">
import { computed } from 'vue'
import type { DashboardOverview } from '@/types/service/system'
import { dashboardChart } from '@/utils/console/dashboard-chart'
import { usePreferences } from '@/store/modules/preferences'

/** 趋势图只呈现统计接口数据；保留可展开的表格，便于精确读取与键盘访问。 */
const props = defineProps<{
  series: DashboardOverview['series']
  users?: boolean
}>()
const { tr } = usePreferences()
const columns = computed<Array<[string, string, string]>>(() =>
  props.users
    ? [
        ['dau', '日活跃用户', 'Daily active users'],
        ['activeUsers', '活跃用户', 'Active users'],
        ['newUsers', '新增用户', 'New users'],
      ]
    : [
        ['dau', '日活跃用户', 'Daily active users'],
        ['activeUsers', '活跃用户', 'Active users'],
        ['totalMessages', '消息数', 'Messages'],
        ['activeSessions', '活跃会话', 'Active sessions'],
      ],
)
const chart = computed(() =>
  dashboardChart(
    props.series,
    columns.value.map(([key]) => key),
  ),
)
</script>
<template>
  <section class="dashboard-chart-panel" :class="{ 'chart-users': users }">
    <header>
      <h2>
        {{
          users ? tr('用户趋势', 'User trend') : tr('指标趋势', 'Metric trend')
        }}
      </h2>
    </header>
    <div class="dashboard-chart-body">
      <p v-if="!series.length" class="muted">
        {{ tr('暂无记录', 'No records') }}
      </p>
      <svg
        v-else
        :viewBox="`0 0 ${chart.width} ${chart.height}`"
        class="dashboard-trend"
        role="img"
        :aria-label="
          tr(
            '所选时间范围内的每日指标趋势',
            'Daily metrics in the selected date range',
          )
        "
      >
        <g v-for="tick in chart.ticks" :key="tick.y" class="chart-grid">
          <line :x1="chart.left" :x2="chart.right" :y1="tick.y" :y2="tick.y" />
          <text :x="chart.left - 10" :y="tick.y + 4" text-anchor="end">
            {{ Number(tick.value.toFixed(1)) }}
          </text>
        </g>
        <g
          v-for="(line, index) in chart.lines"
          :key="line.key"
          :class="`chart-series chart-series-${index}`"
        >
          <polygon v-if="line.area" :points="line.area" />
          <polyline :points="line.stroke" />
          <circle
            v-for="point in line.points"
            :key="point.date"
            :cx="point.x"
            :cy="point.y"
            :r="line.points.length === 1 ? 3 : 2"
          >
            <title>
              {{ point.date }} ·
              {{ tr(columns[index]![1]!, columns[index]![2]!) }}:
              {{ point.value }}
            </title>
          </circle>
        </g>
        <text
          v-for="date in chart.dates"
          :key="date.label"
          :x="date.x"
          :y="chart.baseline + 24"
          text-anchor="middle"
          class="chart-date"
        >
          {{ date.label.slice(5) }}
        </text>
      </svg>
      <div class="chart-legend">
        <span
          v-for="([key, zh, en], index) in columns"
          :key="key"
          :class="`chart-series-${index}`"
          ><i />{{ tr(zh!, en!) }}</span
        >
      </div>
      <details class="chart-data">
        <summary>{{ tr('查看每日明细', 'View daily data') }}</summary>
        <el-table :data="series"
          ><el-table-column
            prop="date"
            :label="tr('日期', 'Date')" /><el-table-column
            v-for="[key, zh, en] in columns"
            :key="key"
            :prop="key"
            :label="tr(zh!, en!)"
        /></el-table>
      </details>
    </div>
  </section>
</template>
