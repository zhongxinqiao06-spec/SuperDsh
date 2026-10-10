import type { PlatformWorkspaceModel } from './use-platform-workspace.ts'
import { string } from './platform-model.ts'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
export function DeviceSidebar({ model }: { model: PlatformWorkspaceModel }) {
  const {
    busy,
    run,
    refreshSessions,
    sessionId,
    setSessionId,
    sessions,
    sessionCursor,
    loadMoreSessions,
  } = model
  return (
    <aside aria-label="目标设备会话">
      <div className="productRemoteSessionHeading">
        <span>会话</span>
        <Button
          size="sm"
          disabled={busy}
          onClick={() => {
            void run(refreshSessions)
          }}
        >
          刷新
        </Button>
        <Button
          size="sm"
          onClick={() => {
            setSessionId('')
            model.setTab('chat')
            window.dispatchEvent(new Event('superdsh:conversation-target'))
          }}
        >
          新建
        </Button>
      </div>
      {model.device && (
        <>
          {sessions.map((row) => (
            <Button
              className={sessionId === row.id ? 'selected' : ''}
              key={string(row.id)}
              onClick={() => {
                setSessionId(string(row.id))
                model.setTab('chat')
                window.dispatchEvent(new Event('superdsh:conversation-target'))
              }}
            >
              {string(row.title) || '新会话'}
            </Button>
          ))}
          {sessionCursor && (
            <Button
              size="sm"
              disabled={busy}
              onClick={() => {
                void run(loadMoreSessions)
              }}
            >
              加载更多会话
            </Button>
          )}
        </>
      )}
    </aside>
  )
}
