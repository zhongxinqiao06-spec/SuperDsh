import {
  ApiError,
  ApiRouter,
  integer,
  object,
  text,
  utcNow,
} from '../http/api-router.ts'
import { IdentityService, json, type Row } from '../identity/service.ts'

const keys: Record<string, string> = {
  totalUsers: 'users.total',
  newUsers: 'users.new',
  dau: 'users.dau',
  activeUsers: 'users.active_session_users',
  wau: 'users.wau',
  mau: 'users.mau',
  totalMessages: 'usage.messages',
  activeSessions: 'usage.active_sessions',
  avgMessagesPerActiveUser: 'usage.avg_messages_per_active_user',
  avgActiveSessionsPerActiveUser: 'usage.avg_active_sessions_per_active_user',
  totalDevices: 'devices.total',
  avgDevicesPerUser: 'devices.avg_per_user',
}
const deviceLabels = {
  macos: 'macOS',
  windows: 'Windows',
  linux: 'Linux',
  unknown: 'Unknown',
}
const agentLabels = {
  codex: 'Codex',
  claude: 'Claude Code',
  dsh: 'DeepSeek Harness',
}
const ratio = (value: number, total: number) =>
  total ? Math.round((value / total) * 100) / 100 : 0
interface Settings {
  intensity: { basis: string; lightMax: number; mediumMax: number }
  histogramBins: { messages: number[]; sessions: number[] }
}
const defaults: Settings = {
  intensity: { basis: 'messages', lightMax: 10, mediumMax: 50 },
  histogramBins: { messages: [0, 5, 20, 100], sessions: [0, 1, 5, 20] },
}
function normalizedBins(value: unknown): number[] {
  if (!Array.isArray(value) || value.length > 100)
    throw new ApiError(422, 'invalid histogram bins')
  return [...new Set([0, ...value.map((item) => integer(item, 0, 0))])].sort(
    (a, b) => a - b,
  )
}
export function histogram(values: number[], bins: number[]): Row[] {
  return bins.map((start, index) => {
    const end = bins[index + 1],
      lower = index === 0 ? start : start + 1,
      key = end === undefined ? `${lower}+` : `${lower}-${end}`
    return {
      key,
      label: key,
      count: values.filter(
        (value) => value >= lower && (end === undefined || value <= end),
      ).length,
      min: lower,
      max: end ?? null,
    }
  })
}
function autoSettings(facts: Row[]): Settings {
  const messages = facts
    .map((fact) => Number(fact.messages))
    .filter((value) => value > 0)
    .sort((a, b) => a - b)
  const sessions = facts
    .map((fact) => Number(fact.active_sessions))
    .filter((value) => value > 0)
    .sort((a, b) => a - b)
  const rank = (percentile: number) =>
    messages[Math.max(0, Math.ceil(messages.length * percentile) - 1)] || 0
  const bins = (values: number[]) =>
    [
      ...new Set([
        0,
        ...[0.5, 0.8, 0.95].map(
          (p) => values[Math.floor((values.length - 1) * p)] || 0,
        ),
      ]),
    ].sort((a, b) => a - b)
  return {
    intensity: { basis: 'messages', lightMax: rank(0.5), mediumMax: rank(0.8) },
    histogramBins: { messages: bins(messages), sessions: bins(sessions) },
  }
}
function dateValue(value: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value
  )
    throw new ApiError(422, 'invalid dashboard date')
  return value
}
function timezone(value: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format()
    return value
  } catch {
    throw new ApiError(422, 'invalid timezone')
  }
}
function today(zone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone(zone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts()
  const component = (type: string) =>
    parts.find((part) => part.type === type)!.value
  return `${component('year')}-${component('month')}-${component('day')}`
}
const daysAfter = (date: string, days: number) =>
  new Date(Date.parse(date) + days * 86400000).toISOString().slice(0, 10)
export class DashboardService {
  readonly identity: IdentityService
  constructor(identity: IdentityService) {
    this.identity = identity
  }
  async settings(): Promise<{ value: Settings; customized: boolean }> {
    const [row] = await this.identity.db.query<Row>(
      "SELECT value_json FROM dashboard_settings WHERE key='settings'",
    )
    return {
      value: json<Settings>(row?.value_json, defaults),
      customized: !!row,
    }
  }
  async updateSettings(body: Row): Promise<Settings> {
    const current = (await this.settings()).value
    const intensity =
      body.intensity !== undefined ? object(body.intensity) : current.intensity
    const lightMax = integer(intensity.lightMax, 10, 0),
      mediumMax = Math.max(lightMax, integer(intensity.mediumMax, 50, 0))
    const bins =
      body.histogramBins !== undefined
        ? object(body.histogramBins)
        : current.histogramBins
    const value: Settings = {
      intensity: { basis: 'messages', lightMax, mediumMax },
      histogramBins: {
        messages: normalizedBins(bins.messages),
        sessions: normalizedBins(bins.sessions),
      },
    }
    await this.identity.db.query(
      "INSERT INTO dashboard_settings(key,value_json,updated_at) VALUES('settings',$1,$2) ON CONFLICT(key) DO UPDATE SET value_json=EXCLUDED.value_json,updated_at=EXCLUDED.updated_at",
      [JSON.stringify(value), utcNow()],
    )
    return value
  }
  async snapshot(date: string, zone: string): Promise<Row> {
    dateValue(date)
    timezone(zone)
    const db = this.identity.db
    const [bounds] = await db.query<{
      start_at: string
      end_at: string
      week_at: string
      month_at: string
    }>(
      `SELECT
      to_char($1::date::timestamp AT TIME ZONE $2 AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS start_at,
      to_char(($1::date+1)::timestamp AT TIME ZONE $2 AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS end_at,
      to_char(($1::date-6)::timestamp AT TIME ZONE $2 AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS week_at,
      to_char(($1::date-29)::timestamp AT TIME ZONE $2 AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS month_at`,
      [date, zone],
    )
    const start = bounds!.start_at,
      end = bounds!.end_at
    const activitySql = `SELECT user_id,NULL::text AS session_id,last_seen_at AS event_time,0 AS message,0 AS created FROM platform_user_activity WHERE last_seen_at>=$1 AND last_seen_at<$2
      UNION ALL SELECT c.user_id,s.id,s.created_at,0,1 FROM sessions s JOIN connectors c ON c.id=s.connector_id WHERE s.origin='platform' AND s.created_at>=$1 AND s.created_at<$2
      UNION ALL SELECT c.user_id,s.id,t.item_time,1,0 FROM timeline_items t JOIN sessions s ON s.id=t.session_id JOIN connectors c ON c.id=s.connector_id WHERE t.type='message' AND t.role='user' AND t.payload_json LIKE '%"clientMessageId"%' AND t.item_time>=$1 AND t.item_time<$2`
    const facts = await db.query<Row>(
      `WITH activity AS (${activitySql}) SELECT user_id,sum(message)::integer AS messages,count(DISTINCT session_id)::integer AS active_sessions,sum(created)::integer AS created_sessions,max(event_time) AS last_activity_at FROM activity GROUP BY user_id`,
      [start, end],
    )
    const [users] = await db.query<Row>(
      'SELECT count(*)::integer AS total,count(*) FILTER(WHERE created_at>=$1)::integer AS new FROM users WHERE created_at<$2',
      [start, end],
    )
    const countActive = async (from: string) =>
      Number(
        (
          await db.query<Row>(
            `WITH activity AS (${activitySql}) SELECT count(DISTINCT user_id)::integer AS count FROM activity`,
            [from, end],
          )
        )[0]?.count,
      )
    const devices = await db.query<Row>(
      'SELECT id,user_id,device_os FROM connectors WHERE revoked=0',
    )
    const runtimes = await db.query<Row>(
      'SELECT DISTINCT r.connector_id,r.runtime_type FROM device_runtimes r JOIN connectors c ON c.id=r.connector_id WHERE c.revoked=0 AND r.config_json IS NOT NULL',
    )
    const activeAgents = await db.query<Row>(
      `WITH activity AS (${activitySql}) SELECT s.runtime,count(DISTINCT s.id)::integer AS count FROM sessions s JOIN activity a ON a.session_id=s.id GROUP BY s.runtime`,
      [start, end],
    )
    const deviceCounts: Record<string, number> = Object.fromEntries(
      Object.keys(deviceLabels).map((key) => [key, 0]),
    )
    const agents: Record<string, number> = Object.fromEntries(
      Object.keys(agentLabels).map((key) => [
        key,
        runtimes.filter((runtime) => runtime.runtime_type === key).length,
      ]),
    )
    for (const device of devices)
      deviceCounts[
        Object.hasOwn(deviceLabels, text(device.device_os))
          ? text(device.device_os)
          : 'unknown'
      ]!++
    const totalMessages = facts.reduce(
        (sum, row) => sum + Number(row.messages),
        0,
      ),
      activeSessions = facts.reduce(
        (sum, row) => sum + Number(row.active_sessions),
        0,
      ),
      totalUsers = Number(users?.total)
    const summary: Record<string, number> = {
      totalUsers,
      newUsers: Number(users?.new),
      dau: facts.length,
      activeUsers: facts.filter((row) => Number(row.active_sessions) > 0)
        .length,
      wau: await countActive(bounds!.week_at),
      mau: await countActive(bounds!.month_at),
      totalMessages,
      activeSessions,
      avgMessagesPerActiveUser: ratio(totalMessages, facts.length),
      avgActiveSessionsPerActiveUser: ratio(activeSessions, facts.length),
      totalDevices: devices.length,
      avgDevicesPerUser: ratio(devices.length, totalUsers),
    }
    const computed = utcNow(),
      metrics: {
        key: string
        dimension: string
        label: string
        value: number
      }[] = [{ key: 'snapshot.version', dimension: '', label: '', value: 5 }]
    for (const [key, metric] of Object.entries(keys))
      metrics.push({
        key: metric,
        dimension: '',
        label: '',
        value: summary[key]!,
      })
    for (const [label, value] of Object.entries(deviceCounts))
      metrics.push({
        key: 'devices.by_os',
        dimension: 'device_os',
        label,
        value,
      })
    for (const [label, value] of Object.entries(agents)) {
      metrics.push({
        key: 'agents.installed',
        dimension: 'agent',
        label,
        value,
      })
      metrics.push({
        key: 'sessions.by_agent',
        dimension: 'agent',
        label,
        value: Number(
          activeAgents.find((row) => row.runtime === label)?.count || 0,
        ),
      })
    }
    const saved = await this.settings(),
      effective = saved.customized ? saved.value : autoSettings(facts)
    for (const [name, field, bins] of [
      ['message', 'messages', effective.histogramBins.messages],
      ['session', 'active_sessions', effective.histogramBins.sessions],
    ] as const)
      for (const bucket of histogram(
        facts.map((row) => Number(row[field])),
        bins,
      ))
        metrics.push({
          key: `usage.${name}_histogram`,
          dimension: 'bucket',
          label: text(bucket.key),
          value: Number(bucket.count),
        })
    const segments = this.segments(facts, effective)
    for (const segment of segments)
      metrics.push({
        key: 'usage.intensity',
        dimension: 'segment',
        label: segment.segment,
        value: segment.count,
      })
    await db.transaction(async (connection) => {
      await connection.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `dashboard:${date}`,
      ])
      await connection.query(
        'DELETE FROM dashboard_daily_metrics WHERE date=$1',
        [date],
      )
      await connection.query(
        'DELETE FROM dashboard_user_daily_facts WHERE date=$1',
        [date],
      )
      for (const metric of metrics)
        await connection.query(
          'INSERT INTO dashboard_daily_metrics(date,metric_key,dimension_key,dimension_value,value,computed_at) VALUES($1,$2,$3,$4,$5,$6)',
          [
            date,
            metric.key,
            metric.dimension,
            metric.label,
            metric.value,
            computed,
          ],
        )
      for (const fact of facts) {
        const owned = devices.filter(
            (device) => device.user_id === fact.user_id,
          ),
          runtimeCounts = Object.keys(agentLabels).map(
            (kind) =>
              runtimes.filter(
                (runtime) =>
                  runtime.runtime_type === kind &&
                  owned.some((device) => device.id === runtime.connector_id),
              ).length,
          )
        const osCounts = Object.keys(deviceLabels).map(
          (kind) =>
            owned.filter(
              (device) =>
                (Object.hasOwn(deviceLabels, text(device.device_os))
                  ? text(device.device_os)
                  : 'unknown') === kind,
            ).length,
        )
        await connection.query(
          'INSERT INTO dashboard_user_daily_facts(date,user_id,messages,active_sessions,created_sessions,devices,macos_devices,windows_devices,linux_devices,unknown_devices,codex_agents,claude_agents,dsh_agents,last_activity_at,computed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)',
          [
            date,
            fact.user_id,
            fact.messages,
            fact.active_sessions,
            fact.created_sessions,
            owned.length,
            ...osCounts,
            ...runtimeCounts,
            fact.last_activity_at,
            computed,
          ],
        )
      }
    })
    return {
      date,
      computedAt: computed,
      metrics: metrics.length,
      users: facts.length,
      serverTime: utcNow(),
    }
  }
  segments(facts: Row[], settings: Settings) {
    return ['light', 'medium', 'heavy'].map((segment) => ({
      segment,
      label: segment[0]!.toUpperCase() + segment.slice(1),
      count: facts.filter((row) => {
        const count = Number(row.messages)
        return (
          count > 0 &&
          (count <= settings.intensity.lightMax
            ? 'light'
            : count <= settings.intensity.mediumMax
              ? 'medium'
              : 'heavy') === segment
        )
      }).length,
    }))
  }
  async overview(from: string, to: string, zone: string): Promise<Row> {
    dateValue(from)
    dateValue(to)
    timezone(zone)
    if (from > to || (Date.parse(to) - Date.parse(from)) / 86400000 > 366)
      throw new ApiError(422, 'invalid dashboard range; maximum 366 days')
    const db = this.identity.db,
      days: string[] = []
    for (let day = from; day <= to; day = daysAfter(day, 1)) {
      days.push(day)
      const [snapshot] = await db.query<Row>(
        "SELECT value,computed_at FROM dashboard_daily_metrics WHERE date=$1 AND metric_key='snapshot.version'",
        [day],
      )
      if (
        Number(snapshot?.value) !== 5 ||
        (day === today(zone) &&
          Date.now() - Date.parse(text(snapshot?.computed_at)) > 300000)
      )
        await this.snapshot(day, zone)
    }
    const metrics = await db.query<Row>(
      'SELECT * FROM dashboard_daily_metrics WHERE date>=$1 AND date<=$2',
      [from, to],
    )
    const series = days.map((day) => ({
      date: day,
      ...Object.fromEntries(
        Object.entries(keys).map(([key, metric]) => [
          key,
          Number(
            metrics.find(
              (row) =>
                row.date === day &&
                row.metric_key === metric &&
                !row.dimension_key,
            )?.value || 0,
          ),
        ]),
      ),
    }))
    const { date: _date, ...summary } = series[series.length - 1]!
    const facts = await db.query<Row>(
      'SELECT user_id,sum(messages)::integer AS messages,sum(active_sessions)::integer AS active_sessions FROM dashboard_user_daily_facts WHERE date>=$1 AND date<=$2 GROUP BY user_id',
      [from, to],
    )
    const saved = await this.settings(),
      settings = saved.customized ? saved.value : autoSettings(facts)
    const breakdown = (metric: string, labels: Record<string, string>) => {
      const rows = Object.entries(labels).map(([key, label]) => ({
          key,
          label,
          value: Number(
            metrics.find(
              (row) =>
                row.date === to &&
                row.metric_key === metric &&
                row.dimension_value === key,
            )?.value || 0,
          ),
        })),
        total = rows.reduce((sum, row) => sum + row.value, 0)
      return rows.map((row) => ({
        ...row,
        percent: ratio(row.value * 100, total),
      }))
    }
    return {
      range: { fromDate: from, toDate: to, timezone: zone },
      summary,
      series,
      messageHistogram: histogram(
        facts.map((row) => Number(row.messages)),
        settings.histogramBins.messages,
      ),
      sessionHistogram: histogram(
        facts.map((row) => Number(row.active_sessions)),
        settings.histogramBins.sessions,
      ),
      userSegments: this.segments(facts, settings),
      deviceBreakdown: breakdown('devices.by_os', deviceLabels),
      agentBreakdown: breakdown('agents.installed', agentLabels),
      sessionAgentBreakdown: breakdown('sessions.by_agent', agentLabels),
      settings: { ...settings, serverTime: utcNow() },
      serverTime: utcNow(),
    }
  }
}
export function registerDashboardRoutes(
  router: ApiRouter,
  identity: IdentityService,
): void {
  const service = new DashboardService(identity)
  router.add(
    'GET',
    '/admin/dashboard/settings',
    async () => ({ ...(await service.settings()).value, serverTime: utcNow() }),
    { permission: 'settings.manage' },
  )
  router.add(
    'PATCH',
    '/admin/dashboard/settings',
    async (context) => ({
      ...(await service.updateSettings(context.body)),
      serverTime: utcNow(),
    }),
    { permission: 'settings.manage' },
  )
  router.add(
    'GET',
    '/admin/dashboard/overview',
    async (context) => {
      const zone = context.url.searchParams.get('tz') || 'Asia/Shanghai',
        to = context.url.searchParams.get('to') || today(zone),
        from = context.url.searchParams.get('from') || daysAfter(to, -29)
      return service.overview(from, to, zone)
    },
    { permission: 'settings.manage' },
  )
  router.add(
    'POST',
    '/admin/dashboard/snapshots/today',
    async (context) => {
      const zone = context.url.searchParams.get('tz') || 'Asia/Shanghai'
      return service.snapshot(today(zone), zone)
    },
    { permission: 'settings.manage' },
  )
  router.add(
    'POST',
    '/admin/dashboard/snapshots/{target_date}',
    async (context) => {
      const zone = context.url.searchParams.get('tz') || 'Asia/Shanghai'
      return service.snapshot(context.params.target_date!, zone)
    },
    { permission: 'settings.manage' },
  )
}
