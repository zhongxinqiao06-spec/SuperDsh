<script setup lang="ts">
import { usePreferences } from '@/store/modules/preferences'
import type { OAuthSettings } from '@/types/service/system'
const model = defineModel<OAuthSettings>({ required: true }),
  { tr } = usePreferences()
const fields = [
  { key: 'provider', zh: '提供方标识', en: 'Provider ID' },
  { key: 'label', zh: '显示名称', en: 'Display label' },
  { key: 'clientId', zh: '客户端 ID', en: 'Client ID' },
  { key: 'authorizeUrl', zh: '授权地址', en: 'Authorization URL' },
  { key: 'tokenUrl', zh: '令牌地址', en: 'Token URL' },
  { key: 'userInfoUrl', zh: '用户信息地址', en: 'User info URL' },
  { key: 'scopes', zh: '授权范围', en: 'Scopes' },
  { key: 'subjectClaim', zh: '身份字段', en: 'Subject claim' },
  { key: 'emailClaim', zh: '邮箱字段', en: 'Email claim' },
  { key: 'nameClaim', zh: '姓名字段', en: 'Name claim' },
  { key: 'usernameClaim', zh: '用户名字段', en: 'Username claim' },
] as const
</script>
<template>
  <h2>{{ tr('第三方身份提供方', 'External identity provider') }}</h2>
  <el-switch
    v-model="model.enabled"
    :active-text="tr('启用 OAuth', 'Enable OAuth')"
  /><label v-for="field in fields" :key="field.key" class="field"
    >{{ tr(field.zh, field.en) }}<el-input v-model="model[field.key]" /></label
  ><label class="field"
    >{{ tr('客户端密钥', 'Client secret')
    }}<el-input
      v-model="model.clientSecret"
      type="password"
      show-password
      autocomplete="new-password"
      :placeholder="
        model.clientSecretConfigured
          ? tr('已配置，留空保留', 'Configured; leave blank to keep')
          : tr('尚未配置', 'Not configured')
      " /></label
  ><el-checkbox v-model="model.clearClientSecret">{{
    tr('清除已保存客户端密钥', 'Clear saved client secret')
  }}</el-checkbox>
</template>
