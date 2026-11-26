<script setup lang="ts">
import '@/assets/styles/billing.css'
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
import { useOperation } from '@/composables/billing/use-operation'
import { usePreferences } from '@/store/modules/preferences'
import { billingLabel } from '@/utils/billing/labels'
import { billingTime } from '@/utils/billing/change-labels'
import type {
  BillingAction,
  BillingAccount,
  BillingOperation,
} from '@/types/billing/operations'
const props = defineProps<{
  account: BillingAccount
  initial: BillingAction
  cardOnly?: boolean
}>()
const emit = defineEmits<{ close: []; saved: [result: BillingOperation] }>()
const { tr } = usePreferences()
const {
  catalog,
  cardPoints,
  denominations,
  mutation,
  action,
  reason,
  points,
  days,
  payment,
  receipt,
  amount,
  planId,
  preview,
  plans,
  activePlan,
  valid,
  manual,
  member,
  selectedPayment,
  canReceipt,
  edit,
  submit,
} = useOperation(props.account, props.initial, (r) => emit('saved', r))
</script>
<template>
  <ManagementDialog
    :model-value="true"
    :title="
      member
        ? tr('会员办理', 'Manage membership')
        : action === 'card'
          ? tr('发放额度卡', 'Issue credit card')
          : tr('人工加额', 'Grant credits')
    "
    :busy="mutation.busy.value"
    :error="mutation.error.value"
    :dirty="!!reason && !preview?.confirmedAt"
    :submit-text="
      preview ? tr('确认办理', 'Confirm') : tr('预览办理', 'Preview')
    "
    :submit-disabled="!preview && !valid"
    @update:model-value="!$event && emit('close')"
    @submit="submit"
  >
    <fieldset
      class="form-stack billing-operation-fields"
      :disabled="mutation.busy.value"
    >
      <strong
        >{{ account.displayName || account.username }} ·
        {{ account.username }}</strong
      >
      <template v-if="!preview">
        <label v-if="!cardOnly" class="field"
          >{{ tr('办理类型', 'Action')
          }}<select
            v-model="action"
            class="native-control"
            :disabled="mutation.busy.value"
          >
            <template v-if="member"
              ><option v-if="account.state !== 'active'" value="open">
                {{ tr('开通会员', 'Activate') }}
              </option>
              <option v-else value="renew">
                {{ tr('提前续期', 'Renew') }}
              </option></template
            >
            <template v-else
              ><option value="gift">{{ tr('运营赠送', 'Gift') }}</option>
              <option value="card">
                {{ tr('发放额度卡', 'Issue credit card') }}
              </option>
              <option value="compensation">
                {{ tr('人工补偿', 'Compensation') }}
              </option>
              <option v-if="canReceipt" value="topup">
                {{ tr('线下加购', 'Offline top-up') }}
              </option></template
            >
          </select></label
        >
        <template v-if="manual">
          <template v-if="action === 'card'">
            <ResourceStatus
              :loading="catalog.loading.value"
              :error="catalog.error.value"
              @retry="catalog.reload"
            />
            <label class="field"
              >{{ tr('卡面额', 'Card value') }}
              <select v-model="cardPoints" class="native-control">
                <option v-for="n in denominations" :key="n" :value="n">
                  {{ n.toLocaleString() }} {{ tr('创作点', 'credits') }}
                </option>
              </select>
            </label>
            <small class="billing-note">{{
              tr(
                '每次发放一张，用户的普通创作点不足时自动抵扣差额。',
                'Issues one card. It automatically covers any shortfall after regular credits.',
              )
            }}</small>
          </template>
          <label v-else class="field"
            >{{ tr('发放点数', 'Credits to grant')
            }}<el-input-number
              v-model="points"
              :min="1"
              :max="1000000"
              :precision="0"
          /></label>
          <label class="field"
            >{{ tr('有效天数', 'Days valid')
            }}<el-input-number
              v-model="days"
              :min="1"
              :max="3650"
              :precision="0" /></label
        ></template>
        <template v-else
          ><ResourceStatus
            :loading="catalog.loading.value"
            :error="catalog.error.value"
            @retry="catalog.reload"
          />
          <p
            v-if="
              member &&
              account.planChange &&
              ['scheduled', 'due'].includes(account.planChange.state)
            "
            class="billing-note"
          >
            {{ tr('本次按预约档位办理', 'Reserved plan for this operation') }} ·
            {{ account.planChange.toPlanName }}
            <template
              v-if="
                !catalog.loading.value && !catalog.error.value && !plans.length
              "
              >{{
                tr(
                  '。原版本已更新或下架，请撤销预约后核对最新档位。',
                  '. This version is unavailable. Cancel the reservation to choose again.',
                )
              }}</template
            >
          </p>
          <p
            v-else-if="
              action === 'renew' &&
              !catalog.loading.value &&
              !catalog.error.value &&
              !plans.length
            "
            class="billing-note"
          >
            {{
              tr(
                '已购末期档位已下架，请先预约其他在售档位。',
                'The last booked tier is delisted. Schedule a change to an available tier first.',
              )
            }}
          </p>
          <label class="field"
            >{{ tr('办理商品', 'Product')
            }}<select v-model="planId" class="native-control">
              <option v-for="p in plans" :key="p.id" :value="p.id">
                {{ p.name }} · ¥{{ p.priceFen / 100 }} · {{ p.points }}
                {{ tr('点', 'credits') }}
              </option>
            </select></label
          >
          <label v-if="member" class="field"
            >{{ tr('办理方式', 'Payment mode')
            }}<select v-model="payment" class="native-control">
              <option value="complimentary">
                {{ tr('赠送会员', 'Complimentary') }}
              </option>
              <option v-if="canReceipt" value="offline">
                {{ tr('线下实收', 'Offline payment') }}
              </option>
            </select></label
          >
          <template v-if="selectedPayment === 'offline'"
            ><label class="field"
              >{{ tr('收款凭证号', 'Receipt reference')
              }}<el-input v-model="receipt" maxlength="120"
            /></label>
            <label class="field"
              >{{ tr('实收金额（元）', 'Received amount (CNY)')
              }}<el-input
                v-model="amount"
                inputmode="decimal"
                :placeholder="
                  String((activePlan?.priceFen ?? 0) / 100)
                " /></label
          ></template>
        </template>
        <label class="field"
          >{{ tr('办理原因', 'Reason')
          }}<el-input
            v-model="reason"
            type="textarea"
            maxlength="300"
            show-word-limit
        /></label>
      </template>
      <template v-else>
        <dl class="billing-details">
          <dt>{{ tr('办理内容', 'Action') }}</dt>
          <dd>
            {{ billingLabel(preview.quote.action, tr) }} ·
            {{ preview.quote.planName ?? tr('创作点', 'Credits') }}
          </dd>
          <template v-if="member">
            <dt>{{ tr('办理方式', 'Payment mode') }}</dt>
            <dd>
              {{
                selectedPayment === 'complimentary'
                  ? tr('赠送会员', 'Complimentary')
                  : tr('线下实收', 'Offline payment')
              }}
            </dd>
          </template>
          <dt>{{ tr('有效期', 'Period') }}</dt>
          <dd>
            {{ billingTime(preview.quote.startsAt) }} —
            {{ billingTime(preview.quote.endsAt) }}
          </dd>
          <template v-if="preview.quote.action === 'renew'"
            ><dt>{{ tr('下期发放日', 'Next grant date') }}</dt>
            <dd>{{ billingTime(preview.quote.startsAt) }}</dd></template
          >
          <dt>{{ tr('发放点数', 'Credits granted') }}</dt>
          <dd>{{ preview.quote.points }}</dd>
          <dt>{{ tr('立即到账', 'Available immediately') }}</dt>
          <dd>+{{ preview.quote.immediatePoints }}</dd>
          <dt>
            {{
              account.unlimited
                ? tr('点数账本余额', 'Credit ledger balance')
                : tr('预计可用余额', 'Available balance')
            }}
          </dt>
          <dd>
            {{ preview.quote.availableBefore }} →
            {{ preview.quote.availableAfter }}
          </dd>
          <template v-if="preview.quote.planName"
            ><dt>{{ tr('商品价格', 'List price') }}</dt>
            <dd>¥{{ preview.quote.priceFen / 100 }}</dd></template
          >
          <dt>{{ tr('登记实收', 'Amount received') }}</dt>
          <dd>
            ¥{{ preview.quote.receivedFen / 100 }}
            <template v-if="receipt">· {{ receipt }}</template>
          </dd>
          <dt>{{ tr('办理原因', 'Reason') }}</dt>
          <dd>{{ reason }}</dd>
          <dt>{{ tr('预览截止', 'Confirm by') }}</dt>
          <dd>{{ billingTime(preview.expiresAt) }}</dd>
        </dl>
        <el-button :disabled="mutation.busy.value" @click="edit">{{
          tr('返回修改', 'Edit details')
        }}</el-button>
      </template>
    </fieldset>
  </ManagementDialog>
</template>
