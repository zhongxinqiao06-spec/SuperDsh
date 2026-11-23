<script setup lang="ts">
import { computed, ref } from 'vue'
import type { SupplierInspection } from '@/types/models/models'

/** RAM 登录与官方 CLI 回调在阿里云完成，一次性链接只在当前弹窗内使用。 */
const props = defineProps<{
  account?: SupplierInspection['cliRamAccount']
  busy: boolean
}>()
defineEmits<{ verify: [] }>()
const entered = ref('')
const signIn = computed(() => {
  const url = new URL('https://signin.aliyun.com/login.htm')
  if (props.account?.loginName)
    url.searchParams.set('username', props.account.loginName)
  return url.href
})
const authorization = computed(() => {
  const value = entered.value.trim()
  const match =
    /^https:\/\/bailian\.console\.aliyun\.com\/console-login\?notice=127\.0\.0\.1:(\d{1,5})\?state=[\w-]{1,256}(?:&needapikey=true)?$/u.exec(
      value,
    )
  const port = Number(match?.[1])
  return port > 0 && port <= 65535 ? { url: value, port } : undefined
})
</script>
<template>
  <section class="authorization stack" aria-label="百炼账号授权">
    <div>
      <strong>登录绑定的 RAM 账号</strong>
      <p v-if="account">
        请在阿里云确认当前登录账号为 {{ account.loginName || account.name }}。
      </p>
      <a v-if="account" :href="signIn" target="_blank" rel="noopener noreferrer"
        >打开 RAM 登录页 ↗</a
      >
    </div>
    <div class="authorization-step">
      <strong>在同一浏览器完成百炼 CLI 授权</strong>
      <label class="field">
        CLI 生成的一次性授权链接
        <input
          v-model="entered"
          class="native-control"
          type="url"
          maxlength="512"
          autocomplete="off"
          spellcheck="false"
          placeholder="粘贴百炼 CLI 打印的 https 链接"
        />
      </label>
      <small v-if="entered.trim() && !authorization" role="status"
        >请使用百炼 CLI 打印的完整控制台授权链接。</small
      >
      <a
        v-if="authorization"
        :href="authorization.url"
        target="_blank"
        rel="noopener noreferrer"
        >打开百炼授权窗口 ↗</a
      >
      <details>
        <summary>如何生成授权链接？</summary>
        <p>请部署人员在服务器项目目录运行以下命令，保持终端打开。</p>
        <code>sh apps/web-admin/deployment/authorize-bailian.sh</code>
        <p>
          在当前电脑通过 SSH 转发 CLI 链接中的回调端口，将「部署主机」换成你的
          SSH 主机名。
        </p>
        <code v-if="authorization"
          >ssh -N -L 127.0.0.1:{{ authorization.port }}:127.0.0.1:{{
            authorization.port
          }}
          部署主机</code
        >
        <code v-else>ssh -N -L 127.0.0.1:端口:127.0.0.1:端口 部署主机</code>
        <p>
          <a
            href="https://help.aliyun.com/zh/model-studio/cli/config"
            target="_blank"
            rel="noopener noreferrer"
            >官方 CLI 登录说明 ↗</a
          >
        </p>
      </details>
    </div>
    <div>
      <el-button type="primary" :loading="busy" @click="$emit('verify')"
        >核验账号并刷新用量</el-button
      >
    </div>
  </section>
</template>
<style scoped>
.authorization {
  padding: var(--space-3);
  border-inline-start: 2px solid var(--primary);
  background: var(--el-fill-color-lighter);
  overflow-wrap: anywhere;
}
.authorization p {
  margin: var(--space-1) 0;
  color: var(--muted-foreground);
}
.authorization-step {
  display: grid;
  gap: var(--space-2);
}
.authorization summary {
  cursor: pointer;
}
</style>
