<script setup lang="ts">
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
import { usePlanChange } from '@/composables/billing/use-plan-change'
import { usePreferences } from '@/store/modules/preferences'
import type { Plan } from '@/types/billing/membership'
import type { BillingAccount } from '@/types/billing/operations'
import { billingTime } from '@/utils/billing/change-labels'

const props = defineProps<{
  account: BillingAccount
  plans: Plan[]
  mode: 'schedule' | 'cancel'
}>()
const emit = defineEmits<{ close: []; saved: []; refresh: []; effective: [] }>()
const { tr } = usePreferences()
const { schedule, booked, valid, choices, target, reason, mutation, submit } =
  usePlanChange(props, (outcome) => {
    if (outcome === 'saved') emit('saved')
    else emit('effective')
  })
</script>
<template>
  <ManagementDialog
    :model-value="true"
    :title="
      schedule
        ? tr('预约换档', 'Schedule plan change')
        : tr('撤销换档预约', 'Cancel plan change')
    "
    :busy="mutation.busy.value"
    :error="mutation.error.value"
    :dirty="!!reason || !!target"
    :submit-disabled="!valid"
    :submit-text="
      schedule
        ? tr('确认预约', 'Schedule change')
        : tr('确认撤销', 'Cancel reservation')
    "
    @submit="submit"
    @update:model-value="!$event && emit('close')"
  >
    <fieldset
      class="form-stack billing-operation-fields"
      :disabled="mutation.busy.value"
    >
      <strong
        >{{ account.displayName || account.username }} ·
        {{ account.username }}</strong
      >
      <dl class="billing-details">
        <dt>{{ tr('当前会员', 'Current plan') }}</dt>
        <dd>{{ account.planName }}</dd>
        <dt>{{ tr('已购末期档位', 'Last booked plan') }}</dt>
        <dd>{{ account.lastBookedName }}</dd>
        <template v-if="account.endsAt"
          ><dt>{{ tr('已购至', 'Booked through') }}</dt>
          <dd>{{ billingTime(account.endsAt) }}</dd></template
        >
        <template v-if="!schedule && account.planChange">
          <dt>{{ tr('原预约', 'Reservation') }}</dt>
          <dd>
            {{ account.planChange.fromPlanName }} →
            {{ account.planChange.toPlanName }}
          </dd>
          <dt>{{ tr('预约周期起点', 'Reserved period starts') }}</dt>
          <dd>{{ billingTime(account.planChange.effectiveAt) }}</dd>
        </template>
        <template v-if="(schedule || booked) && account.endsAt">
          <dt>
            {{
              booked && !schedule
                ? tr('最早恢复原档', 'Earliest return to prior plan')
                : tr('最早换档', 'Earliest plan change')
            }}
          </dt>
          <dd>{{ billingTime(account.endsAt) }}</dd>
        </template>
      </dl>
      <template v-if="schedule">
        <label class="field"
          >{{ tr('目标档位', 'Target plan') }}
          <select v-model="target" class="native-control">
            <option value="" disabled>
              {{ tr('请选择新档位', 'Select a new plan') }}
            </option>
            <option v-for="p in choices" :key="p.id" :value="p.id">
              {{ p.name }} · ¥{{ p.priceFen / 100 }} ·
              {{ p.points.toLocaleString() }}
              {{ tr('点 / 周期', 'credits per period') }}
            </option>
          </select>
        </label>
        <small v-if="!choices.length" class="billing-note">{{
          tr(
            '暂无可预约的其他在售档位。',
            'No other plan is currently available.',
          )
        }}</small>
        <p class="billing-note">
          {{
            tr(
              '已购周期按原档履约。预约后，由运营确认下一次续期并按新周期发点。',
              'Booked periods keep their terms. An operator confirms the renewal before credits are issued for the new period.',
            )
          }}
        </p>
      </template>
      <p v-else class="billing-note">
        {{
          booked
            ? tr(
                '新档已办理，已购金额和周期额度保留。撤销后，将为首个未购周期预约恢复原档。',
                'The new plan is booked. Its payment and credits are preserved. A return to the prior plan will be scheduled for the first unbooked period.',
              )
            : tr(
                '撤销后保留已购权益。有效期内续期将沿用已购末期档位，也可以另行预约换档。',
                'Booked periods are preserved. Renewals use the last booked tier unless another change is scheduled.',
              )
        }}
      </p>
      <label class="field"
        >{{
          schedule
            ? tr('预约原因', 'Reason for change')
            : tr('撤销原因', 'Reason for cancellation')
        }}<el-input
          v-model="reason"
          type="textarea"
          maxlength="300"
          show-word-limit
      /></label>
      <el-button v-if="mutation.error.value" @click="emit('refresh')">{{
        tr('刷新会员记录', 'Refresh membership record')
      }}</el-button>
    </fieldset>
  </ManagementDialog>
</template>
