/** 实际旧Store/Hub接收与双服务场景相同的通知，受控SQL只提供隔离事实。 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { sessionMetadataUpdate } from './scenarios.ts'

type Row = Record<string, unknown>
interface Store {
  ingestSession(
    connection: object,
    connector: string,
    params: Row,
  ): Promise<Row>
  session(id: string, owner?: string, connection?: object): Promise<Row>
}
const legacy = new URL('../../../../admin/server/', import.meta.url)
const {
  ConversationStore,
}: { ConversationStore: new (db: object, online: () => boolean) => Store } =
  await import(new URL('conversations/store.ts', legacy).href)
const {
  ConnectorHub,
}: {
  ConnectorHub: {
    prototype: {
      notify(
        this: object,
        connector: string,
        method: string,
        params: Row,
      ): Promise<void>
    }
  }
} = await import(new URL('devices/connector-hub.ts', legacy).href)

function boundary() {
  const row: Row = {
    id: 'parity-session',
    connector_id: 'synthetic-connector',
    runtime: 'controlled',
    runtime_id: 'controlled',
    title: '合成会话',
    seq: 1,
    updated_seq: 1,
  }
  const events: Row[] = []
  let committed = false
  let writes = 0
  const connection = {
    query: async (sql: string, values: unknown[]) => {
      if (sql.startsWith('SELECT')) return [row]
      assert.ok(sql.startsWith('UPDATE sessions SET title='), sql)
      writes += 1
      Object.assign(row, {
        title: values[1],
        seq: Number(row.seq) + 1,
        updated_seq: Number(row.seq) + 1,
        last_synced_at: values[4],
        updated_at: values[4],
      })
      return [row]
    },
  }
  const db = {
    ...connection,
    transaction: async (work: (connection: object) => Promise<void>) => {
      await work(connection)
      committed = true
    },
  }
  const hub = {
    store: new ConversationStore(db, () => false),
    connectorAllowed: async () => undefined,
    isOnline: () => false,
    changed: async () => undefined,
    emit: (sessionId: string, sequence: number, type: string, payload: Row) => {
      assert.equal(committed, true, '事件必须发生在事务提交之后')
      events.push({ sessionId, sequence, type, payload })
    },
  }
  const notify = (params: Row) =>
    ConnectorHub.prototype.notify.call(
      hub,
      'synthetic-connector',
      'session.meta.upsert',
      params,
    )
  return { notify, events, writes: () => writes }
}

test('旧真实Store拒绝缺少runtime的元数据通知，不能误当作WS丢帧', async () => {
  const fixture = boundary()
  await assert.rejects(
    fixture.notify({ sessionId: 'parity-session', title: '订阅后的更新标题' }),
    { status: 422, message: 'runtime is required or invalid' },
  )
  assert.equal(fixture.writes(), 0)
  assert.deepEqual(fixture.events, [])
})

test('双服务使用的完整通知经旧Store提交后发出标题与序号一致的元数据事件', async () => {
  const fixture = boundary()
  const update = sessionMetadataUpdate('parity-session')
  await fixture.notify(update.params)
  assert.equal(fixture.writes(), 1)
  assert.equal(fixture.events.length, 1)
  const event = fixture.events[0]!
  assert.equal(event.type, 'session.meta.updated')
  assert.equal(event.sessionId, 'parity-session')
  assert.equal(event.sequence, 2)
  const session = (event.payload as Row).session as Row
  assert.equal(session.title, '订阅后的更新标题')
  assert.equal(session.updatedSeq, event.sequence)
})
