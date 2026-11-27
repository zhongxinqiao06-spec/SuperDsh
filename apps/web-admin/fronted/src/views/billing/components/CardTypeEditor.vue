<script setup lang="ts">
import { computed, onScopeDispose, reactive, ref } from 'vue'
import { cardTypesApi } from '@/api/billing/card-types-api'
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
import { useMutation } from '@/composables/use-mutation'
import { usePreferences } from '@/store/modules/preferences'
import type { CardType, CardTypeInput } from '@/types/billing/membership'
import { createUuid } from '@/utils/uuid'
import CreditTicket from './CreditTicket.vue'

const props = defineProps<{ card: CardType | null }>()
const emit = defineEmits<{ close: []; saved: [] }>()
const { tr } = usePreferences()
const mutation = useMutation()
const id = props.card?.id ?? createUuid()
const initial: CardTypeInput = {
  name: props.card?.name ?? '',
  points: props.card?.points ?? 100,
  validDays: props.card?.validDays ?? 365,
  image: props.card?.image ?? '/images/credit-cards/film.webp',
  enabled: props.card?.enabled ?? true,
  revision: props.card?.revision ?? 0,
}
const draft = reactive({ ...initial })
const dirty = computed(() => JSON.stringify(initial) !== JSON.stringify(draft))
const reading = ref(false)
const imageError = ref('')
let reader: FileReader | undefined
onScopeDispose(() => reader?.abort())
function readImage(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  input.value = ''
  imageError.value = ''
  if (
    file.size > 2 * 1024 * 1024 ||
    !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)
  ) {
    imageError.value = tr(
      '请选择 2 MB 以内的 PNG、JPG 或 WebP 图片。',
      'Choose a PNG, JPG or WebP image up to 2 MB.',
    )
    return
  }
  reader = new FileReader()
  reading.value = true
  reader.onload = () => {
    if (typeof reader?.result === 'string') draft.image = reader.result
  }
  reader.onerror = () => {
    imageError.value = tr(
      '图片读取失败，请重新选择。',
      'Could not read the image. Choose it again.',
    )
  }
  reader.onloadend = () => {
    reading.value = false
  }
  reader.readAsDataURL(file)
}
async function save() {
  if (reading.value || !draft.name.trim() || imageError.value) return
  if (
    await mutation.run(() =>
      cardTypesApi.save(id, { ...draft, name: draft.name.trim() }),
    )
  )
    emit('saved')
}
</script>

<template>
  <ManagementDialog
    :model-value="true"
    :title="
      card ? tr('编辑卡种', 'Edit card type') : tr('新建卡种', 'New card type')
    "
    :dirty="dirty"
    :busy="reading || mutation.busy.value"
    :error="mutation.error.value"
    :submit-disabled="!!imageError"
    @update:model-value="!$event && emit('close')"
    @submit="save"
  >
    <CreditTicket
      class="ticket-editor-preview"
      :image="draft.image"
      :name="draft.name"
      :points="draft.points || 0"
    />
    <fieldset
      class="billing-operation-fields form-stack"
      :disabled="reading || mutation.busy.value"
    >
      <label class="field"
        >{{ tr('卡种名称', 'Card name') }}
        <input
          v-model="draft.name"
          class="native-control"
          required
          maxlength="80"
          :pattern="'.*\\S.*'"
          autocomplete="off"
        />
      </label>
      <label class="field"
        >{{ tr('卡面图片', 'Card image') }}
        <input
          class="native-control"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          @change="readImage"
        />
      </label>
      <small v-if="imageError" role="alert" class="ticket-field-error">{{
        imageError
      }}</small>
      <small class="billing-note">{{
        tr(
          '建议使用约 2:1 的横图，左侧留白叠加面额。支持 PNG、JPG、WebP，最大 2 MB。',
          'Use a wide 2:1 image with room for the amount on the left. PNG, JPG or WebP, up to 2 MB.',
        )
      }}</small>
      <div class="ticket-editor-values">
        <label class="field"
          >{{ tr('固定面额（点）', 'Face value (credits)') }}
          <input
            v-model.number="draft.points"
            class="native-control"
            type="number"
            required
            min="1"
            max="1000000"
            step="1"
          />
        </label>
        <label class="field"
          >{{ tr('默认有效天数', 'Default validity (days)') }}
          <input
            v-model.number="draft.validDays"
            class="native-control"
            type="number"
            required
            min="1"
            max="3650"
            step="1"
          />
        </label>
      </div>
      <label class="toolbar"
        ><input v-model="draft.enabled" type="checkbox" />{{
          tr('允许发放此卡种', 'Enable this card for issuance')
        }}</label
      >
      <small v-if="!draft.enabled" class="billing-note">{{
        tr(
          '停用后，用户已领到的卡仍按原有效期使用。',
          'Issued cards remain usable until their original expiration date.',
        )
      }}</small>
    </fieldset>
  </ManagementDialog>
</template>
