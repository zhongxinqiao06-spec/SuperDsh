<script setup lang="ts">
import type { useRuntimeSelections } from '@/composables/workbench/use-runtime-selections'
import {
  catalogItemDisabledReason,
  catalogItemEnabled,
  catalogLabel,
  modelCatalogDisplayName,
  modelCatalogSource,
} from '@/utils/workbench/catalog'

/** 模型、推理强度、权限字段供桌面工具栏与窄屏抽屉共用，不自行构造引擎选择标识。 */
defineProps<{
  selection: ReturnType<typeof useRuntimeSelections>
  disabled?: boolean
  existing: boolean
}>()
</script>

<template>
  <div class="runtime-selectors">
    <el-select
      class="runtime-model-select"
      popper-class="composer-model-menu"
      placement="top-start"
      :fit-input-width="false"
      :model-value="selection.modelId.value"
      :clearable="!existing && selection.modelExplicit.value"
      :placeholder="selection.modelLabel.value"
      aria-label="模型选择"
      :disabled="disabled || !selection.modelAllowed.value"
      @change="(value: string) => selection.chooseModel(value)"
    >
      <el-option
        v-for="model in selection.models.value"
        :key="model.id"
        :value="model.id"
        :disabled="!catalogItemEnabled(model)"
        :title="catalogItemDisabledReason(model) ?? undefined"
        :label="
          modelCatalogDisplayName(
            model,
            selection.models.value,
            catalogLabel(model),
            '默认',
          )
        "
      >
        <div class="model-option-name">
          <span>{{
            modelCatalogDisplayName(
              model,
              selection.models.value,
              catalogLabel(model),
              '默认',
            )
          }}</span
          ><small v-if="model.default" class="model-default-badge">默认</small>
        </div>
        <small v-if="modelCatalogSource(model)" class="model-option-source">{{
          modelCatalogSource(model)
        }}</small>
        <small v-if="!catalogItemEnabled(model)">{{
          catalogItemDisabledReason(model) ?? '当前不可用'
        }}</small>
      </el-option>
    </el-select>
    <el-select
      v-if="selection.reasoning.value.length"
      class="runtime-reasoning-select"
      :model-value="selection.reasoningId.value"
      placeholder="默认推理"
      aria-label="推理强度"
      :disabled="disabled || !selection.reasoningAllowed.value"
      @change="
        (value: string) => selection.chooseModel(selection.modelId.value, value)
      "
    >
      <el-option value="" label="默认推理" />
      <el-option
        v-for="item in selection.reasoning.value"
        :key="item.id"
        :value="item.id"
        :label="catalogLabel(item)"
        :disabled="!catalogItemEnabled(item)"
        :title="catalogItemDisabledReason(item) ?? undefined"
      />
    </el-select>
    <el-select
      :model-value="selection.permissionId.value"
      class="runtime-permission-select"
      :clearable="!existing && selection.permissionExplicit.value"
      :placeholder="selection.permissionLabel.value"
      aria-label="权限模式"
      :disabled="disabled || !selection.permissionAllowed.value"
      @change="selection.choosePermission"
    >
      <el-option
        v-for="item in selection.permissions.value"
        :key="item.id"
        :value="item.id"
        :label="catalogLabel(item)"
        :disabled="!catalogItemEnabled(item)"
        :title="catalogItemDisabledReason(item) ?? undefined"
      />
    </el-select>
  </div>
</template>

<style scoped>
.runtime-selectors {
  display: var(--runtime-selectors-display, flex);
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.runtime-selectors .el-select {
  width: var(--runtime-selector-width, 160px);
}
small {
  margin-left: 10px;
  color: var(--muted-foreground);
}
@media (max-width: 640px) {
  .runtime-selectors .el-select {
    width: var(--runtime-selector-width, 124px);
  }
}
</style>

<style>
.composer-model-menu .el-select-dropdown__item {
  height: auto;
  min-height: 52px;
  padding-top: 7px;
  padding-bottom: 7px;
  line-height: 20px;
}
.composer-model-menu .model-option-name {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
}
.composer-model-menu .model-option-source {
  display: block;
  margin-left: 0;
  font-weight: normal;
  color: var(--muted-foreground);
}
.composer-model-menu .model-default-badge {
  color: var(--muted-foreground);
  font-weight: normal;
}
</style>
