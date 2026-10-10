/** Preferences remain readable when no Host or user plugin can start. */
import { join } from 'node:path'
import {
  DEFAULT_PREFERENCES,
  type DesktopPreferences,
} from '../contracts/desktop-contract.ts'
import { atomicJson, readPrivateFile } from './private-files.ts'

import { parsePreferences } from '@superdsh/core/contracts/preferences'
export {
  parsePreferences,
  portsChanged,
} from '@superdsh/core/contracts/preferences'

export class DesktopPreferenceStore {
  readonly file: string
  constructor(home: string) {
    this.file = join(home, 'desktop-preferences.json')
  }
  read(): DesktopPreferences {
    const text = readPrivateFile(this.file)
    return text === undefined
      ? { ...DEFAULT_PREFERENCES }
      : parsePreferences(JSON.parse(text))
  }
  write(value: unknown): DesktopPreferences {
    const preferences = parsePreferences(value)
    atomicJson(this.file, preferences)
    return preferences
  }
}
