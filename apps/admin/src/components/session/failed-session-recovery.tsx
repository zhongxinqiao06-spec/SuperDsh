'use client'

import { useState } from 'react'
import { useManagementText } from '@/components/management/controls'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

export function FailedSessionRecovery({
  onRestore,
  uncertain = false,
  knownSession = false,
  onCheck,
}: {
  onRestore: (overwrite?: boolean) => 'restored' | 'conflict' | 'missing'
  uncertain?: boolean
  knownSession?: boolean
  onCheck?: () => void
}) {
  const tr = useManagementText()
  const [confirming, setConfirming] = useState(false)
  const [missing, setMissing] = useState(false)
  const restore = (overwrite = false) => {
    const result = onRestore(overwrite)
    setConfirming(result === 'conflict')
    setMissing(result === 'missing')
  }
  return (
    <div className="mx-auto mb-6 max-w-3xl rounded-xl border bg-background px-4 py-3 text-sm">
      <p className="mb-3 text-muted-foreground">
        {uncertain
          ? tr(
              '请求结果尚未确认，任务可能已经提交。请先刷新会话确认，不要重复发送；原始输入和附件仍保留在当前账号内存中。',
              'The request outcome is unknown and the task may have been submitted. Refresh the session before sending again. Your original message and attachments remain in this account’s memory.',
            )
          : tr(
              '会话创建未成功。可以恢复本次输入和附件，检查后手动发送。',
              'The session was not created. Restore your message and attachments, then review and send manually.',
            )}
      </p>
      {uncertain ? (
        <Button variant="outline" onClick={onCheck}>
          {knownSession
            ? tr('刷新当前会话', 'Refresh this session')
            : tr('刷新会话列表', 'Refresh sessions')}
        </Button>
      ) : (
        <Button variant="outline" onClick={() => restore()}>
          {tr('返回新会话编辑', 'Edit in a new session')}
        </Button>
      )}
      {missing && (
        <p role="alert" className="mt-2 text-destructive">
          {tr(
            '原始草稿已不可用。请复制上方消息，重新创建会话。',
            'The original draft is unavailable. Copy the message above to a new session.',
          )}
        </p>
      )}
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {tr('替换现有草稿？', 'Replace the current draft?')}
            </DialogTitle>
            <DialogDescription>
              {tr(
                '新会话中还有未发送的内容。恢复本次输入和附件会替换该草稿，不会自动发送。',
                'There is another unsent draft. Restoring this message and its attachments will replace it without sending.',
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)}>
              {tr('取消', 'Cancel')}
            </Button>
            <Button onClick={() => restore(true)}>
              {tr('替换并继续编辑', 'Replace and edit')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
