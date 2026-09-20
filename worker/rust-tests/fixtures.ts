import { createHash, randomBytes } from 'node:crypto'

// Test data only, never imported by the deployed Worker.
export const secret = () => randomBytes(32).toString('base64url')
export const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export const challenge = (value: string) => createHash('sha256').update(value).digest('base64url')
