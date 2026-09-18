<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ElButton, ElCheckbox, ElInput } from 'element-plus'
import 'element-plus/es/components/button/style/css'
import 'element-plus/es/components/checkbox/style/css'
import 'element-plus/es/components/input/style/css'
import { api, ApiError, checkedCallback, checkedHandoff, takeFragment, readFragment, isDirectLoginEntry, rememberEmail, type AuthProvider, type Configuration, type View } from './protocol'
import { AuthClient, AuthError } from '../../sdk/browser/src/index.ts'
import { checkedConsole, ConsoleError } from './console-api'
import { checkedProviderUrl, enabledProviders, saveProviderAttempt, takeProviderAttempt } from './provider'
import { copy } from './copy'
import { CompletionFlow, rememberCompletion, takeCompletion, type ConfirmationAccount } from './completion'
import ProviderMailbox from './ProviderMailbox.vue'
import molisLogo from './assets/molis-logo.png'

type Mode = 'login' | 'provider' | 'provider-mailbox' | 'register' | 'forgot-password' | 'verify-email' | 'complete'
const path = location.pathname.split('/').filter(Boolean).at(-1) ?? 'login'
const initialMode: Mode = ['login', 'provider', 'provider-mailbox', 'register', 'forgot-password', 'verify-email', 'complete'].includes(path) ? path as Mode : 'login'
const directLoginEntry = isDirectLoginEntry(location) || (initialMode === 'register' && !location.search && !location.hash)
const fragment = takeFragment(location, history, initialMode)
const mode = ref<Mode>(initialMode), language = ref<'zh-CN' | 'en'>(navigator.language.startsWith('zh') ? 'zh-CN' : 'en')
const t = computed(() => copy[language.value])
const transaction = ref(fragment?.transaction ?? ''), view = ref<View>(), configuration = ref<Configuration>()
const selectedProvider = fragment?.provider as AuthProvider | undefined, providers = ref<AuthProvider[]>([])
const email = ref(''), password = ref(''), confirmPassword = ref(''), remember = ref(false), challenge = ref('')
const busy = ref(true), terminal = ref(false), verified = ref(false), resetDone = ref(false), error = ref<ApiError>()
const confirmationAccount = ref<ConfirmationAccount>()
let completion: CompletionFlow | undefined
try {
  email.value = localStorage.getItem('molis.auth.remembered-email') ?? ''; remember.value = !!email.value
  const saved = localStorage.getItem('molis.auth.locale'); if (saved === 'en' || saved === 'zh-CN') language.value = saved
} catch { /* Optional only. */ }
watch(language, value => { document.documentElement.lang = value; try { localStorage.setItem('molis.auth.locale', value) } catch { /* Optional only. */ } }, { immediate: true })
const title = computed(() => mode.value === 'register' ? t.value.register : mode.value === 'forgot-password' ? t.value.reset : mode.value === 'verify-email' ? t.value.verify : mode.value === 'complete' ? t.value.complete : mode.value === 'provider' ? t.value.providerTitle : t.value.login)
const message = computed(() => error.value ? t.value.errors[error.value.code] ?? t.value.errors.AUTH_INTERNAL_ERROR : '')
const actionable = computed(() => !!view.value && !busy.value && !terminal.value)
const externalLogin = computed(() => !!view.value && (view.value.context.clientId !== configuration.value?.console?.clientId || view.value.context.redirectUri !== configuration.value?.console?.redirectUri))
function switchMode(next: Mode) {
  mode.value = next; password.value = ''; confirmPassword.value = ''; challenge.value = ''; error.value = undefined
  history.replaceState(null, '', '/' + next)
}
function fail(cause: unknown) {
  error.value = cause instanceof ApiError ? cause : cause instanceof AuthError || cause instanceof ConsoleError ? new ApiError(cause.code, cause.requestId) : new ApiError('INVALID_RESPONSE')
  if (['NETWORK_ERROR', 'AUTH_UNAVAILABLE', 'AUTH_INTERNAL_ERROR', 'INVALID_RESPONSE', 'ACCOUNT_NOT_AVAILABLE', 'RESET_NOT_AVAILABLE'].includes(error.value.code)) terminal.value = true
}
async function handoff(url: string) { location.replace(checkedHandoff(url, transaction.value, location.origin)) }
async function startProvider(provider: AuthProvider) {
  if (!actionable.value || !providers.value.includes(provider)) return
  busy.value = true; error.value = undefined; password.value = ''
  try {
    saveProviderAttempt(sessionStorage, view.value!.context, provider)
    const result = await api<{ authorizationUrl: string }>('/providers/' + provider + '/start', transaction.value, {})
    const destination = checkedProviderUrl(result.authorizationUrl, provider, location.origin)
    rememberCompletion(sessionStorage, view.value!.context)
    location.replace(destination)
  } catch (cause) { terminal.value = true; fail(cause) }
  finally { busy.value = false }
}
async function finish() {
  if (!actionable.value || !completion || !confirmationAccount.value) return
  busy.value = true; error.value = undefined
  try { location.replace(checkedCallback(await completion.finish(true), view.value!.context)) }
  catch (cause) { terminal.value = true; fail(cause) }
  finally { busy.value = false }
}
async function cancelCompletion() {
  if (!actionable.value || !completion) return
  busy.value = true; error.value = undefined
  try { await completion.cancel(); error.value = new ApiError('LOGIN_CANCELLED') }
  catch (cause) { fail(cause) }
  finally { confirmationAccount.value = undefined; terminal.value = true; busy.value = false }
}
async function submit() {
  if (!actionable.value) return
  busy.value = true; error.value = undefined
  try {
    if (mode.value === 'login') {
      try { rememberEmail(localStorage, remember.value, email.value) } catch { /* Storage denial must not prevent login. */ }
      const result = await api<{ continueUrl: string }>('/transactions/password', transaction.value, { email: email.value, password: password.value })
      rememberCompletion(sessionStorage, view.value!.context)
      await handoff(result.continueUrl)
    } else if (mode.value === 'register') {
      if (password.value !== confirmPassword.value) throw new ApiError('PASSWORD_MISMATCH')
      const result = await api<{ continueUrl: string }>('/transactions/signup', transaction.value,
        { email: email.value, password: password.value, confirmPassword: confirmPassword.value })
      rememberCompletion(sessionStorage, view.value!.context)
      await handoff(result.continueUrl)
    } else { throw new ApiError('EMAIL_FLOW_UNAVAILABLE') }

  } catch (cause) { fail(cause) }
  finally { if(mode.value !== 'register' || terminal.value) { password.value = ''; confirmPassword.value = '' }; busy.value = false }
}
async function confirmEmail() {
  if (!fragment?.challenge || !fragment.token || busy.value || verified.value) return
  busy.value = true; error.value = undefined
  try { await api('/mailbox/verify', undefined, { challenge: fragment.challenge, secret: fragment.token, confirmed: true }); verified.value = true }
  catch (cause) { fail(cause) }
  finally { busy.value = false }
}
async function restart() {
  if (!view.value || busy.value) return
  busy.value = true; error.value = undefined
  try {
    const c = view.value.context
    const result = await api<{ transaction: string }>('/transactions', undefined, { clientId: c.clientId, redirectUri: c.redirectUri,
      codeChallenge: c.challenge, codeChallengeMethod: 'S256', state: c.state, scopes: c.scopes, forceLogin: true })
    transaction.value = result.transaction
    view.value = await api<View>('/transactions/context', transaction.value)
    terminal.value = false; resetDone.value = false; switchMode('login')
  } catch (cause) { fail(cause) } finally { busy.value = false }
}
onMounted(async () => {
  try {
    configuration.value = await api<Configuration>('/ui-configuration')
    if (configuration.value.authOrigin !== location.origin) throw new ApiError('AUTH_ORIGIN_REQUIRED')
    providers.value = enabledProviders(configuration.value)
    if (mode.value === 'forgot-password') return
    if (mode.value === 'provider-mailbox') return
    if (mode.value === 'verify-email') return // Never automatically POST an email confirmation.
    if ((mode.value === 'login' || mode.value === 'register') && !transaction.value) {
      const previous = takeProviderAttempt(sessionStorage)
      if (previous) { view.value = { context: previous, status: 'FAILED' }; terminal.value = true }
      if (fragment?.['provider-error'] || previous) {
        terminal.value = true; throw new ApiError(fragment?.['provider-error'] ?? 'PROVIDER_INTERRUPTED')
      }
      if (!directLoginEntry) { terminal.value = true; throw new ApiError('INVALID_TRANSACTION') }
      const options = checkedConsole({ authOrigin: configuration.value.authOrigin, console: configuration.value.console! }, location.origin)
      if (!options) throw new ApiError('CONSOLE_NOT_ENABLED')
      // Auth is itself a registered client. The SDK saves its PKCE verifier/state for /console/callback.
      // Stay on this page: direct visitors should immediately get the normal login form.
      const started = await new AuthClient(options).beginLogin({ forceLogin: true })
      transaction.value = readFragment(new URL(started.loginUrl).hash, 'login')?.transaction ?? ''
      if (!transaction.value) throw new ApiError('INVALID_RESPONSE')
    }
    if (mode.value === 'complete') { try { takeProviderAttempt(sessionStorage) } catch { /* Non-secret restart hint must not block a verified callback. */ } }
    if (!transaction.value) return
    view.value = await api<View>('/transactions/context', transaction.value)
    if (mode.value === 'complete') {
      if (view.value.status !== 'AUTHENTICATED') { terminal.value = true; throw new ApiError('INVALID_TRANSACTION') }
      completion = new CompletionFlow(transaction.value)
      try {
        const continueAutomatically = takeCompletion(sessionStorage, view.value.context)
        confirmationAccount.value = await completion.prepare()
        if (continueAutomatically) {
          location.replace(checkedCallback(await completion.finish(true), view.value.context))
          return
        }
      }
      catch (cause) { terminal.value = true; throw cause }
      return
    }
    if (view.value.status !== 'READY') { terminal.value = true; throw new ApiError('INVALID_TRANSACTION') }
    if (mode.value === 'provider' && (!selectedProvider || !providers.value.includes(selectedProvider))) throw new ApiError('PROVIDER_NOT_ENABLED')
    if (mode.value === 'login' && view.value.context.clientType === 'WEB' && !view.value.context.forceLogin) {
      try {
        const result = await api<{ continueUrl: string }>('/transactions/restore', transaction.value, {})
        if (!externalLogin.value) rememberCompletion(sessionStorage, view.value.context)
        await handoff(result.continueUrl)
      }
      catch (cause) { if (!(cause instanceof ApiError) || !['LOGIN_REQUIRED', 'FULL_LOGIN_REQUIRED'].includes(cause.code)) throw cause }
    }
  } catch (cause) { fail(cause) } finally { busy.value = false }
})
</script>

