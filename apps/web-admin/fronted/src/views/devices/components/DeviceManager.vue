<script setup lang="ts">
import RowActions from '@/components/management/RowActions.vue'
import { watch } from 'vue'
import { useDeviceManager } from '@/composables/devices/use-device-manager'
import { runtimeStatus } from '@/utils/devices/runtime-config'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
import RuntimeFields from './RuntimeFields.vue'
/** 工作台可嵌入的本人设备管理组件；不复用平台运维的跨用户目录。 */
const emit = defineEmits<{ changed: [] }>()
const props = defineProps<{ initialDeviceId?: string; pairOnOpen?: boolean }>()
const vm = useDeviceManager(() => emit('changed'))
watch(
  () => [props.initialDeviceId, vm.resource.data.value] as const,
  ([id]) => {
    if (id)
      vm.selected.value =
        vm.resource.data.value?.connectors.find((item) => item.id === id) ??
        null
  },
  { immediate: true },
)
if (props.pairOnOpen && vm.auth.can('devices.manage')) vm.openPairing()
</script>
<template>
  <section class="device-manager">
    <div class="toolbar">
      <h2>我的设备</h2>
      <el-button @click="vm.reload">刷新</el-button
      ><el-button
        v-if="vm.auth.can('devices.manage')"
        type="primary"
        @click="vm.openPairing"
        >连接设备</el-button
      >
    </div>
    <ResourceStatus
      :loading="vm.resource.loading.value"
      :error="vm.resource.error.value"
      @retry="vm.resource.reload"
    /><el-alert
      v-if="vm.mutation.error.value"
      :title="vm.mutation.error.value"
      type="error"
      :closable="false"
    />
    <ul class="devices">
      <li
        v-for="device in vm.resource.data.value?.connectors ?? []"
        :key="device.id"
      >
        <div>
          <strong>{{ device.name }}</strong
          ><small
            >{{ device.status === 'online' ? '在线' : '离线' }} ·
            {{ device.deviceOs || device.connectorKind }}</small
          >
        </div>
        <div class="toolbar">
          <el-button link @click="vm.selected.value = device"
            >运行实例</el-button
          ><template
            v-if="
              vm.auth.can('devices.manage') &&
              device.executorKind !== 'server-agent'
            "
            ><el-button link @click="vm.rename(device)">重命名</el-button
            ><el-button link type="danger" @click="vm.revoking.value = device"
              >重置凭据</el-button
            ><el-button link type="danger" @click="vm.deleting.value = device"
              >删除设备</el-button
            ></template
          >
        </div>
      </li>
    </ul>
    <section v-if="vm.selected.value">
      <div class="toolbar">
        <h3>{{ vm.selected.value.name }} · 运行实例</h3>
        <el-button @click="vm.runtimes.reload">刷新状态</el-button
        ><template v-if="vm.mutable.value"
          ><el-button :loading="vm.mutation.busy.value" @click="vm.discover"
            >重新发现</el-button
          ><el-button
            :disabled="!vm.runtimes.data.value?.runtimeTypes.length"
            @click="vm.edit('new')"
            >添加实例</el-button
          ></template
        >
      </div>
      <p v-if="vm.selected.value.executorKind === 'server-agent'">
        服务器 DSH 由平台管理，生命周期诊断与重试通过工作台执行状态操作。
      </p>
      <ResourceStatus
        :loading="vm.runtimes.loading.value"
        :error="vm.runtimes.error.value"
        @retry="vm.runtimes.reload"
      />
      <article
        v-for="runtime in vm.runtimes.data.value?.runtimes ?? []"
        :key="runtime.runtimeId"
        class="runtime-card"
      >
        <div>
          <strong>{{ runtime.name || runtime.displayName }}</strong
          ><small
            >{{ runtime.runtimeType }} · {{ runtimeStatus(runtime.status) }} ·
            {{ runtime.configured ? '已配置' : '未配置' }}</small
          >
          <p v-if="runtime.error" role="alert">
            {{
              runtime.error.message ||
              runtime.error.reason ||
              runtime.error.code
            }}
          </p>
        </div>
        <RowActions :busy="vm.mutation.busy.value">
          <el-button link @click="vm.edit(runtime)">配置</el-button>
          <el-button link @click="vm.renameInstance(runtime)">重命名</el-button>
          <el-button
            link
            :disabled="
              vm.mutation.busy.value ||
              !runtime.configured ||
              runtime.status === 'configuring'
            "
            @click="vm.toggle(runtime)"
            >{{
              runtime.active
                ? '停止'
                : runtime.status === 'error'
                  ? '重试启动'
                  : '启动'
            }}</el-button
          >
          <el-button
            v-if="runtime.configured"
            link
            class="danger-action"
            @click="vm.clearing.value = runtime"
            >清除配置</el-button
          >
        </RowActions>
      </article>
      <el-empty
        v-if="
          !vm.runtimes.loading.value && !vm.runtimes.data.value?.runtimes.length
        "
        description="尚未发现运行实例，请连接设备后重新发现"
      />
    </section>
    <ManagementDialog
      :model-value="vm.pairing.value"
      title="连接设备"
      :busy="vm.mutation.busy.value"
      :error="vm.mutation.error.value"
      @update:model-value="vm.pairing.value = false"
      @submit="vm.pair"
      ><p>
        在桌面端或 Connector
        中生成配对码，再填写下方信息完成连接。配对码过期后请在设备端重新生成。
      </p>
      <label
        >设备名称<el-input
          v-model="vm.deviceDraft.name"
          maxlength="255" /></label
      ><label
        >配对码<el-input
          v-model="vm.pairingCode.value"
          maxlength="6"
          inputmode="numeric"
          autocomplete="one-time-code" /></label
      ><label
        >设备类型<el-select
          v-model="vm.deviceDraft.connectorKind"
          @change="vm.deviceDraft.executorKind = vm.deviceDraft.connectorKind"
          ><el-option label="桌面端" value="desktop" /><el-option
            label="命令行 Connector"
            value="cli" /></el-select></label
    ></ManagementDialog>
    <ManagementDialog
      :model-value="Boolean(vm.renaming.value)"
      title="重命名设备"
      :busy="vm.mutation.busy.value"
      :error="vm.mutation.error.value"
      @update:model-value="vm.renaming.value = null"
      @submit="vm.saveName"
      ><el-input v-model="vm.name.value" aria-label="设备名称" maxlength="255"
    /></ManagementDialog>
    <ManagementDialog
      :model-value="Boolean(vm.editing.value)"
      :title="vm.editing.value === 'new' ? '添加运行实例' : '运行实例配置'"
      :busy="vm.mutation.busy.value"
      :error="vm.mutation.error.value"
      @update:model-value="vm.editing.value = null"
      @submit="vm.saveRuntime"
      ><template v-if="vm.editing.value === 'new'"
        ><label
          >运行类型<el-select v-model="vm.draft.runtimeType"
            ><el-option
              v-for="type in vm.runtimes.data.value?.runtimeTypes ?? []"
              :key="type.runtimeType"
              :value="type.runtimeType"
              :label="type.displayName"
              :disabled="type.available === false" /></el-select></label
        ><label
          >实例名称<el-input v-model="vm.draft.name" maxlength="128" /></label
      ></template>
      <p v-if="vm.descriptor.value?.description">
        {{ vm.descriptor.value.description }}
      </p>
      <RuntimeFields
        v-if="vm.descriptor.value?.schema"
        v-model="vm.draft.config"
        :schema="vm.descriptor.value.schema"
        :ui="vm.descriptor.value.uiSchema"
        :disabled="vm.mutation.busy.value"
      />
      <p v-else>此设备未提供可编辑配置 Schema，请重新发现后重试。</p>
      <el-checkbox v-if="vm.editing.value === 'new'" v-model="vm.draft.active"
        >配置成功后启动</el-checkbox
      >
      <p v-else>
        运行中的实例保存配置时会按设备协议重新启动。
      </p></ManagementDialog
    >
    <ManagementDialog
      :model-value="Boolean(vm.runtimeRename.value)"
      title="重命名实例"
      :busy="vm.mutation.busy.value"
      :error="vm.mutation.error.value"
      @update:model-value="vm.runtimeRename.value = null"
      @submit="vm.saveRuntimeName"
      ><el-input
        v-model="vm.runtimeName.value"
        aria-label="实例名称"
        maxlength="128"
    /></ManagementDialog>
    <el-dialog
      :model-value="Boolean(vm.revoking.value)"
      title="重置设备凭据"
      width="min(480px, 94vw)"
      @update:model-value="vm.revoking.value = null"
      ><p>
        重置
        {{ vm.revoking.value?.name }}
        的平台凭据并断开连接，设备记录保留。请用新凭据重新连接，设备本地任务不会因此被终止。
      </p>
      <el-alert
        v-if="vm.mutation.error.value"
        :title="vm.mutation.error.value"
        type="error"
        :closable="false"
      /><template #footer
        ><el-button @click="vm.revoking.value = null">取消</el-button
        ><el-button
          type="danger"
          :loading="vm.mutation.busy.value"
          @click="vm.revoke"
          >确认重置</el-button
        ></template
      ></el-dialog
    >
    <el-dialog
      :model-value="Boolean(vm.credential.value)"
      title="新的设备凭据"
      width="min(560px, 94vw)"
      @update:model-value="vm.credential.value = null"
    >
      <p>凭据只在当前窗口展示，请更新设备连接配置。关闭后不会保留。</p>
      <el-input
        :model-value="vm.credential.value?.connectorToken"
        readonly
        aria-label="新的设备凭据"
        autocomplete="off"
      />
      <p v-if="vm.credentialNotice.value" role="status">
        {{ vm.credentialNotice.value }}
      </p>
      <template #footer
        ><el-button @click="vm.copyCredential">复制凭据</el-button
        ><el-button type="primary" @click="vm.credential.value = null"
          >完成</el-button
        ></template
      >
    </el-dialog>
    <el-dialog
      :model-value="Boolean(vm.deleting.value)"
      title="删除设备"
      width="min(480px, 94vw)"
      @update:model-value="vm.deleting.value = null"
    >
      <p>
        删除
        {{ vm.deleting.value?.name }} 的设备记录？需要重新配对才能再次连接。
      </p>
      <el-alert
        v-if="vm.mutation.error.value"
        :title="vm.mutation.error.value"
        type="error"
        :closable="false"
      />
      <template #footer
        ><el-button
          :disabled="vm.mutation.busy.value"
          @click="vm.deleting.value = null"
          >取消</el-button
        ><el-button
          type="danger"
          :loading="vm.mutation.busy.value"
          @click="vm.remove"
          >确认删除</el-button
        ></template
      >
    </el-dialog>
    <el-dialog
      :model-value="Boolean(vm.clearing.value)"
      title="清除运行配置"
      width="min(480px, 94vw)"
      @update:model-value="vm.clearing.value = null"
      ><p>
        停止
        {{ vm.clearing.value?.name }} 并移除保存的实例配置？其他实例保持原状态。
      </p>
      <el-alert
        v-if="vm.mutation.error.value"
        :title="vm.mutation.error.value"
        type="error"
        :closable="false"
      /><template #footer
        ><el-button @click="vm.clearing.value = null">取消</el-button
        ><el-button
          type="danger"
          :loading="vm.mutation.busy.value"
          @click="vm.clearConfig"
          >确认清除</el-button
        ></template
      ></el-dialog
    >
  </section>
</template>
<style scoped>
.device-manager {
  display: grid;
  gap: 16px;
}
.devices {
  list-style: none;
  padding: 0;
}
.devices li,
.runtime-card {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  padding: 16px 0;
  border-bottom: 1px solid var(--el-border-color);
}
small {
  display: block;
  color: var(--el-text-color-secondary);
}
.runtime-card p {
  color: var(--el-color-danger);
}
</style>
