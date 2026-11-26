<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
import { pricingApi } from '@/api/billing/pricing-api'
import { useResource } from '@/composables/use-resource'
import { useMutation } from '@/composables/use-mutation'
import { usePreferences } from '@/store/modules/preferences'
import type { RateTerms, RateVersion } from '@/types/billing/pricing'
import { createUuid } from '@/utils/uuid'
const props = defineProps<{ row: RateVersion | null; editable: boolean }>()
const emit = defineEmits<{
  close: []
  saved: [published: boolean, scheduled: boolean]
}>()
const { tr } = usePreferences(),
  action = useMutation()
const terms = reactive<RateTerms>({
  ...(props.row?.payload.terms ?? {
    product: 'entertainment',
    model: '*',
    modelRevision: 0,
    capability: 'video.generate',
    spec: '720P',
    payer: 'platform',
    unit: 'second',
    unitSize: 1,
    unitPoints: 20,
  }),
})
const quantity = ref(5),
  reason = ref(props.row?.payload.reason ?? ''),
  schedule = ref(''),
  timing = ref('now')
const initial = JSON.stringify([terms, reason.value]),
  dirty = computed(() => initial !== JSON.stringify([terms, reason.value]))
const valid = computed(
  () =>
    terms.capability.trim() &&
    terms.spec.trim() &&
    terms.model.trim() &&
    Number.isInteger(terms.modelRevision) &&
    terms.modelRevision >= 0 &&
    Number.isInteger(terms.unitSize) &&
    terms.unitSize > 0 &&
    Number.isInteger(terms.unitPoints) &&
    terms.unitPoints >= 0 &&
    (terms.payer !== 'personal' || terms.unitPoints === 0),
)
const trial = useResource((signal) => {
  if (!valid.value || !Number.isInteger(quantity.value) || quantity.value < 1)
    return Promise.resolve(null)
  const { product, model, modelRevision, capability, spec, payer } = terms
  return pricingApi.trial(
    {
      product,
      model,
      modelRevision,
      capability,
      spec,
      payer,
      quantity: quantity.value,
    },
    { ...terms },
    signal,
  )
})
watch(
  [terms, quantity],
  () => {
    trial.data.value = null
    void trial.reload()
  },
  { flush: 'sync' },
)
const publishable = computed(
  () => !!props.row && !props.row.effectiveAt && !dirty.value,
)
const publishTime = computed(() =>
  timing.value === 'scheduled' ? Date.parse(schedule.value + '+08:00') : null,
)
let signature = '',
  key = ''
