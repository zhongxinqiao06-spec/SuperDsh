<script setup lang="ts">
import { useLoginForm } from '@/composables/auth/use-login-form'
import { usePreferences } from '@/store/modules/preferences'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
import RecoveryDialog from '@/views/auth/components/RecoveryDialog.vue'
import OAuthFinalize from '@/views/auth/components/OAuthFinalize.vue'
import { ref } from 'vue'
import { useRoute } from 'vue-router'
import AppIcon from '@/components/base/AppIcon.vue'
import PublicBrand from '@/views/website/components/PublicBrand.vue'
import '@/assets/styles/product-website.css'
/** 两个产品共用中性认证入口，注册和登录续接均交给原身份流程。 */
const vm = useLoginForm()
const preferences = usePreferences()
const recovering = ref(false),
  route = useRoute()
const oauthQuery = new URLSearchParams(location.search)
const callbackValue = (key: string) =>
  String(route.query[key] ?? oauthQuery.get(key) ?? '')
</script>

<template>
  <main class="auth-page product-auth">
    <header class="starbridge-public auth-mast">
      <div class="mast-inner">
        <PublicBrand />
        <el-button
          text
          @click="
            preferences.locale = preferences.locale === 'zh-CN' ? 'en' : 'zh-CN'
          "
        >
          {{ preferences.locale === 'zh-CN' ? 'English' : '中文' }}
        </el-button>
      </div>
    </header>
    <section class="auth-card">
      <header>
        <h1>
          {{
            vm.register.value
              ? preferences.tr('创建账号', 'Create account')
              : preferences.tr('登录', 'Sign in to')
          }}
          {{ preferences.tr('星桥智能平台', 'Starbridge') }}
        </h1>
      </header>
      <ResourceStatus
        :loading="vm.resource.loading.value"
        :error="vm.resource.error.value"
        @retry="vm.resource.reload"
      />
      <el-alert
        v-if="callbackValue('oauth_error')"
        :title="callbackValue('oauth_error')"
        type="error"
        :closable="false"
      />
      <OAuthFinalize
        v-if="callbackValue('oauth_pending')"
        :pending="callbackValue('oauth_pending')"
        :status="callbackValue('oauth_status')"
        :email="callbackValue('oauth_email')"
        :name="callbackValue('oauth_display_name')"
        :email-required="
          vm.resource.data.value?.emailVerificationRequired ?? false
        "
      />
      <form
        v-else-if="vm.resource.data.value"
        class="stack"
        @submit.prevent="vm.submit"
      >
        <el-alert
          v-if="vm.initializationPending.value"
          :title="
            preferences.tr(
              '管理员由服务端按配置自动创建。当前初始化未完成，请检查服务端管理员配置并重启后端。',
              'The server creates the administrator from its configuration. Initialization is incomplete; check the administrator configuration and restart the backend.',
            )
          "
          type="error"
          :closable="false"
          show-icon
        />
        <template v-if="vm.register.value">
          <label class="field"
            >{{ preferences.tr('用户名', 'Username')
            }}<el-input
              v-model="vm.form.username"
              autocomplete="username"
              maxlength="32" /></label
          ><label class="field"
            >{{ preferences.tr('显示名称', 'Display name')
            }}<el-input v-model="vm.form.displayName" maxlength="100"
          /></label>
        </template>
        <template v-if="vm.register.value"
          ><label class="field"
            >{{ preferences.tr('邮箱', 'Email')
            }}<el-input v-model="vm.form.email" type="email" /></label
          ><template v-if="vm.resource.data.value.emailVerificationRequired"
            ><label class="field"
              >{{ preferences.tr('验证码', 'Verification code')
              }}<el-input
                v-model="vm.form.code"
                autocomplete="one-time-code" /></label
            ><el-button
              :loading="vm.mutation.busy.value"
              @click="vm.sendCode"
              >{{ preferences.tr('发送验证码', 'Send code') }}</el-button
            ></template
          ></template
        >
        <label v-else class="field"
          >{{ preferences.tr('用户名或邮箱', 'Username or email')
          }}<el-input
            v-model="vm.form.identifier"
            autofocus
            autocomplete="username"
            :placeholder="
              preferences.tr('输入用户名或邮箱', 'Enter username or email')
            "
            ><template #prefix><AppIcon name="user" /></template></el-input
        ></label>
        <label class="field"
          >{{ preferences.tr('密码', 'Password')
          }}<el-input
            v-model="vm.form.password"
            type="password"
            show-password
            :autocomplete="
              vm.register.value ? 'new-password' : 'current-password'
            "
            ><template #prefix><AppIcon name="lock" /></template></el-input
        ></label>
        <label v-if="vm.register.value" class="field"
          >{{ preferences.tr('确认密码', 'Confirm password')
          }}<el-input
            v-model="vm.form.confirm"
            type="password"
            show-password
            autocomplete="new-password"
        /></label>
        <el-alert
          v-if="vm.mutation.error.value"
          :title="vm.mutation.error.value"
          type="error"
          :closable="false"
          show-icon
        />
        <el-button
          type="primary"
          native-type="submit"
          class="wide-button"
          :loading="vm.mutation.busy.value"
          :disabled="vm.initializationPending.value"
        >
          {{
            vm.register.value
              ? preferences.tr('注册', 'Register')
              : preferences.tr('登录 ↵', 'Sign in ↵')
          }}
        </el-button>
        <router-link
          v-if="
            !vm.initializationPending.value &&
            vm.resource.data.value.registrationOpen
          "
          :to="{
            path: vm.register.value ? '/login' : '/register',
            query: route.query.returnTo
              ? { returnTo: route.query.returnTo }
              : {},
          }"
          >{{
            vm.register.value
              ? preferences.tr(
                  '已有账号，登录',
                  'Already have an account? Sign in',
                )
              : preferences.tr('创建账号', 'Create account')
          }}</router-link
        >
        <p class="privacy-note">
          {{
            preferences.tr(
              '继续操作即表示你已了解',
              'By continuing, you acknowledge our',
            )
          }}
          <router-link to="/privacy">{{
            preferences.tr('隐私说明', 'privacy notice')
          }}</router-link>
        </p>
        <el-button v-if="!vm.register.value" text @click="recovering = true">{{
          preferences.tr('忘记密码？', 'Forgot password?')
        }}</el-button>
        <el-button
          v-if="vm.resource.data.value.oauthEnabled"
          :loading="vm.mutation.busy.value"
          @click="vm.oauth"
          >{{ preferences.tr('使用第三方账号登录', 'Sign in with provider') }} ·
          {{ vm.resource.data.value.oauthProviderLabel }}</el-button
        >
      </form>
    </section>
    <RecoveryDialog
      v-if="recovering"
      v-model="recovering"
      :email-enabled="
        vm.resource.data.value?.emailVerificationRequired ?? false
      "
    />
    <footer>
      <router-link to="/">{{
        preferences.tr('返回官网', 'Back to website')
      }}</router-link>
    </footer>
  </main>
