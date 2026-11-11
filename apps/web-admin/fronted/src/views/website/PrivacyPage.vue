<script setup lang="ts">
import { usePreferences } from '@/store/modules/preferences'
/** 基础隐私说明公开可读，不要求登录或准备Agent。 */
const { tr } = usePreferences()
</script>
<template>
  <main class="page legal-page">
    <router-link to="/">← 星桥智能平台</router-link>
    <h1>{{ tr('隐私说明', 'Privacy notice') }}</h1>
    <p>
      {{
        tr(
          '平台使用账号身份和授权管理你的会话、文件与配置。访问令牌仅保留在当前页面内存，刷新凭据通过 HttpOnly Cookie 管理。',
          'The platform uses your identity and permissions to manage sessions, files and configuration. Access tokens remain in page memory; refresh credentials use HttpOnly cookies.',
        )
      }}
    </p>
    <p>
      {{
        tr(
          '你提交给模型或已授权工具的内容将根据该供应商与工具的配置处理。请先确认资料使用权限，不要提交无权使用的敏感信息。',
          'Content sent to models or authorized tools is processed under their configured provider policies. Verify that you have permission to use the material.',
        )
      }}
    </p>
    <router-link to="/login">{{
      tr('返回登录', 'Back to sign in')
    }}</router-link>
  </main>
</template>
