/** Account Homes never discover credentials from the launching user's model environment. */
export function accountEnvironment(
  environment: NodeJS.ProcessEnv,
  home: string,
): NodeJS.ProcessEnv {
  const next = { ...environment, HOME: home, USERPROFILE: home }
  for (const name of Object.keys(next)) {
    if (
      /(?:API_?KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(
        name,
      ) ||
      /^(?:DEEPSEEK|ANTHROPIC|OPENAI|GOOGLE_APPLICATION_CREDENTIALS|AWS_PROFILE|AWS_CONFIG_FILE|AWS_SHARED_CREDENTIALS_FILE)/i.test(
        name,
      )
    )
      delete next[name as keyof typeof next]
  }
  return next
}
