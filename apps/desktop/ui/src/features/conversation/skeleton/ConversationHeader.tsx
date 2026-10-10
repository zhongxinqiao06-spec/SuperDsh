/** Resident conversation navigation and Session-specific header content. */
import clsx from 'clsx'
import type { ConversationHeaderProps } from '../contract/slots.ts'
import { conversationPhase } from '../contract/snapshot.ts'
import css from './ConversationRoot.module.css'
import { useProductWorkspace } from '../../platform/product-workspace-store.ts'
import { object, string } from '../../platform/platform-model.ts'

/**
 * Keeps global navigation available before a Session exists.
 * @param props - Optional Session sources and authorized header slots.
 * @returns The persistent header with any selected Session's title and views.
 */
export function ConversationHeader(props: ConversationHeaderProps) {
  const workspace = useProductWorkspace()
  if (workspace?.target.kind === 'platform')
    return (
      <header className={css.header} data-conversation-header="">
        <div className={css.headerLeading} data-conversation-header-leading="">
          {props.renderSlot('conversation.header.leading', {})}
        </div>
        <div className={css.titleRow} data-conversation-title-row="">
          <strong className={css.titleCluster}>
            {string(object(workspace.snapshot.session).title) ||
              string(workspace.selected?.name) ||
              '远程设备'}
          </strong>
          <small>
            {workspace.online
              ? '在线'
              : workspace.selected?.blockedAt
                ? '已停用'
                : '离线'}
          </small>
        </div>
      </header>
    )
  return <NativeConversationHeader {...props} />
}
function NativeConversationHeader({
  sessionId,
  useSession,
  useConversation,
  renderSlot,
}: ConversationHeaderProps) {
  const session = useSession((s) => s)
  const conversation = useConversation((s) => s)
  const blank =
    session === undefined ||
    conversation === undefined ||
    (session.blank && conversationPhase(session, conversation) === 'blank')
  return (
    <header
      className={clsx(
        css.header,
        blank && css.headerBlank,
        sessionId === undefined && css.headerSessionless,
      )}
      data-conversation-header=""
    >
      <div className={css.headerLeading} data-conversation-header-leading="">
        {renderSlot('conversation.header.leading', {})}
      </div>
      {sessionId === undefined ? (
        <div className={css.titleRow} data-conversation-title-row="" />
      ) : (
        renderSlot('conversation.session.header', { hideChrome: blank })
      )}
    </header>
  )
}
