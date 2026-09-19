// Isolated test entry: not imported by the application and never deployed.
import { avatar } from '../../src/security/avatar.ts'
export default {
  async fetch(request: Request) {
    try {
      return Response.json({ avatar: await avatar(await request.json()) })
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 400 })
    }
  },
}
