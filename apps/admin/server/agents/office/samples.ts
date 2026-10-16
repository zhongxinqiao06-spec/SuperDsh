import { createSalesPresentationTemplate } from './presentation.ts'
import { createSalesWorkbookTemplate } from './spreadsheet.ts'

/** Fictional data is generated on demand, never stored as a runtime artifact in source. */
export async function createDemoAssets() {
  const regions = ['华东', '华南', '华北', '西南']
  const products = [
    { name: '办公收纳箱', price: 49.9, cost: 31.2 },
    { name: '会议笔记本', price: 29.8, cost: 16.5 },
    { name: '桌面支架', price: 89, cost: 52 },
    { name: '商务文件夹', price: 19.9, cost: 10.8 },
    { name: '便携水杯', price: 69, cost: 39.5 },
  ]
  const records = ['orderId,date,region,product,quantity,unitPrice,unitCost']
  for (let index = 0; index < 100; index++) {
    const product = products[index % products.length]!
    const date = new Date(Date.UTC(2026, 8, 1 + (index % 30)))
      .toISOString()
      .slice(0, 10)
    records.push(
      [
        `XH-DEMO-${String(index + 1).padStart(4, '0')}`,
        date,
        regions[index % regions.length],
        product.name,
        2 + (index % 19),
        product.price,
        product.cost,
      ].join(','),
    )
  }
  return {
    sales: {
      filename: '星河商贸-虚构销售数据.csv',
      content: Buffer.from(records.join('\n'), 'utf8'),
    },
    knowledge: {
      filename: '星河商贸-虚构公司资料.md',
      content: Buffer.from(
        '# 星河商贸（虚构演示公司）\n\n星河商贸为虚构的办公用品供应企业，业务覆盖华东、华南、华北和西南区域。\n\n经营原则：按已确认订单安排备货，定期复核库存与商品毛利，销售结论须引用原始台账。\n\n本文件和配套订单均为演示生成，不代表任何真实公司、客户或交易。',
        'utf8',
      ),
    },
    workbookTemplate: await createSalesWorkbookTemplate(),
    presentationTemplate: await createSalesPresentationTemplate(),
  }
}
