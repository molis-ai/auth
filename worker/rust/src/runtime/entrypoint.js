import { WorkerEntrypoint } from 'cloudflare:workers'
import AuthWorker, { AuthInternalIdentity, PasswordKdf } from '../../build/index.js'
import { authBridgeTransport, isLocalInternalTransport } from './internal-transport.js'

export { PasswordKdf }

export default class extends AuthWorker {
  fetch(request) {
    const { origin, pathname } = new URL(request.url)
    // The dev runner listens only on the loopback interface.
    if (
      isLocalInternalTransport(this.env) &&
      origin === this.env.AUTH_ORIGIN &&
      pathname.startsWith('/internal/v1/')
    )
      return authBridgeTransport(request, this.env, AuthInternalIdentity.authorize)
    return super.fetch(request)
  }
}

export class AuthInternal extends WorkerEntrypoint {
  fetch(request) {
    return authBridgeTransport(request, this.env, AuthInternalIdentity.authorize)
  }
}
