import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Button, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { AttachmentDownload } from './AttachmentDownload.tsx'
import { object, string, labels, type Row } from './platform-model.ts'
import type { PlatformWorkspaceModel } from './use-platform-workspace.ts'
import { SkillRuns } from './SkillRuns.tsx'

const AgentPdfPreview = lazy(() =>
  import('./AgentPdfPreview.tsx').then((module) => ({
    default: module.AgentPdfPreview,
  })),
)
const planStates: Record<string, string> = {
  prepared: '等待方案确认',
  running: '正在生成',
  completed: '已生成',
  failed: '生成失败',
  cancelled: '已取消',
  interrupted: '执行已中断',
  'timed-out': '执行超时',
}

export function AgentArtifacts({ model }: { model: PlatformWorkspaceModel }) {
  const [preview, setPreview] = useState<Row | null>(null)
  const [previewError, setPreviewError] = useState('')
  const [loading, setLoading] = useState(false)
  const active = useRef(0)
  const verification = object(model.artifacts.answerVerification)
  useEffect(() => {
    active.current++
    setPreview(null)
    setPreviewError('')
    setLoading(false)
    return () => {
      active.current++
    }
  }, [model.request, model.sessionId])
  const loadPreview = async (file: Row) => {
    const generation = ++active.current
    setLoading(true)
    setPreview(null)
    setPreviewError('')
    try {
      const result = object(
        await model.request({
          operation: 'agent-artifact-preview',
          sessionId: model.sessionId,
          attachmentId: string(file.fileId),
        }),
      )
      if (generation !== active.current) return
      if (
        !['application/pdf', 'image/png', 'image/jpeg'].includes(
          string(result.mediaType),
        ) ||
        !string(result.contentBase64)
      )
        throw new Error('文档预览内容无效')
      setPreview(result)
    } catch (cause) {
      if (generation === active.current)
        setPreviewError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (generation === active.current) setLoading(false)
    }
  }
  return (
    <section className="productAgentArtifacts" aria-label="生成成果">
      <SkillRuns items={model.artifacts.skillRuns} />
      <div className="platformActions">
        <strong>生成成果与资料依据</strong>
        <Button
          size="sm"
          disabled={model.artifacts.loading}
          onClick={model.artifacts.refresh}
        >
          刷新成果
        </Button>
      </div>
      {model.artifacts.items.map((file) => (
        <div className="platformActions" key={string(file.fileId)}>
          <AttachmentDownload
            file={file}
            disabled={model.busy}
            download={model.downloadAttachment}
            run={model.run}
          />
          {/\.(xlsx|pptx|docx|png)$/i.test(string(file.name)) && (
            <Button
              size="sm"
              variant="outline"
              disabled={loading}
              onClick={() => void loadPreview(file)}
            >
              {object(file.preview).state === 'failed' ? '重试预览' : '预览'}
            </Button>
          )}
          {!!object(file.revision).planVersion && (
            <small>
              方案 v{String(object(file.revision).planVersion)}
              {object(file.revision).previousArtifactId ? ' · 修订成果' : ''}
            </small>
          )}
          {file.quality && (
            <small className={file.draft ? 'platformError' : undefined}>
              {file.draft
                ? '草稿 · 请查看质量诊断'
                : '已完成结构与实际渲染检查'}
            </small>
          )}
          {Array.isArray(file.diagnostics) &&
            file.diagnostics.map((message, index) => (
              <small
                key={index}
                className="platformError"
                style={{ width: '100%' }}
              >
                {string(message)}
              </small>
            ))}
        </div>
      ))}
      {loading && <p role="status">正在生成文档预览…</p>}
      {previewError && (
        <p role="alert" className="platformError">
          {previewError}
        </p>
      )}
      {preview && (
        <div className="productAgentPreviewFrame">
          <div className="platformActions">
            <strong>{string(preview.name)}</strong>
            <Button size="sm" onClick={() => setPreview(null)}>
              关闭预览
            </Button>
          </div>
          {string(preview.mediaType).startsWith('image/') ? (
            <img
              src={`data:${string(preview.mediaType)};base64,${string(preview.contentBase64)}`}
              alt={string(preview.name)}
              style={{ width: '100%', height: 'auto' }}
            />
          ) : (
            <Suspense fallback={<p>正在加载预览组件…</p>}>
              <AgentPdfPreview contentBase64={string(preview.contentBase64)} />
            </Suspense>
          )}
        </div>
      )}
      {model.artifacts.plans.map((plan) => (
        <details className="productAgentEvidence" key={string(plan.id)}>
          <summary>
            {string(plan.title)} · v{String(plan.version)} ·{' '}
            {plan.state === 'running' && plan.stage === 'rendering'
              ? '正在渲染最终文件'
              : (planStates[string(plan.state)] ?? string(plan.state))}
          </summary>
          <MarkdownText text={string(plan.summary)} labels={labels} />
          <details>
            <summary>完整方案数据</summary>
            <pre
              style={{
                maxHeight: 320,
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
              }}
            >
              {JSON.stringify(plan.document, null, 2)}
            </pre>
          </details>
          {plan.error && (
            <p role="alert" className="platformError">
              {string(plan.error)}
            </p>
          )}
          {plan.state === 'prepared' && (
            <small>请在聊天中的方案确认卡选择；需要修改时直接回复要求。</small>
          )}
        </details>
      ))}
      {model.artifacts.evidence.map((source) => {
        const location = object(source.location)
        return (
          <details className="productAgentEvidence" key={string(source.id)}>
            <summary>
              {string(source.filename)}
              {!Object.keys(location).length ? ' · 旧资料未记录原文位置' : ''}
              {location.page ? ` · 第 ${location.page} 页` : ''}
              {location.sheet ? ` · ${location.sheet}` : ''}
              {location.row ? ` · 第 ${location.row} 行` : ''}
            </summary>
            <p className="productAgentEvidenceText">{string(source.content)}</p>
            <small>
              {string(source.sourceId)} · {string(source.sha256).slice(0, 12)}
            </small>
          </details>
        )
      })}
      {!!string(verification.message) && (
        <div
          role={verification.status === 'invalid' ? 'alert' : 'status'}
          className="productAgentEvidence"
        >
          <p>{string(verification.message)}</p>
          {Array.isArray(verification.issues) &&
            verification.issues.map((issue) => (
              <p className="platformError" key={String(issue)}>
                {String(issue)}
              </p>
            ))}
        </div>
      )}
      {model.artifacts.loading && <small>正在读取成果…</small>}
      {!model.artifacts.loading &&
        !model.artifacts.error &&
        !model.artifacts.items.length && (
          <small>确认方案后，生成文件会显示在这里。</small>
        )}
      {model.artifacts.error && (
        <p role="alert" className="platformError">
          {model.artifacts.error}
        </p>
      )}
    </section>
  )
}
