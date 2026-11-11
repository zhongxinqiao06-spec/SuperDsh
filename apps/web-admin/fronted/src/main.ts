import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import '@/assets/styles/tokens.css'
import '@/assets/styles/base.css'
import '@/assets/styles/element.css'
import '@/assets/styles/layout.css'
import '@/assets/styles/management.css'
import '@/assets/styles/dashboard.css'
import '@/assets/styles/workbench.css'
import '@/assets/styles/website.css'
import App from '@/App.vue'
import { normalizeInitialLocation, router } from '@/router/index'

normalizeInitialLocation()
createApp(App).use(createPinia()).use(ElementPlus).use(router).mount('#app')
