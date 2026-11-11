<script setup lang="ts">
import { useNativeOAuth } from '@/composables/auth/use-native-oauth'
import { usePreferences } from '@/store/modules/preferences'
const vm = useNativeOAuth(),
  { tr } = usePreferences()
</script>
<template>
  <main class="auth-page">
    <section class="auth-card stack">
      <h1>{{ tr('授权连接账号', 'Authorize account connection') }}</h1>
      <el-alert
        v-if="!vm.valid.value"
        :title="
          tr(
            '授权链接无效，请回到客户端重新开始。',
            'Invalid authorization link. Restart from your client.',
          )
        "
        type="error"
        :closable="false"
      /><template v-else
        ><p>{{ vm.query.value.client_id }}</p>
        <p>
          {{
            tr(
              '只有你信任的客户端才能获得授权。',
              'Only authorize a client you trust.',
            )
          }}
        </p>
        <el-alert
          v-if="vm.mutation.error.value"
          :title="vm.mutation.error.value"
          type="error"
          :closable="false"
        /><template v-if="vm.auth.authenticated"
          ><p>
            {{ tr('当前账号', 'Current account') }}：{{
              vm.auth.session?.displayName || vm.auth.session?.username
            }}
          </p>
          <router-link
            v-if="vm.auth.session?.resetRequired"
            to="/account/security"
            >{{
              tr('请先修改初始密码', 'Change your initial password first')
            }}</router-link
          ><el-button
            v-else
            type="primary"
            :loading="vm.mutation.busy.value"
            @click="vm.authorize"
            >{{ tr('授权并继续', 'Authorize and continue') }}</el-button
          ><el-button @click="vm.switchAccount">{{
            tr('使用其他账号', 'Use another account')
          }}</el-button></template
        ><router-link
          v-else
          :to="{ path: '/login', query: { returnTo: vm.route.fullPath } }"
          >{{ tr('登录后授权', 'Sign in to authorize') }}</router-link
        ><el-button @click="vm.cancel">{{
          tr('取消', 'Cancel')
        }}</el-button></template
      >
    </section>
  </main>
</template>
