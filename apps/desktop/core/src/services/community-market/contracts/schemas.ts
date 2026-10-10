import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  Ajv2020,
  type AnySchema,
  type ValidateFunction,
} from 'ajv/dist/2020.js'
import type { FormatsPlugin } from 'ajv-formats'
import type { CatalogProviderPage } from '../../../contracts/community-market/generated/catalog-provider-page.js'
import type { CatalogQuery } from '../../../contracts/community-market/generated/catalog-query.js'
import type { CatalogSnapshot } from '../../../contracts/community-market/generated/catalog-snapshot.js'
import type { CatalogSourceManifest } from '../../../contracts/community-market/generated/catalog-source.js'

type ContractValidators = {
  readonly source: ValidateFunction<CatalogSourceManifest>
  readonly query: ValidateFunction<CatalogQuery>
  readonly providerPage: ValidateFunction<CatalogProviderPage>
  readonly snapshot: ValidateFunction<CatalogSnapshot>
}

function readSchema(name: string): AnySchema {
  // The same source is compiled by the thin plugin package and tested in the
  // desktop tree. Locate the declared plugin asset root in either placement.
  let directory = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    for (const candidate of [
      directory,
      join(directory, 'dsh-community-market'),
    ]) {
      const manifest = join(candidate, 'package.json')
      if (!existsSync(manifest)) continue
      const identity = JSON.parse(readFileSync(manifest, 'utf8')) as {
        name?: unknown
      }
      if (identity.name === 'dsh-community-market')
        return JSON.parse(
          readFileSync(
            join(candidate, 'docs/schemas', `${name}.schema.json`),
            'utf8',
          ),
        ) as AnySchema
    }
    const parent = dirname(directory)
    if (parent === directory)
      throw new Error('Community market schema package is missing')
    directory = parent
  }
}

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  validateFormats: true,
})
const require = createRequire(import.meta.url)
const addFormats = require('ajv-formats') as FormatsPlugin
addFormats(ajv)

export const validators: ContractValidators = {
  source: ajv.compile<CatalogSourceManifest>(readSchema('catalog-source')),
  query: ajv.compile<CatalogQuery>(readSchema('catalog-query')),
  providerPage: ajv.compile<CatalogProviderPage>(
    readSchema('catalog-provider-page'),
  ),
  snapshot: ajv.compile<CatalogSnapshot>(readSchema('catalog-snapshot')),
}
