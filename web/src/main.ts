import { createApp } from 'vue'
import App from './App.vue'
import Console from './Console.vue'
import './style.css'
import './calm.css'
import './auth-entry.css'

createApp(location.pathname === '/console' || location.pathname === '/console/callback' ? Console : App).mount('#app')