async function submit() {
  if (
    !props.editable ||
    !valid.value ||
    !reason.value.trim() ||
    !trial.data.value?.candidate
  )
    return
  const published = !!publishable.value
  if (
    await action.run(async () => {
      if (published && props.row)
        await pricingApi.publish(
          'rate',
          props.row.id,
          props.row.revision,
          publishTime.value === null
            ? null
            : new Date(publishTime.value).toISOString(),
        )
      else {
        const current = JSON.stringify([terms, reason.value])
        if (signature !== current) {
          signature = current
          key = createUuid()
        }
        await pricingApi.saveRate(
          { ...terms },
          props.row?.revision ?? 0,
          key,
          reason.value.trim(),
        )
      }
    })
  )
    emit('saved', published, publishTime.value !== null)
}
</script>
<template>
  <ManagementDialog
    :model-value="true"
    width="min(900px, calc(100vw - 32px))"
    :title="tr('费率与试算', 'Rate and simulation')"
    :dirty="dirty"
    :readonly="!editable"
    :busy="action.busy.value"
    :error="action.error.value"
    :submit-disabled="
      !trial.data.value?.candidate ||
      trial.loading.value ||
      !reason.trim() ||
      (!dirty && !!row?.effectiveAt) ||
      (publishable && publishTime !== null && !(publishTime > Date.now()))
    "
    :submit-text="
      publishable
        ? tr('确认发布费率', 'Publish rate')
        : tr('保存费率草稿', 'Save rate draft')
    "
    @submit="submit"
    @update:model-value="!$event && emit('close')"
  >
    <div class="rate-workspace">
      <div class="form-stack">
        <fieldset
          class="billing-plans billing-operation-fields"
          :disabled="!!row || !editable || action.busy.value"
        >
          <label class="field"
            >{{ tr('产品', 'Product')
            }}<select v-model="terms.product" class="native-control">
              <option value="entertainment">{{ tr('娱乐', 'Studio') }}</option>
              <option value="office">{{ tr('办公', 'Office') }}</option>
            </select></label
          >
          <label class="field"
            >{{ tr('能力', 'Capability')
            }}<el-input
              v-model="terms.capability"
              maxlength="100"
              placeholder="video.generate"
          /></label>
          <label class="field"
            >{{ tr('模型配置编号', 'Configuration ID')
            }}<el-input
              v-model="terms.model"
              maxlength="100"
              :placeholder="tr('* 表示通用模型', '* for all models')"
          /></label>
          <label class="field"
            >{{
              tr('配置修订（0 为全部）', 'Configuration revision (0 for all)')
            }}<input
              v-model.number="terms.modelRevision"
              type="number"
              min="0"
              class="native-control"
          /></label>
          <label class="field"
            >{{ tr('规格', 'Specification')
            }}<el-input v-model="terms.spec" maxlength="100" placeholder="720P"
          /></label>
          <label class="field"
            >{{ tr('费用承担方', 'Payer')
            }}<select
              v-model="terms.payer"
              class="native-control"
              @change="terms.payer === 'personal' && (terms.unitPoints = 0)"
            >
              <option value="platform">{{ tr('平台模型', 'Platform') }}</option>
              <option value="personal">
                {{ tr('本人凭据', 'Personal credentials') }}
              </option>
            </select></label
          >
        </fieldset>
        <fieldset
          class="billing-plans billing-operation-fields"
          :disabled="!editable || action.busy.value"
        >
          <label class="field"
            >{{ tr('计量单位', 'Unit')
            }}<select v-model="terms.unit" class="native-control">
              <option value="second">{{ tr('秒', 'Seconds') }}</option>
              <option value="image">{{ tr('张', 'Images') }}</option>
              <option value="character">{{ tr('字', 'Characters') }}</option>
              <option value="call">{{ tr('次', 'Calls') }}</option>
            </select></label
          >
          <label class="field"
            >{{ tr('每组数量', 'Units per group')
            }}<input
              v-model.number="terms.unitSize"
              type="number"
              min="1"
              class="native-control"
          /></label>
          <label class="field"
            >{{ tr('每组点数', 'Credits per group')
            }}<input
              v-model.number="terms.unitPoints"
              type="number"
              min="0"
              class="native-control"
              :disabled="terms.payer === 'personal'"
          /></label>
        </fieldset>
      </div>
      <div class="form-stack rate-simulation">
        <section class="panel form-stack">
          <label class="field"
            >{{ tr('试算数量', 'Sample quantity')
            }}<input
              v-model.number="quantity"
              type="number"
              min="1"
              max="1000000"
              class="native-control"
          /></label>
          <ResourceStatus
            :loading="trial.loading.value"
            :error="trial.error.value"
            @retry="trial.reload"
          />
          <dl
            v-if="trial.data.value?.candidate"
            class="billing-details"
            aria-live="polite"
          >
            <dt>{{ tr('当前报价', 'Current price') }}</dt>
            <dd>{{ trial.data.value.current?.points ?? '—' }}</dd>
            <dt>{{ tr('试算报价', 'Simulated price') }}</dt>
            <dd>
              <strong
                >{{ trial.data.value.candidate.points }}
                {{ tr('点', 'credits') }}</strong
              >
              · {{ trial.data.value.candidate.units }}
              {{ tr('组，逐项向上取整', 'groups, rounded up per item') }}
            </dd>
            <dt>{{ tr('差额', 'Difference') }}</dt>
            <dd>{{ trial.data.value.difference ?? '—' }}</dd>
          </dl>
        </section>
        <label v-if="editable" class="field"
          >{{ tr('变更原因', 'Reason for change')
          }}<el-input
            v-model="reason"
            maxlength="300"
            :disabled="action.busy.value"
        /></label>
        <template v-if="publishable && editable"
          ><label class="field"
            >{{ tr('生效方式', 'Effective date')
            }}<select v-model="timing" class="native-control">
              <option value="now">{{ tr('立即生效', 'Immediately') }}</option>
              <option value="scheduled">
                {{ tr('定时生效', 'Scheduled') }}
              </option>
            </select></label
          ><label v-if="timing === 'scheduled'" class="field"
            >{{ tr('生效时间（北京时间）', 'Effective time (UTC+8)')
            }}<input
              v-model="schedule"
              class="native-control"
              type="datetime-local" /></label
        ></template>
      </div></div
  ></ManagementDialog>
</template>

<style scoped>
.rate-workspace {
  display: grid;
  gap: var(--space-4);
  align-items: start;
}
.rate-workspace .billing-plans {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
@media (min-width: 800px) {
  .rate-workspace {
    grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
  }
}
@media (max-width: 520px) {
  .rate-workspace .billing-plans {
    grid-template-columns: 1fr;
  }
}
</style>
