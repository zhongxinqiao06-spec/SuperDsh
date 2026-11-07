import type { OfficeArtifact, OfficeInputFile } from './types.ts'

export type TableValue = string | number | boolean | null

export interface TableSelection {
  fileIndex: number
  sheet?: string
  /** One-based physical row, including any title or blank rows. */
  headerRow?: number
  /** Original header -> product header. Unknown/duplicate headers fail. */
  mapping?: Record<string, string>
}

export interface SpreadsheetSource {
  fileIndex: number
  filename: string
  sha256: string
}

export interface TableIssue {
  severity: 'warning' | 'error'
  code: string
  message: string
  tableId: string
  row?: number
  column?: string
}

export interface SpreadsheetTable {
  id: string
  fileIndex: number
  filename: string
  sheet: string
  headerRow: number
  columns: string[]
  rows: TableValue[][]
  rowNumbers: number[]
}

export type FormulaExpression =
  | { literal: TableValue }
  | { column: string }
  | {
      op: '+' | '-' | '*' | '/' | '=' | '<>' | '<' | '<=' | '>' | '>='
      left: FormulaExpression
      right: FormulaExpression
    }
  | {
      fn:
        | 'IF'
        | 'ROUND'
        | 'ABS'
        | 'YEAR'
        | 'MONTH'
        | 'DAY'
        | 'DATE'
        | 'DAYS'
        | 'CONCAT'
        | 'TRIM'
        | 'UPPER'
        | 'LOWER'
      args: FormulaExpression[]
    }
  | {
      aggregate: 'sum' | 'average' | 'min' | 'max' | 'count' | 'countDistinct'
      column: string
      where?: TableCondition
    }
  | {
      lookup: {
        table: string
        keyColumn: string
        value: FormulaExpression
        returnColumn: string
        missing?: TableValue
      }
    }

export interface TableCondition {
  column: string
  operator:
    | 'eq'
    | 'ne'
    | 'gt'
    | 'gte'
    | 'lt'
    | 'lte'
    | 'contains'
    | 'empty'
    | 'notEmpty'
  value?: TableValue
}

export interface TableAggregate {
  column: string
  as: string
  operation: 'sum' | 'average' | 'min' | 'max' | 'count' | 'countDistinct'
}

export type SpreadsheetOperation =
  | { type: 'select'; columns: string[] }
  | { type: 'rename'; columns: Record<string, string> }
  | { type: 'trim'; columns: string[] }
  | {
      type: 'convert'
      column: string
      to: 'number' | 'text' | 'date' | 'boolean'
      onInvalid?: 'error' | 'blank'
    }
  | { type: 'filter'; conditions: TableCondition[]; match?: 'all' | 'any' }
  | { type: 'sort'; by: { column: string; direction?: 'asc' | 'desc' }[] }
  | { type: 'dedup'; columns: string[] }
  | { type: 'concat'; tables: string[] }
  | {
      type: 'join'
      table: string
      leftKey: string
      rightKey: string
      how: 'left' | 'inner'
      columns: Record<string, string>
    }
  | {
      type: 'group'
      by: string[]
      aggregates: TableAggregate[]
      currencyColumn?: string
    }
  | {
      type: 'pivot'
      rows: string[]
      columns: string
      value: string
      operation: 'sum' | 'count'
      currencyColumn?: string
    }
  | {
      type: 'formula'
      column: string
      expression: FormulaExpression
      numberFormat?: string
    }

export interface OfficeSpreadsheetPlan {
  title: string
  filename?: string
  sources?: TableSelection[]
  /** Explicit consent to extract table values from inputs with unsupported visual objects. */
  allowValueExtraction?: boolean
  sheets: {
    name: string
    source: string | { columns: string[]; rows: TableValue[][] }
    operations?: SpreadsheetOperation[]
    charts?: {
      type: 'column' | 'line' | 'pie'
      title: string
      category: string
      values: string[]
    }[]
  }[]
}

export interface OfficeSpreadsheetInput {
  inputs: OfficeInputFile[]
  plan: OfficeSpreadsheetPlan
  template?: OfficeInputFile
  signal?: AbortSignal
}

export interface OfficeWorkbookArtifact extends OfficeArtifact {
  provenance: SpreadsheetSource[]
  anomalies: TableIssue[]
  sheets: { name: string; columns: string[]; rowCount: number }[]
}
