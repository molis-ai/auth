import { AuthClient, AuthError } from '/sdk.js'

const status = document.querySelector('#status'), identity = document.querySelector('#identity')
const password = document.querySelector('#password'), buttons = [...document.querySelectorAll('button')]
function showIdentity(user) {
  // Deliberately enumerate display fields rather than dump arbitrary protocol responses.
  identity.textContent = JSON.stringify({ userId: user.userId, emails: user.emails, applicationId: user.applicationId, clientId: user.clientId }, null, 2)
}
async function action(callback) {
  buttons.forEach(button => { button.disabled = true }); status.textContent = '处理中…'
  try { await callback() }
  catch (error) { status.textContent = error instanceof AuthError ? '操作未完成：' + error.code : '操作未完成，请重新开始'; identity.textContent = '' }
  finally { password.value = ''; buttons.forEach(button => { button.disabled = false }) }
}
await action(async () => {
  const response = await fetch('/configuration', { cache: 'no-store', redirect: 'error' })
  if (!response.ok) throw Error('Configuration unavailable')
  const auth = new AuthClient(await response.json())
  document.querySelector('#password-form').addEventListener('submit', event => {
    event.preventDefault()
    const value = password.value; password.value = ''
    action(() => auth.signInWithPassword(document.querySelector('#email').value, value))
  })
  document.querySelector('#hosted').addEventListener('click', () => action(() => auth.signIn()))
  document.querySelector('#restore').addEventListener('click', () => action(async () => {
    if (!await auth.restore()) status.textContent = '已暂停恢复，请主动点击登录。'
  }))
  document.querySelector('#me').addEventListener('click', () => action(async () => {
    showIdentity(await auth.currentUser()); status.textContent = '当前身份校验成功。'
  }))
  for (const [selector, all] of [['#logout', false], ['#logout-all', true]]) {
    document.querySelector(selector).addEventListener('click', () => action(async () => {
      const result = await auth.logout({ all }); identity.textContent = ''
      status.textContent = (result.serverRevoked ? '服务端已确认' + (all ? '全部退出' : '退出当前产品') : '本地已退出，但服务端撤销尚未确认')
        + (result.restorePaused ? '；已暂停恢复。' : '；无法持久保存暂停恢复状态。')
    }))
  }
  if (await auth.handleRedirect()) { showIdentity(await auth.currentUser()); status.textContent = 'SDK 登录成功，已清理回调 URL。' }
  else status.textContent = auth.restorePaused ? '已退出；请主动点击登录。' : '尚未持有内存 Token，可选择登录或顶层恢复。'
})
