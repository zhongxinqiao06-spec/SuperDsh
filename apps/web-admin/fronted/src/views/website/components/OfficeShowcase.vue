<script setup lang="ts">
import AppIcon from '@/components/base/AppIcon.vue'
import StarbridgeMark from '@/components/base/StarbridgeMark.vue'
import { usePreferences } from '@/store/modules/preferences'
import {
  peakMonthSales,
  salesExampleDownload,
  salesMonths,
  salesQuarter,
  salesRegions,
} from '@/utils/website/sales-example'

/** 简报、月度图和明细共用公开样表，下载无需账号。 */
const { tr } = usePreferences()
defineEmits<{ jump: [id: string] }>()
</script>

<template>
  <section class="office-hero wrap" aria-labelledby="office-title">
    <div class="office-copy">
      <p class="office-caption"><span></span>STARBRIDGE OFFICE</p>
      <h1 id="office-title">
        {{ tr('从经营数据', 'From data') }}<br />{{
          tr('到可编辑的', 'to an editable ')
        }}<span>{{ tr('简报', 'brief') }}</span>
      </h1>
      <p class="office-lede">
        {{
          tr(
            '把团队资料、分析口径和企业模板带进会话，',
            'Bring team documents, definitions and templates into your conversation.',
          )
        }}<br class="wide-break" />{{
          tr(
            '核对来源，交付可以接着修改的工作文件。',
            ' Verify sources and deliver files you can keep editing.',
          )
        }}
      </p>
      <div class="office-actions">
        <router-link class="button button-blue" to="/office"
          >{{ tr('进入办公台', 'Open Office') }}
          <AppIcon name="arrow-right" class="diagonal-arrow"
        /></router-link>
        <a
          class="secondary-link"
          href="#office-case"
          @click.prevent="$emit('jump', 'office-case')"
          >{{ tr('查看样表', 'View sample data') }}
          <AppIcon name="arrow-up" class="down-arrow"
        /></a>
      </div>
    </div>
    <section
      class="office-preview"
      :aria-label="tr('星桥办公简报样例', 'Starbridge Office sample report')"
    >
      <div class="office-preview-bar">
        <span
          ><StarbridgeMark class="brand-mark" />{{
            tr('星桥办公', 'Starbridge Office')
          }}</span
        ><span>{{ tr('文件预览', 'File preview') }}</span>
      </div>
      <div class="report-sheet">
        <div class="report-cover-id">
          <b>{{ tr('星河商贸', 'Xinghe Trading') }}</b
          ><span>{{ tr('虚构样例', 'Fictional example') }}</span>
        </div>
        <h2>{{ tr('第三季度经营简报', 'Third-quarter business brief') }}</h2>
        <div class="report-main">
          <div class="report-stat">
            <span>{{ tr('季度销售额', 'Quarterly sales') }}</span
            ><strong
              >{{ salesQuarter.toFixed(1)
              }}<small>{{ tr('万元', '× RMB 10,000') }}</small></strong
            >
          </div>
          <img
            src="/images/website/paper.webp"
            :alt="
              tr(
                '经营简报与桌面文具',
                'Business reports and stationery on a desk',
              )
            "
            fetchpriority="high"
          />
        </div>
        <div class="report-trend">
          <div v-for="item in salesMonths" :key="item.month[0]">
            <span>{{ tr(item.month[0], item.month[1]) }}</span
            ><i
              :style="{ '--ratio': (item.total / peakMonthSales) * 100 + '%' }"
            ></i
            ><b>{{ item.total.toFixed(1) }}</b>
          </div>
        </div>
      </div>
    </section>
  </section>
  <section
    id="office-case"
    class="office-case wrap"
    aria-labelledby="office-case-title"
  >
    <div class="office-case-heading">
      <div>
        <span class="case-kicker">{{ tr('办公样例', 'Office example') }}</span>
        <h2 id="office-case-title">
          {{ tr('第三季度销售明细', 'Quarterly sales detail') }}
        </h2>
      </div>
      <a class="text-link" :href="salesExampleDownload" download
        >{{ tr('下载示例 CSV', 'Download CSV') }}
        <AppIcon name="arrow-up" class="down-arrow"
      /></a>
    </div>
    <table>
      <caption>
        {{
          tr(
            '星河商贸 · 虚构演示数据，单位为万元',
            'Xinghe Trading · Fictional data in units of RMB 10,000',
          )
        }}
      </caption>
      <thead>
        <tr>
          <th scope="col">{{ tr('月份', 'Month') }}</th>
          <th v-for="region in salesRegions" :key="region[0]" scope="col">
            {{ tr(region[0], region[1]) }}
          </th>
          <th scope="col">{{ tr('合计', 'Total') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in salesMonths" :key="item.month[0]">
          <th scope="row">{{ tr(item.month[0], item.month[1]) }}</th>
          <td v-for="(value, i) in item.sales" :key="i">
            {{ value.toFixed(1) }}
          </td>
          <td>{{ item.total.toFixed(1) }}</td>
        </tr>
      </tbody>
    </table>
  </section>
</template>
