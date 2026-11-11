/** 直接执行旧FileService.stage，存储端只收集合成内容与元数据。 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { loadLegacy } from './legacy-boundary.ts'
type Row = Record<string, unknown>
const { FileService } = await loadLegacy<{
  FileService: {
    prototype: {
      stage(
        this: object,
        owner: string,
        session: string,
        values: Row[],
      ): Promise<Row[]>
    }
  }
}>('files/service.ts')
async function probe(values: Row[]): Promise<Row> {
  let writes = 0
  const fake = {
    hub: { store: { session: async () => ({ id: 'session' }) } },
    save: async (
      _owner: string,
      _session: string,
      name: string,
      data: Buffer,
      mediaType: string,
    ) => {
      writes++
      return {
        name,
        mediaType,
        size: data.length,
        sha256: createHash('sha256').update(data).digest('hex'),
      }
    },
    read: async () => ({
      metadata: {
        name: 'existing.txt',
        mediaType: 'text/plain',
        size: 4,
        sha256: createHash('sha256').update('test').digest('hex'),
      },
    }),
  }
  try {
    const result = await FileService.prototype.stage.call(
      fake,
      'owner',
      'session',
      values,
    )
    return {
      status: 200,
      writes,
      items: result.map(
        ({ downloadUrl: _download, platformOpenUrl: _open, ...item }) => item,
      ),
    }
  } catch (error) {
    const failure = error as Error & { status?: number }
    return { status: failure.status ?? 500, detail: failure.message, writes }
  }
}
const inputs: Row[][] = JSON.parse(readFileSync(0, 'utf8'))
process.stdout.write(JSON.stringify(await Promise.all(inputs.map(probe))))
