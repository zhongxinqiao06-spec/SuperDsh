/** Profile choices crossing the desktop/backend boundary. */
export interface Features {
  remoteControl: boolean
  market: boolean
  dshMarket?: boolean
}
export interface OnboardingChoices {
  features: Features
  computerUse: boolean
}
export const DEFAULT_FEATURES: Readonly<Features> = {
  remoteControl: false,
  market: true,
}
