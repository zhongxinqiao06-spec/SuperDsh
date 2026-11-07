import { OfficeInputError } from './types.ts'

export interface PresentationDesignTheme {
  id: string
  version: string
  name: string
  fontFace: string
  background: string
  foreground: string
  accent: string
  secondary: string
  surface: string
  muted: string
  density: 'comfortable' | 'compact'
}

/** Versioned seed resources; tool configurations store editable copies, never agent-name branches. */
export const presentationThemes: PresentationDesignTheme[] = [
  {
    id: 'business-clean',
    version: '1.0.0',
    name: '商务简洁',
    fontFace: 'Noto Sans CJK SC',
    background: 'F8FAFC',
    foreground: '173044',
    accent: '087F8C',
    secondary: '326B9B',
    surface: 'EAF0F5',
    muted: '627688',
    density: 'comfortable',
  },
  {
    id: 'brand-proposal',
    version: '1.0.0',
    name: '品牌提案',
    fontFace: 'Noto Sans CJK SC',
    background: '17212B',
    foreground: 'F3F1EB',
    accent: 'F0BE78',
    secondary: '80B9AE',
    surface: '263540',
    muted: 'B4C1C8',
    density: 'comfortable',
  },
  {
    id: 'training',
    version: '1.0.0',
    name: '培训说明',
    fontFace: 'Noto Sans CJK SC',
    background: 'FBFAF6',
    foreground: '27344B',
    accent: '525DC1',
    secondary: '238C83',
    surface: 'EEF0F9',
    muted: '6B7285',
    density: 'comfortable',
  },
]
export function validatePresentationTheme(
  value: unknown,
): PresentationDesignTheme {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new OfficeInputError('设计主题必须为对象')
  const input = value as Record<string, unknown>
  const output = { ...presentationThemes[0]! }
  for (const key of [
    'background',
    'foreground',
    'accent',
    'secondary',
    'surface',
    'muted',
  ] as const) {
    if (input[key] === undefined) continue
    if (typeof input[key] !== 'string' || !/^[\da-f]{6}$/iu.test(input[key]))
      throw new OfficeInputError('设计主题颜色必须为六位十六进制值')
    output[key] = input[key].toUpperCase()
  }
  for (const key of ['id', 'name', 'version', 'fontFace'] as const) {
    if (input[key] === undefined) continue
    if (
      typeof input[key] !== 'string' ||
      !input[key].trim() ||
      input[key].length > 100 ||
      /[<>\\/\x00-\x1f]/u.test(input[key])
    )
      throw new OfficeInputError('设计主题标识、字体或版本无效')
    output[key] = input[key]
  }
  if (
    input.density !== undefined &&
    input.density !== 'comfortable' &&
    input.density !== 'compact'
  )
    throw new OfficeInputError('内容密度必须为 comfortable 或 compact')
  output.density = input.density === 'compact' ? 'compact' : 'comfortable'
  return output
}

export const presentationThemeSchema = {
  type: 'object',
  additionalProperties: false,
  properties: Object.fromEntries([
    ...(['id', 'name', 'version', 'fontFace'] as const).map((key) => [
      key,
      { type: 'string', maxLength: 100 },
    ]),
    ...(
      [
        'background',
        'foreground',
        'accent',
        'secondary',
        'surface',
        'muted',
      ] as const
    ).map((key) => [key, { type: 'string', minLength: 6, maxLength: 6 }]),
    ['density', { type: 'string', enum: ['comfortable', 'compact'] }],
  ]),
}
