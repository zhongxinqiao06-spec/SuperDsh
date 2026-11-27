<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import { Hide, View } from '@element-plus/icons-vue'
import { useLoginForm } from '@/composables/auth/use-login-form'
import { usePreferences } from '@/store/modules/preferences'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
import AppIcon from '@/components/base/AppIcon.vue'
import LoginArtwork from './components/LoginArtwork.vue'
import RecoveryDialog from './components/RecoveryDialog.vue'
import OAuthFinalize from './components/OAuthFinalize.vue'
import EmailRegistration from './components/EmailRegistration.vue'

/** 账号入口共用表单及身份用例；开放注册和授权回调按服务端能力展开。 */
const vm = useLoginForm()
const preferences = usePreferences()
const { tr } = preferences
const route = useRoute()
const recovering = ref(false)
const showPassword = ref(false)
const oauthQuery = new URLSearchParams(location.search)
const callbackValue = (key: string) =>
  String(route.query[key] ?? oauthQuery.get(key) ?? '')
const isExtended = computed(
  () => vm.register.value || Boolean(callbackValue('oauth_pending')),
)
const title = computed(() =>
  vm.register.value ? tr('创建账号', 'Create account') : tr('登录', 'Sign in'),
)
</script>

<template>
  <main class="login-page">
    <LoginArtwork />
    <section class="login-sheet" aria-labelledby="login-title">
      <header class="login-utility">
        <button
          class="login-text-action"
          type="button"
          :lang="preferences.locale === 'zh-CN' ? 'en' : 'zh-CN'"
          @click="
            preferences.locale = preferences.locale === 'zh-CN' ? 'en' : 'zh-CN'
          "
        >
          <AppIcon name="globe" :size="15" />{{
            preferences.locale === 'zh-CN' ? 'English' : '中文'
          }}
        </button>
      </header>
      <div
        class="login-content"
        :class="{ 'login-content--extended': isExtended }"
      >
        <header
          class="login-intro"
          :class="{ 'login-intro--registration': vm.register.value }"
        >
          <h1
            id="login-title"
            :aria-label="
              vm.register.value
                ? tr('创建账号 星桥智能平台', 'Create a Starbridge account')
                : tr('登录 星桥智能平台', 'Sign in to Starbridge')
            "
          >
            {{ title }}
          </h1>
          <p v-if="vm.register.value">
            {{
              vm.product.value === 'entertainment'
                ? tr(
                    '星桥娱乐 · 创作者账号',
                    'Starbridge Studio · Creator account',
                  )
                : tr(
                    '星桥办公 · 办公账号',
                    'Starbridge Office · Member account',
                  )
            }}
            <template v-if="vm.resource.data.value?.registrationGrant">
              ·
              {{
                tr(
                  `验证邮箱后获一张 ${vm.resource.data.value.registrationGrant.points} 点额度卡，${vm.resource.data.value.registrationGrant.validDays} 天有效。`,
                  `Verify your email to receive a ${vm.resource.data.value.registrationGrant.points}-credit card valid for ${vm.resource.data.value.registrationGrant.validDays} days.`,
                )
              }}
            </template>
          </p>
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
          :provider-verified="callbackValue('oauth_email_verified') === '1'"
          :mail-available="vm.mailAvailable.value"
        />
        <EmailRegistration
          v-else-if="vm.register.value"
          :key="vm.product.value"
          :product="vm.product.value"
          :available="vm.mailAvailable.value"
          :oauth-label="
            vm.resource.data.value?.oauthEnabled
              ? vm.resource.data.value.oauthProviderLabel
              : null
          "
          @registered="vm.registered"
          @retry="vm.resource.reload"
          @oauth="vm.oauth"
        />
        <form
          v-else-if="vm.resource.data.value"
          class="login-form"
          @submit.prevent="vm.submit"
        >
          <div class="login-fields">
            <el-alert
              v-if="vm.initializationPending.value"
              :title="
                tr(
                  '管理员由服务端按配置自动创建。当前初始化未完成，请检查服务端管理员配置并重启后端。',
                  'The server creates the administrator from its configuration. Initialization is incomplete; check the administrator configuration and restart the backend.',
                )
              "
              type="error"
              :closable="false"
              show-icon
            />
            <p
              v-if="
                route.path === '/register' && !vm.initializationPending.value
              "
              role="status"
            >
              {{
                tr(
                  '注册暂未开放，已有账号可在此登录。',
                  'Registration is closed. Sign in with an existing account.',
                )
              }}
            </p>
            <label class="field"
              >{{ tr('用户名或邮箱', 'Username or email') }}
              <el-input
                v-model="vm.form.identifier"
                autofocus
                autocomplete="username"
                autocapitalize="none"
                spellcheck="false"
                :placeholder="
                  tr('请输入用户名或邮箱', 'Enter your username or email')
                "
              />
            </label>
            <div class="field">
              <div class="login-field-heading">
                <label for="login-password">{{ tr('密码', 'Password') }}</label>
                <button
                  type="button"
                  class="login-text-action"
                  @click="recovering = true"
                >
                  {{ tr('忘记密码？', 'Forgot password?') }}
                </button>
              </div>
              <el-input
                id="login-password"
                v-model="vm.form.password"
                :type="showPassword ? 'text' : 'password'"
                autocomplete="current-password"
                :placeholder="tr('请输入密码', 'Enter your password')"
              >
                <template #suffix>
                  <button
                    type="button"
                    class="login-eye"
                    :aria-pressed="showPassword"
                    :aria-label="
                      showPassword
                        ? tr('隐藏密码', 'Hide password')
                        : tr('显示密码', 'Show password')
                    "
                    @click="showPassword = !showPassword"
                  >
                    <component
                      :is="showPassword ? View : Hide"
                      aria-hidden="true"
                    />
                  </button>
                </template>
              </el-input>
            </div>
          </div>
          <div class="login-actions">
            <el-alert
              v-if="vm.mutation.error.value"
              :title="vm.mutation.error.value"
              type="error"
              :closable="false"
              show-icon
            />
            <button
              type="submit"
              class="login-submit"
              :disabled="
                vm.initializationPending.value || vm.mutation.busy.value
              "
              :aria-busy="vm.mutation.busy.value"
              :aria-label="tr('登录 ↵', 'Sign in ↵')"
              aria-keyshortcuts="Enter"
            >
              <span class="login-submit-label">
                {{ tr('登录', 'Sign in') }}
                <AppIcon
                  v-if="!vm.mutation.busy.value"
                  name="arrow-right"
                  :size="15"
                />
                <i v-else class="login-spinner" aria-hidden="true" />
              </span>
            </button>
            <el-button
              v-if="vm.resource.data.value.oauthEnabled"
              :loading="vm.mutation.busy.value"
              @click="vm.oauth"
            >
              {{ tr('使用第三方账号登录', 'Sign in with provider') }} ·
              {{ vm.resource.data.value.oauthProviderLabel }}
            </el-button>
            <router-link
              v-if="
                !vm.initializationPending.value &&
                vm.resource.data.value.registrationOpen
              "
              class="login-create-account"
              :to="{
                path: '/register',
                query: {
                  ...(route.query.returnTo
                    ? { returnTo: route.query.returnTo }
                    : {}),
                  ...(route.query.product ? { product: vm.product.value } : {}),
                },
              }"
            >
              <span>{{ tr('去注册', 'Sign up') }}</span>
              <span class="login-register-arrow">
                <AppIcon name="arrow-right" :size="15" />
              </span>
            </router-link>
            <p class="login-legal">
              {{
                tr(
                  '继续操作即表示你已了解',
                  'By continuing, you acknowledge the',
                )
              }}
              <router-link to="/privacy">{{
                tr('隐私说明', 'Privacy notice')
              }}</router-link>
            </p>
          </div>
        </form>
      </div>
      <footer class="login-footer">
        <router-link to="/"
          ><AppIcon name="arrow-left" :size="16" />{{
            tr('返回官网', 'Back to website')
          }}</router-link
        >
      </footer>
    </section>
    <RecoveryDialog
      v-if="recovering"
      v-model="recovering"
      :email-enabled="
        vm.resource.data.value?.emailVerificationRequired ?? false
      "
    />
  </main>
</template>

<style src="@/assets/styles/public-auth.css"></style>
