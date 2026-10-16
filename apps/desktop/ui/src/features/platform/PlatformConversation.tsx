import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { platformConversationMessages } from '@superdsh/core/client/conversation'
import {
  ComposerCard,
  Button,
  Input,
  UserMessageBubble,
  MarkdownText,
  JsonBlock,
  MarkdownDelegateProvider,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { NoticePrompt } from './NoticePrompt.tsx'
import { NewSessionOptions } from './NewSessionOptions.tsx'
import { AgentDefinitionSelect } from './AgentDefinitionSelect.tsx'
import { AttachmentDownload } from './AttachmentDownload.tsx'
import { RemoteFiles } from './RemoteFiles.tsx'
import { RemoteTerminal } from './RemoteTerminal.tsx'
import { PlatformSelect } from './PlatformSelect.tsx'
import { object, rows, string, labels } from './platform-model.ts'
import type { PlatformWorkspaceModel } from './use-platform-workspace.ts'

/** API v2 presentation occupies the same main conversation region as native chat. */
export function PlatformConversation({
  model,
  header,
}: {
  model: PlatformWorkspaceModel
  header: ReactNode
}) {
  const {
    tab,
    setTab,
    sessionId,
    workspace,
    setWorkspace,
    device,
    online,
    error,
    busy,
    request,
    run,
  } = model
  const [filePath, setFilePath] = useState('')
  useEffect(() => setFilePath(''), [device, model.account?.identityGeneration])
  return (
    <div
      className="productRemoteConversation"
      data-conversation-target="platform"
      data-conversation-device={device}
      data-conversation-executor-kind={
        model.isServerAgent ? 'server-agent' : 'desktop'
      }
    >
      {header}
      <nav className="productRemoteTabs">
        {(['chat', 'files', 'terminal'] as const).map((value) => (
          <Button
            size="sm"
            type="button"
            key={value}
            aria-pressed={tab === value}
            onClick={() => setTab(value)}
          >
            {{ chat: '聊天', files: '文件', terminal: '终端' }[value]}
          </Button>
        ))}
      </nav>
      {error && (
        <p className="platformError" role="alert">
          {error}
        </p>
      )}
      {(!sessionId || tab !== 'chat') && (
        <label className="productRemoteWorkspace">
          {model.isServerAgent ? '服务端工作区' : '目标工作区'}
          <Input
            value={workspace}
            disabled={model.isServerAgent}
            onChange={(event) => setWorkspace(event.target.value)}
            placeholder={
              model.isServerAgent
                ? '正在读取服务端工作区'
                : '目标设备上的绝对路径'
            }
          />
        </label>
      )}
      {tab === 'chat' ? (
        <PlatformConversationBody
          model={model}
          openFile={(path) => {
            setFilePath(path)
            setTab('files')
          }}
        />
      ) : tab === 'files' ? (
        <RemoteFiles
          key={device + workspace}
          device={device}
          workspace={workspace}
          online={online}
          busy={busy}
          request={request}
          run={run}
          initialPath={filePath}
        />
      ) : (
        <RemoteTerminal
          key={device}
          device={device}
          workspace={workspace}
          online={online}
          busy={busy}
          request={request}
          run={run}
        />
      )}
    </div>
  )
}

function PlatformConversationBody({
  model,
  openFile,
}: {
  model: PlatformWorkspaceModel
  openFile(path: string): void
}) {
  const {
    source,
    bridge,
    hasOlder,
    olderItems,
    snapshot,
    busy,
    run,
    items,
    request,
    sessionId,
    loadOlder,
    notices,
    online,
    refreshSession,
    models,
    draft,
    setDraft,
    allows,
    setAttachments,
    attachments,
    send,
  } = model
  const messages = platformConversationMessages(items)
  const timeline = useRef<HTMLDivElement>(null)
  const filePicker = useRef<HTMLInputElement>(null)
  const followLatest = useRef(true)
  useLayoutEffect(() => {
    if (followLatest.current && timeline.current)
      timeline.current.scrollTop = timeline.current.scrollHeight
  }, [items, sessionId])
  if (!bridge) return null
  const readyToSend =
    !busy &&
    online &&
    (!!draft.trim() || attachments.length > 0) &&
    (sessionId
      ? allows('session.send_message')
      : !!model.workspace &&
        !model.agents.loading &&
        (!model.agents.selectedId ||
          model.agents.items.some(
            (agent) => agent.id === model.agents.selectedId,
          )) &&
        !!model.newSession.model &&
        !!model.newSession.permission)
  return (
    <>
      <div
        className="productRemoteTimeline"
        ref={timeline}
        onScroll={(event) => {
          const node = event.currentTarget
          followLatest.current =
            node.scrollHeight - node.scrollTop - node.clientHeight < 80
        }}
        data-chat-flow=""
        aria-live="polite"
      >
        {(hasOlder ||
          (olderItems.length === 0 &&
            object(snapshot.timeline).hasMore === true)) && (
          <Button
            size="sm"
            type="button"
            disabled={busy}
            onClick={() => {
              void run(async () => {
                if (!messages[0] || !source) return
                await loadOlder(messages[0].order)
              })
            }}
          >
            加载更早历史
          </Button>
        )}
        <MarkdownDelegateProvider
          openFile={async (path) => openFile(path)}
          openExternalLink={(url) => {
            window.open(url, '_blank', 'noopener,noreferrer')
          }}
        >
          {messages.map((message) => (
            <article
              className={
                message.role === 'user'
                  ? 'productUserMessage'
                  : 'productAssistantMessage'
              }
              key={message.id}
              data-role={message.role}
              data-message-id={message.id}
            >
              {message.role === 'user' ? (
                <UserMessageBubble>{message.text}</UserMessageBubble>
              ) : message.text ? (
                <MarkdownText
                  text={message.text}
                  streaming={message.status === 'running'}
                  labels={labels}
                />
              ) : (
                <JsonBlock
                  label={
                    string(message.content.title) ||
                    string(message.content.toolName) ||
                    string(message.content.name) ||
                    '操作记录'
                  }
                  payload={message.content}
                  truncatedLabel={(total) => `已截断 ${total} 项`}
                />
              )}
              {rows(message.content.attachments).map((file) => (
                <AttachmentDownload
                  file={file}
                  key={string(file.fileId)}
                  disabled={busy || !sessionId}
                  download={model.downloadAttachment}
                  run={run}
                />
              ))}
            </article>
          ))}
          {messages.length === 0 && (
            <p className="productRemoteEmpty">
              {sessionId
                ? '此会话尚无消息'
                : '选择目标工作区、模型和权限后，在这里开始会话。'}
            </p>
          )}
        </MarkdownDelegateProvider>
        {!!sessionId &&
          model.isServerAgent &&
          (model.agentBinding || model.artifacts.items.length > 0) && (
            <section className="productAgentArtifacts" aria-label="生成成果">
              <div className="platformActions">
                <strong>生成成果</strong>
                <Button
                  size="sm"
                  disabled={model.artifacts.loading}
                  onClick={model.artifacts.refresh}
                >
                  刷新成果
                </Button>
              </div>
              {model.artifacts.items.map((file) => (
                <AttachmentDownload
                  key={string(file.fileId)}
                  file={file}
                  disabled={busy}
                  download={model.downloadAttachment}
                  run={run}
                />
              ))}
              {model.artifacts.loading && <small>正在读取成果…</small>}
              {!model.artifacts.loading &&
                !model.artifacts.error &&
                model.artifacts.items.length === 0 && (
                  <small>智能体生成的文件会显示在这里。</small>
                )}
              {model.artifacts.error && (
                <p role="alert" className="platformError">
                  {model.artifacts.error}
                </p>
              )}
            </section>
          )}
      </div>
      <div className="productRemoteComposer">
        {notices.map((notice) => (
          <NoticePrompt
            key={string(notice.noticeId)}
            notice={notice}
            sessionId={sessionId}
            disabled={busy || !online}
            request={request}
            run={run}
            refresh={refreshSession}
          />
        ))}
        <ComposerCard>
          <AgentDefinitionSelect
            agents={model.agents}
            disabled={busy || !online}
          />
          {!!sessionId && model.isServerAgent && model.agentBinding && (
            <small className="productAgentBinding">
              智能体：{model.agentBinding.name} · v{model.agentBinding.version}
              （本会话已固定）
            </small>
          )}
          {!sessionId && (
            <NewSessionOptions
              options={model.newSession}
              disabled={busy || !online}
            />
          )}
          {!!sessionId && models.length > 0 && (
            <PlatformSelect
              label="会话模型"
              placeholder="目标默认模型"
              side="top"
              value={string(object(object(snapshot.state).selections).model)}
              disabled={busy || !online}
              onChange={(selectedModel) => {
                void run(async () => {
                  await request({
                    operation: 'selections',
                    sessionId,
                    body: { selections: { model: selectedModel } },
                  })
                  await refreshSession()
                })
              }}
              options={[
                { value: '', label: '目标默认模型' },
                ...models.map((row) => ({
                  value: string(row.selectionId) || string(row.id),
                  label:
                    string(row.displayName) ||
                    string(row.name) ||
                    string(row.id),
                })),
              ]}
            />
          )}
          <textarea
            aria-label="聊天消息"
            placeholder={online ? '发送消息…' : '目标设备离线，连接后可发送'}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={!online || busy}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing &&
                readyToSend
              ) {
                event.preventDefault()
                void run(send)
              }
            }}
          />
          <div className="platformActions">
            <Button
              size="sm"
              disabled={
                !sessionId || !online || busy || !allows('runtime.attachment')
              }
              onClick={() => filePicker.current?.click()}
            >
              添加附件
            </Button>
            <input
              ref={filePicker}
              hidden
              aria-label="上传附件"
              type="file"
              multiple
              disabled={
                !sessionId || !online || busy || !allows('runtime.attachment')
              }
              onChange={(event) => {
                const files = [...(event.target.files ?? [])]
                event.target.value = ''
                void run(async () => {
                  const value = object(
                    await model.upload(
                      await Promise.all(
                        files.map(async (file) => ({
                          name: file.name,
                          type: file.type,
                          data: new Uint8Array(await file.arrayBuffer()),
                        })),
                      ),
                    ),
                  )
                  setAttachments((previous) => [
                    ...previous,
                    ...(Array.isArray(value.attachments)
                      ? value.attachments
                      : []),
                  ])
                })
              }}
            />
            {attachments.map((file, index) => (
              <Button
                size="sm"
                key={index}
                onClick={() =>
                  setAttachments((previous) =>
                    previous.filter((_, position) => position !== index),
                  )
                }
              >
                {string(object(file).name) || '附件'} ×
              </Button>
            ))}
            <Button
              size="sm"
              variant="primary"
              className="productRemoteSend"
              disabled={!readyToSend}
              onClick={() => {
                void run(send)
              }}
            >
              发送
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={
                busy || !online || !sessionId || !allows('session.interrupt')
              }
              onClick={() => {
                void run(async () => {
                  await source?.cancel()
                  await refreshSession()
                })
              }}
            >
              停止
            </Button>
          </div>
        </ComposerCard>
      </div>
    </>
  )
}