</template>

<style scoped>
.product-auth {
  --auth-paper: #f6f4ed;
  --auth-card: #fffefa;
  --auth-ink: #202720;
  --auth-line: #ccd1c7;
  color: var(--auth-ink);
  background: var(--auth-paper);
}
:global(.dark) .product-auth {
  --auth-paper: #1c201f;
  --auth-card: #272b28;
  --auth-ink: #eaece3;
  --auth-line: #434a45;
}
.auth-mast {
  position: absolute;
  inset: 0 0 auto;
  background: var(--auth-paper);
  color: var(--auth-ink);
  border-bottom: 1px solid var(--auth-line);
}
.auth-mast .mast-inner {
  display: flex;
  justify-content: space-between;
}
.product-auth .auth-card {
  width: 450px;
  padding: clamp(22px, 4vw, 46px);
  background: var(--auth-card);
  border: 1px solid var(--auth-line);
  border-top: 3px solid var(--auth-ink);
  border-radius: 4px;
}
.product-auth .auth-card header {
  text-align: left;
}
.product-auth .auth-card h1 {
  margin: 0;
  color: var(--auth-ink);
  font-size: clamp(23px, 3vw, 30px);
}
.product-auth .wide-button {
  border-radius: 4px;
}
.product-auth footer a {
  color: var(--auth-ink);
}
</style>
