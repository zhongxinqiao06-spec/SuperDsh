/** DSH parameter DSL, intentionally distinct from resource JSON Schemas. */
export const skillControlParameters = {
  action: { type: 'string', required: true },
  argumentsJson: { type: 'string', required: true },
}
