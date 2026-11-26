<script setup lang="ts">
import { adapterNames } from '@/utils/models/supplier-presentation'
import FormSection from '@/components/form/FormSection.vue'
import type {
  ConnectionDraft,
  SupplierSubscription,
} from '@/types/models/models'
/** 连接编辑不会把旧密钥写进输入框，复用连接的能力类型由服务端约束。 */
const props = defineProps<{ draft: ConnectionDraft; keyConfigured: boolean }>()
const emit = defineEmits<{ 'update:draft': [value: ConnectionDraft] }>()
/** 只发布新草稿，由父级用例保存；不修改传入对象及其嵌套字段。 */
function patch(value: Partial<ConnectionDraft>): void {
  emit('update:draft', { ...props.draft, ...value })
}
function subscription(value: Partial<SupplierSubscription>): void {
  patch({ subscription: { ...props.draft.subscription, ...value } })
}
</script>

<template>
  <FormSection title="连接信息" columns>
    <label class="field"
      >连接名称<el-input
        :model-value="draft.name"
        maxlength="100"
        @update:model-value="patch({ name: $event })"
    /></label>
    <label class="field"
      >适配器<el-select
        :model-value="draft.adapter"
        @update:model-value="patch({ adapter: $event })"
        ><el-option
          v-for="(label, id) in adapterNames"
          :key="id"
          :value="id"
          :label="label" /></el-select
    ></label>
    <label class="field form-span"
      >API 地址<el-input
        :model-value="draft.baseUrl"
        placeholder="供应商提供的完整 Base URL"
        @update:model-value="patch({ baseUrl: $event })"
    /></label>
    <label class="field"
      >区域（可选）<el-input
        :model-value="draft.region"
        maxlength="100"
        @update:model-value="patch({ region: $event })"
    /></label>
    <el-checkbox
      class="form-column-option"
      :model-value="draft.enabled"
      @update:model-value="patch({ enabled: Boolean($event) })"
      >启用连接</el-checkbox
    >
  </FormSection>
  <FormSection title="套餐与额度登记" columns>
    <label class="field"
      >套餐名称<el-input
        :model-value="draft.subscription?.plan"
        maxlength="100"
        @update:model-value="subscription({ plan: $event })"
    /></label>
    <label class="field"
      >计量单位<el-input
        :model-value="draft.subscription?.unit"
        placeholder="如 Credits、AFP、CNY"
        maxlength="32"
        @update:model-value="subscription({ unit: $event })"
    /></label>
    <label class="field"
      >套餐总额度<el-input-number
        :model-value="draft.subscription?.quota ?? undefined"
        :min="0"
        :controls="false"
        @update:model-value="subscription({ quota: $event ?? null })"
    /></label>
    <label class="field"
      >剩余额度（人工登记）<el-input-number
        :model-value="draft.subscription?.remaining ?? undefined"
        :min="0"
        :controls="false"
        @update:model-value="subscription({ remaining: $event ?? null })"
    /></label>
  </FormSection>
  <FormSection title="访问凭据">
    <label class="field"
      >API Key<el-input
        :model-value="draft.apiKey"
        type="password"
        show-password
        autocomplete="new-password"
        :placeholder="keyConfigured ? '已配置，留空保留' : '输入供应商密钥'"
        @update:model-value="patch({ apiKey: $event })"
    /></label>
    <el-checkbox
      v-if="keyConfigured"
      :model-value="draft.clearApiKey"
      :disabled="Boolean(draft.apiKey)"
      @update:model-value="patch({ clearApiKey: Boolean($event) })"
      >明确清除已有密钥</el-checkbox
    >
  </FormSection>
</template>
