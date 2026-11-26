const messages: Record<string, string> = {
  'invalid or expired verification code':
    '验证码不正确或已过期，请检查邮箱或重新发送。',
  'registration email service unavailable': '暂时无法验证邮箱，请稍后重试。',
  'email verification is disabled': '暂时无法发送验证邮件，请稍后重试。',
  'verification email could not be sent':
    '邮件发送失败，请检查邮箱并稍后重试。',
  'wait 60 seconds before requesting another code':
    '请在上次发送 60 秒后重试。',
  'too many verification emails; try again later':
    '本小时发送次数已达上限，请稍后重试。',
  'too many incorrect codes; try again later':
    '验证码错误次数过多，请稍后重新获取。',
  'email is already in use': '此邮箱已有账号，请登录或找回密码。',
  'username or email is already in use': '账号或邮箱已注册，请登录或找回密码。',
  'registration is closed': '注册已关闭，可使用已有账号登录。',
  'a valid email address is required': '请输入有效的邮箱地址。',
}

/** 将验证码与注册错误转换为用户可执行的提示，未知失败保留原文。 */
export function registrationError(
  message: string,
  tr: (zh: string, en: string) => string,
  code?: string,
): string {
  const actionable: Record<string, [string, string]> = {
    verification_code_required: [
      '请先发送验证码，并使用最新一封邮件。',
      'Request a code and use the latest email.',
    ],
    verification_code_incorrect: [
      '验证码不正确，请核对最新邮件。',
      'Incorrect code. Check your latest email.',
    ],
    verification_code_expired: [
      '验证码已过期，请重新发送。',
      'This code expired. Request a new one.',
    ],
    verification_attempts_exhausted: [
      '验证码尝试次数已用完，请在倒计时结束后重新发送。',
      'Too many incorrect attempts. Request another code after the countdown.',
    ],
    verification_cooldown: [
      '验证码发送较频繁，请在倒计时结束后重试。',
      'Wait for the countdown before requesting another code.',
    ],
    registration_conflict: [
      '此邮箱已有星桥账号，可直接登录。',
      'This email already has a Starbridge account. Sign in to continue.',
    ],
  }
  const entry = code ? actionable[code] : undefined
  if (entry) return tr(...entry)
  const translated = messages[message]
  return typeof translated === 'string' ? tr(translated, message) : message
}
