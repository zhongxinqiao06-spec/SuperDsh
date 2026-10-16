import { createHmac, randomInt } from 'node:crypto'
import type { SqlConnection } from '../infrastructure/database.ts'
import { ApiError, text } from '../http/api-router.ts'
import {
  IdentityService,
  randomToken,
  tokenHash,
  equalSecret,
  type Row,
} from './service.ts'

/** Retains durable OTP attempt/rate counters and the existing Resend provider. */
export class EmailVerification {
  readonly identity: IdentityService
  constructor(identity: IdentityService) {
    this.identity = identity
  }
  scope(email: string, purpose: string, userId: string): string {
    return tokenHash(`${email}\0${purpose}\0${userId}`)
  }
  digest(nonce: string, code: string): string {
    return createHmac('sha256', this.identity.options.secret)
      .update(`email-code:${nonce}:${code}`)
      .digest('hex')
  }
  async consume(
    connection: SqlConnection,
    email: string,
    purpose: string,
    userId: string,
    code: unknown,
  ): Promise<boolean> {
    const scope = this.scope(email, purpose, userId),
      now = Math.floor(Date.now() / 1000)
    const [row] = await connection.query<Row>(
      'SELECT * FROM email_verification_codes WHERE scope=$1 FOR UPDATE',
      [scope],
    )
    if (
      !row ||
      row.consumed_at !== null ||
      Number(row.expires_at) <= now ||
      Number(row.failed_attempts) >= 5
    )
      return false
    if (
      !equalSecret(
        text(row.code_hash),
        this.digest(text(row.nonce), text(code)),
      )
    ) {
      await connection.query(
        'UPDATE email_verification_codes SET failed_attempts=failed_attempts+1 WHERE scope=$1',
        [scope],
      )
      return false
    }
    await connection.query(
      'UPDATE email_verification_codes SET consumed_at=$2 WHERE scope=$1',
      [scope, now],
    )
    return true
  }
  async issue(email: string, purpose: string, userId: string): Promise<void> {
    if (
      !['bind', 'register', 'reset'].includes(purpose) ||
      (purpose !== 'register' && !userId)
    )
      throw new ApiError(422, 'invalid email verification purpose')
    const settings = await this.identity.settingsObject('email_verification')
    if (!settings.enabled || !settings.apiKey || !settings.fromAddress)
      throw new ApiError(409, 'email verification is disabled')
    const code = String(randomInt(1000000)).padStart(6, '0'),
      nonce = randomToken(),
      scope = this.scope(email, purpose, userId),
      now = Math.floor(Date.now() / 1000)
    await this.identity.db.transaction(async (connection) => {
      const key = `email:${tokenHash(email)}`
      await connection.query(
        'INSERT INTO email_verification_limits(key,window_start,count) VALUES($1,$2,0) ON CONFLICT DO NOTHING',
        [key, now],
      )
      const [limit] = await connection.query<Row>(
        'UPDATE email_verification_limits SET count=CASE WHEN window_start<=$2 THEN 1 ELSE count+1 END,window_start=CASE WHEN window_start<=$2 THEN $3 ELSE window_start END WHERE key=$1 RETURNING count',
        [key, now - 3600, now],
      )
      if (Number(limit?.count) > 10)
        throw new ApiError(429, 'too many verification emails; try again later')
      await connection.query(
        `INSERT INTO email_verification_codes(scope,email,purpose,user_id,code_hash,nonce,sent_at,expires_at,failed_attempts,attempt_window)
        VALUES($1,$2,$3,$4,'','',0,0,0,$5) ON CONFLICT DO NOTHING`,
        [scope, email, purpose, userId, now],
      )
      const [row] = await connection.query<Row>(
        'SELECT * FROM email_verification_codes WHERE scope=$1 FOR UPDATE',
        [scope],
      )
      if (Number(row?.sent_at) > now - 60)
        throw new ApiError(
          429,
          'wait 60 seconds before requesting another code',
        )
      const reset = Number(row?.attempt_window) <= now - 3600
      if (Number(row?.failed_attempts) >= 5 && !reset)
        throw new ApiError(429, 'too many incorrect codes; try again later')
      await connection.query(
        'UPDATE email_verification_codes SET code_hash=$2,nonce=$3,sent_at=$4,expires_at=$5,consumed_at=NULL,failed_attempts=$6,attempt_window=$7 WHERE scope=$1',
        [
          scope,
          this.digest(nonce, code),
          nonce,
          now,
          now + 600,
          reset ? 0 : row?.failed_attempts,
          reset ? now : row?.attempt_window,
        ],
      )
    })
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${text(settings.apiKey)}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: settings.fromAddress,
          to: [email],
          subject: 'SuperDsh · 邮箱验证码 / Email verification',
          text: `你的 SuperDsh 邮箱验证码是：${code}\nYour SuperDsh verification code is: ${code}\n验证码 10 分钟内有效，请勿分享。`,
        }),
        signal: AbortSignal.timeout(15000),
      })
      const result = (await response.json()) as Row
      if (!response.ok || !result.id) throw new Error('delivery rejected')
    } catch {
      await this.identity.db.query(
        'UPDATE email_verification_codes SET consumed_at=$2 WHERE scope=$1 AND code_hash=$3',
        [scope, Math.floor(Date.now() / 1000), this.digest(nonce, code)],
      )
      throw new ApiError(502, 'verification email could not be sent')
    }
  }
}
