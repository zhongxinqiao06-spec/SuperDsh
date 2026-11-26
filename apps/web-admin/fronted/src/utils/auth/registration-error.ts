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
): string {
  const translated = messages[message]
  return typeof translated === 'string' ? tr(translated, message) : message
}
