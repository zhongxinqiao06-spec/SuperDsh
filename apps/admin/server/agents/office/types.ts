export interface OfficeInputFile {
  filename: string
  content: Buffer
}

export interface SalesRow {
  orderId: string
  date: string
  region: string
  product: string
  quantity: number
  unitPrice: number
  unitCost: number
}

export interface SalesGroup {
  name: string
  orders: number
  units: number
  revenue: number
  cost: number
  profit: number
}

export interface SalesSummary {
  orderCount: number
  units: number
  revenue: number
  cost: number
  profit: number
  grossMargin: number | null
  periodStart: string
  periodEnd: string
  regions: SalesGroup[]
  products: SalesGroup[]
}

export interface OfficeArtifact extends OfficeInputFile {
  mediaType: string
  summary?: SalesSummary
}

export interface SalesReportInput {
  data: OfficeInputFile
  template?: OfficeInputFile
  companyName?: string
  title?: string
}

export interface KnowledgeText {
  filename: string
  text: string
}

export class OfficeInputError extends Error {
  readonly code = 'invalid_office_input'

  constructor(message: string) {
    super(message)
    this.name = 'OfficeInputError'
  }
}