<template>
  <div class="shell auth-entry" :class="{ 'confirmation-entry': mode === 'complete' }">
    <header class="topbar"><a class="wordmark" href="/" aria-label="molis AI"><img class="brand-logo" :src="molisLogo" alt="" width="32" height="32" /><span class="brand-name">molis<span class="brand-ai">AI</span></span></a>
      <button class="language" type="button" @click="language = language === 'en' ? 'zh-CN' : 'en'">{{ language === 'en' ? '简体中文' : 'English' }}</button></header>
    <main class="layout">
      <section class="story"><div class="brand-note"><h1>{{ t.brandStatement }}</h1><p class="intro">{{ t.brandCaption }}</p></div>
      </section>
      <section class="panel" :aria-busy="busy">
        <div v-if="mode === 'login'" class="login-methods" role="group" :aria-label="t.loginMethods">
          <button type="button" class="login-method current" aria-current="true">{{ t.accountLogin }}</button>
          <button v-for="provider in (['google', 'apple'] as const)" :key="provider" type="button" class="login-method" :disabled="!actionable || !providers.includes(provider)" @click="startProvider(provider)">
            <span>{{ provider === 'google' ? 'Google' : 'Apple' }}</span><small v-if="!providers.includes(provider)">{{ t.notAvailable }}</small>
          </button>
        </div>
        <div v-if="mode === 'login'" class="login-welcome"><p>{{ t.description }}</p></div>
        <div class="entry-content">
        <div v-if="mode !== 'login' && !(mode === 'complete' && busy)" class="panel-heading"><h2>{{ title }}</h2><p v-if="mode === 'register'">{{ t.registerDescription }}</p><p v-else-if="mode === 'verify-email'">{{ t.verifyDescription }}</p></div>
        <p v-if="externalLogin && (mode === 'login' || mode === 'complete')" class="helper">{{ t.returnToApplication }}</p>
        <div v-if="error && !(error.code === 'INVALID_TRANSACTION' && !view)" class="notice error" role="alert"><p>{{ message }}</p><small v-if="error.retryAfter">{{ error.retryAfter }}s</small><small v-if="error.requestId">{{ t.request }}: {{ error.requestId }}</small></div>
        <button v-if="error?.code === 'INVALID_TRANSACTION' && view && !terminal" class="text-button" :disabled="busy" @click="restart">{{ t.restart }}</button>
        <div v-if="resetDone" class="notice success" role="status">{{ t.resetDone }}</div>
        <ProviderMailbox v-if="mode === 'provider-mailbox'" :transaction="transaction" :continuation="fragment?.continuation ?? ''" :language="language" :providers="providers" />
        <template v-else-if="mode === 'verify-email'">
          <p v-if="configuration && !configuration.mailboxEnabled" class="empty-message">{{ t.mailUnavailable }}</p>
          <div v-if="verified" class="notice success" role="status">{{ t.confirmed }}</div>
          <p v-else-if="!fragment" class="empty-message">{{ t.invalidLink }}</p>
          <ElButton v-else class="primary" type="primary" :loading="busy" :disabled="terminal || !configuration?.mailboxEnabled" @click="confirmEmail">{{ t.confirm }}</ElButton>
        </template>
        <template v-else-if="mode === 'forgot-password'"><p class="empty-message">{{ language === 'en' ? 'Password recovery is currently unavailable.' : '暂不支持找回密码。' }}</p><a href="/login">{{ t.login }}</a></template>
        <template v-else-if="!view"><p class="empty-message" role="status"><template v-if="busy">{{ t.checking }}</template><template v-else>{{ t.noTransaction }}<a class="login-recovery-link" href="/login">{{ t.signInAgain }}</a></template></p></template>
        <template v-else-if="mode === 'complete' && busy"><p class="empty-message" role="status">{{ t.checking }}</p></template>
        <template v-else-if="terminal"><p v-if="!resetDone" class="empty-message">{{ t.restartHint }}</p><ElButton class="primary" type="primary" :loading="busy" @click="restart">{{ t.restart }}</ElButton></template>
        <template v-else-if="mode === 'complete' && confirmationAccount">
          <p class="empty-message">{{ t.confirmAccountNotice }}</p>
          <div class="confirmation-account"><strong v-for="address in confirmationAccount.emails" :key="address">{{ address }}</strong></div>
          <ElButton class="primary" type="primary" :loading="busy" :disabled="!actionable" @click="finish">{{ t.confirmAccount }}</ElButton>
          <div class="switch-mode"><button class="text-button" :disabled="busy" @click="cancelCompletion">{{ t.cancelAccount }}</button></div>
        </template>
        <template v-else-if="mode === 'provider'">
          <p class="empty-message">{{ t.providerNotice }}</p>
          <ElButton v-if="selectedProvider" class="primary" type="primary" :loading="busy" :disabled="!actionable || !providers.includes(selectedProvider)" @click="startProvider(selectedProvider)">{{ selectedProvider === 'google' ? t.google : t.apple }}</ElButton>
          <div class="switch-mode"><button class="text-button" :disabled="busy" @click="switchMode('login')">{{ t.otherMethod }}</button></div>
        </template>
        <template v-else-if="mode !== 'complete'">
          <form @submit.prevent="submit">
            <label class="field" :class="{ 'login-field': mode === 'login' }" for="email"><span :class="{ 'visually-hidden': mode === 'login' }">{{ mode === 'login' ? t.loginIdentifier : t.email }}</span><ElInput id="email" v-model="email" :type="mode === 'login' ? 'text' : 'email'" autocomplete="username" required :maxlength="254" :disabled="busy" :placeholder="mode === 'login' ? t.loginIdentifier : 'you@example.com'" /></label>
            <label v-if="mode === 'login' || mode === 'register'" class="field" :class="{ 'login-field': mode === 'login' }" for="password"><span :class="{ 'visually-hidden': mode === 'login' }">{{ t.password }}</span><ElInput id="password" v-model="password" type="password" :placeholder="mode === 'login' ? t.password : undefined" :autocomplete="mode === 'login' ? 'current-password' : 'new-password'" required show-password :maxlength="512" :disabled="busy" /></label>
            <label v-if="mode === 'register'" class="field" for="confirm-password"><span>{{ language === 'en' ? 'Confirm password' : '确认密码' }}</span><ElInput id="confirm-password" v-model="confirmPassword" type="password" autocomplete="new-password" required show-password :maxlength="512" :disabled="busy" /></label>
            <p v-if="mode === 'register'" class="field-hint">{{ t.passwordHint }}</p>
            <ElButton class="primary" type="primary" native-type="submit" :loading="busy" :disabled="!actionable">{{ mode === 'login' ? t.submit : t.finishRegister }}</ElButton>
          </form>
        </template>
        </div>
        <div v-if="mode === 'login' && view && !terminal" class="entry-footer">
          <ElCheckbox v-model="remember" :disabled="busy">{{ t.remember }}</ElCheckbox>
          <button class="text-button" type="button" :disabled="busy" @click="switchMode('register')">{{ t.register }}</button>
        </div>
      </section>
    </main>
  </div>
</template>
