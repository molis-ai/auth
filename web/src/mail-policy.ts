export interface MailDelivery {
  id: string; recipientEmail: string; templateKey: string; status: string; attempts: number
  createdAt: string; lastErrorCode: string | null; resendOf: string | null; retryId: string | null
}
export function canResendMail(mail: MailDelivery): boolean {
  return mail.status === 'FAILED' && mail.resendOf === null && mail.retryId === null
    && ['ACCOUNT_REGISTERED', 'PASSWORD_CHANGED', 'SPACE_INVITED'].includes(mail.templateKey)
}
