<script setup lang="ts">
import { planQuotaLabel } from '@/utils/billing/plan-quota-label'
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
import { useCatalogEditor } from '@/composables/billing/use-catalog-editor'
import { usePreferences } from '@/store/modules/preferences'
import type { PlanSeries } from '@/types/billing/catalog'
import type { PlanDraft } from '@/types/billing/pricing'
import { billingTime } from '@/utils/billing/change-labels'
const props = defineProps<{
  series: PlanSeries | null
  withdraw: boolean
  stored?: PlanDraft
}>()
const emit = defineEmits<{
  close: []
  saved: [draftOnly: boolean]
  refresh: []
}>()
const { tr } = usePreferences()
const { draft, dirty, review, mutation, valid, submit } = useCatalogEditor(
  props.series,
  props.withdraw,
  (draftOnly) => emit('saved', draftOnly),
  props.stored,
)
</script>
<template>
  <ManagementDialog
    :model-value="true"
    :title="
      withdraw
        ? tr('撤回待生效版本', 'Withdraw scheduled version')
        : series
          ? tr('发布套餐版本', 'Publish plan version')
          : tr('新增套餐', 'Create plan')
    "
    :busy="mutation.busy.value"
    :error="mutation.error.value"
    :submit-disabled="!valid"
    :dirty="dirty"
    :submit-text="
      withdraw
        ? tr('确认撤回', 'Withdraw version')
        : review
          ? tr('确认发布', 'Confirm publication')
          : tr('核对发布', 'Review publication')
    "
    @submit="submit()"
    @update:model-value="!$event && emit('close')"
  >
    <fieldset
      class="form-stack billing-operation-fields"
      :disabled="mutation.busy.value"
    >
      <template v-if="withdraw && series?.upcoming">
        <strong
          >{{ series.upcoming.name }} · {{ series.latest.sku }} · v{{
            series.upcoming.revision
          }}</strong
        >
        <p>
          {{ tr('原定生效时间', 'Scheduled for') }} ·
          {{ billingTime(series.upcoming.effectiveAt) }}
        </p>
        <p class="billing-note">
          {{
            tr(
              '撤回后继续沿用现有在售状态与权益。',
              'Withdrawing retains the current listing and entitlements.',
            )
          }}
        </p>
      </template>
      <template v-else-if="!review">
        <label class="field"
          >{{ tr('商品编码', 'Product code')
          }}<el-input
            v-model="draft.sku"
            :disabled="!!series || !!stored"
            maxlength="64"
            placeholder="creator"
        /></label>
        <small v-if="!series" class="billing-note">{{
          tr(
            '编码使用小写字母、数字、短横线或下划线，以字母或数字开头。',
            'Use lowercase letters, numbers, hyphens or underscores. Start with a letter or number.',
          )
        }}</small>
        <label class="field"
          >{{ tr('套餐名称', 'Plan name')
          }}<el-input v-model="draft.name" maxlength="80"
        /></label>
        <div class="billing-plans">
          <label class="field"
            >{{ tr('商品类型', 'Product type')
            }}<select
              v-model="draft.kind"
              :disabled="!!series"
              class="native-control"
            >
              <option value="membership">{{ tr('会员', 'Membership') }}</option>
              <option value="addon">{{ tr('加购包', 'Top-up') }}</option>
            </select></label
          >
          <label class="field"
            >{{ tr('权益期限', 'Term')
            }}<select v-model="draft.termUnit" class="native-control">
              <option value="month">{{ tr('一个月', 'One month') }}</option>
              <option value="year">{{ tr('一年', 'One year') }}</option>
            </select></label
          >
          <label class="field"
            >{{ tr('价格（元）', 'Price (CNY)')
            }}<el-input v-model="draft.price" inputmode="decimal"
          /></label>
          <label v-if="draft.kind === 'membership'" class="field"
            >{{ tr('每周额度', 'Weekly limit')
            }}<el-input v-model="draft.weeklyPoints" inputmode="numeric"
          /></label>
          <label class="field"
            >{{
              draft.kind === 'membership'
                ? tr('每月额度', 'Monthly limit')
                : tr('发放创作点', 'Credits per purchase')
            }}<el-input v-model="draft.points" inputmode="numeric"
          /></label>
        </div>
        <small v-if="draft.kind === 'membership'" class="billing-note">{{
          tr(
            '每周额度须在 1 至每月额度之间。年度会员按会员月重置。',
            'Weekly credits must be between 1 and the monthly limit. Annual plans reset each membership month.',
          )
        }}</small>
        <label class="field"
          >{{ tr('销售状态', 'Listing status')
          }}<select v-model="draft.listed" class="native-control">
            <option :value="true">{{ tr('上架', 'Listed') }}</option>
            <option v-if="series" :value="false">
              {{ tr('下架', 'Delisted') }}
            </option>
          </select></label
        >
        <label class="field"
          >{{ tr('生效方式', 'Effective date')
          }}<select v-model="draft.timing" class="native-control">
            <option value="now">{{ tr('立即生效', 'Immediately') }}</option>
            <option value="scheduled">{{ tr('定时生效', 'Schedule') }}</option>
          </select></label
        >
        <label v-if="draft.timing === 'scheduled'" class="field"
          >{{ tr('生效时间（北京时间）', 'Effective time (UTC+8)')
          }}<input
            v-model="draft.date"
            type="datetime-local"
            class="native-control"
        /></label>
      </template>
      <template v-else>
        <strong
          >{{ draft.name }} · {{ draft.sku }} · v{{
            (series?.latest.revision ?? 0) + 1
          }}</strong
        >
        <dl class="billing-details">
          <template v-if="series?.current"
            ><dt>{{ tr('当前版本', 'Current version') }}</dt>
            <dd>
              {{ series.current.name }} · ¥{{ series.current.priceFen / 100 }} ·
              {{ planQuotaLabel(series.current, tr) }}
              ·
              {{
                series.current.listed
                  ? tr('在售', 'Listed')
                  : tr('已下架', 'Delisted')
              }}
            </dd></template
          >
          <dt>{{ tr('发布后', 'New version') }}</dt>
          <dd>
            {{ draft.listed ? tr('上架', 'Listed') : tr('下架', 'Delisted') }} ·
            ¥{{ Number(draft.price) }} ·
            {{
              planQuotaLabel(
                {
                  kind: draft.kind,
                  points: Number(draft.points),
                  weeklyPoints: Number(draft.weeklyPoints),
                },
                tr,
              )
            }}
          </dd>
          <dt>{{ tr('生效时间', 'Effective time') }}</dt>
          <dd>
            {{
              draft.timing === 'now'
                ? tr('立即生效', 'Immediately')
                : billingTime(draft.date + '+08:00')
            }}
          </dd>
          <dt>{{ tr('发布原因', 'Reason') }}</dt>
          <dd>{{ draft.reason }}</dd>
        </dl>
        <p class="billing-note">
          {{
            tr(
              '已购周期按购买时的价格和点数履约。尚未办理的旧版预约需要重新核对。',
              'Purchased periods retain their original price and credits. Unbooked reservations for the replaced version require review.',
            )
          }}
        </p>
        <el-button @click="review = false">{{
          tr('返回编辑', 'Back to edit')
        }}</el-button>
      </template>
      <label v-if="!review" class="field"
        >{{
          withdraw
            ? tr('撤回原因', 'Withdrawal reason')
            : tr('发布原因', 'Publication reason')
        }}<el-input
          v-model="draft.reason"
          type="textarea"
          maxlength="300"
          show-word-limit
      /></label>
      <el-button v-if="mutation.error.value" @click="emit('refresh')">{{
        tr('刷新套餐目录', 'Refresh catalog')
      }}</el-button>
    </fieldset>
    <template v-if="!withdraw && !review" #footer-leading
      ><el-button
        :disabled="!valid || mutation.busy.value"
        @click="submit(true)"
        >{{ tr('保存草稿', 'Save draft') }}</el-button
      ></template
    >
  </ManagementDialog>
</template>
