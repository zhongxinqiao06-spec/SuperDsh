'use client'

import { useEffect, useState } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { useManagementText } from '@/components/management/controls'
import { ManagementDialog } from '@/components/management/presentation'
import { MarkdownText } from '@/components/markdown-text'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardAction,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { announcementsApi } from '@/features/announcements/api'
import type { AnnouncementSettings } from '@/features/announcements/types'

export function ServiceAnnouncementCard({ token }: { token: string }) {
  const t = useTranslations('announcement.admin')
  const tr = useManagementText()
  const format = useFormatter()
  const [saved, setSaved] = useState<AnnouncementSettings | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [markdown, setMarkdown] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [reload, setReload] = useState(0)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    announcementsApi
      .settings(token)
      .then((value) => {
        if (cancelled) return
        setSaved(value)
        setEnabled(value.enabled)
        setMarkdown(value.markdown)
      })
      .catch(() => {
        if (!cancelled) setError(t('loadFailed'))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [token, reload, t])

  const invalid = enabled && !markdown.trim()
  const dirty =
    saved !== null && (enabled !== saved.enabled || markdown !== saved.markdown)
  const save = async () => {
    if (!dirty || invalid || saving) return
    setSaving(true)
    setError(null)
    try {
      const updated = await announcementsApi.save(token, { enabled, markdown })
      setSaved(updated)
      setEnabled(updated.enabled)
      setMarkdown(updated.markdown)
      setOpen(false)
      toast.success(t('saved'))
    } catch {
      setError(t('saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
          <CardDescription>{t('description')}</CardDescription>
          <CardAction>
            <Button
              variant="outline"
              disabled={!saved || loading}
              onClick={() => {
                if (!saved) return
                setEnabled(saved.enabled)
                setMarkdown(saved.markdown)
                setError(null)
                setOpen(true)
              }}
            >
              {tr('编辑公告', 'Edit announcement')}
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Spinner aria-label={t('loading')} />
          ) : (
            <>
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              {saved && (
                <div className="space-y-3 text-sm">
                  <p className="text-muted-foreground">
                    {tr(
                      saved.enabled ? '公告已启用' : '公告未启用',
                      saved.enabled
                        ? 'Announcement enabled'
                        : 'Announcement disabled',
                    )}
                  </p>
                  {saved.markdown.trim() ? (
                    <div className="max-h-48 overflow-y-auto rounded-lg border p-4 [overflow-wrap:anywhere]">
                      <MarkdownText text={saved.markdown} />
                    </div>
                  ) : (
                    <p className="text-muted-foreground">{t('notPublished')}</p>
                  )}
                </div>
              )}
            </>
          )}
        </CardContent>
        <CardFooter className="flex flex-wrap justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            {saved?.publishedAt
              ? t('publishedAt', {
                  time: format.dateTime(new Date(saved.publishedAt), {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  }),
                })
              : t('notPublished')}
          </p>
          {!saved && error && (
            <Button
              variant="outline"
              onClick={() => setReload((value) => value + 1)}
            >
              {t('retry')}
            </Button>
          )}
        </CardFooter>
      </Card>
      <ManagementDialog
        open={open}
        onOpenChange={setOpen}
        title={t('title')}
        description={t('description')}
        busy={saving}
        error={error ?? undefined}
        className="sm:max-w-2xl"
        footer={
          <>
            <Button
              variant="outline"
              disabled={saving}
              onClick={() => setOpen(false)}
            >
              {tr('取消', 'Cancel')}
            </Button>
            <Button
              disabled={loading || saving || !dirty || invalid}
              onClick={() => void save()}
            >
              {saving && <Spinner />}
              {t('save')}
            </Button>
          </>
        }
      >
        <FieldGroup>
          <Field orientation="horizontal" data-disabled={saving}>
            <FieldContent>
              <FieldLabel htmlFor="announcement-enabled">
                {t('enabled')}
              </FieldLabel>
              <FieldDescription>{t('enabledHint')}</FieldDescription>
            </FieldContent>
            <Switch
              id="announcement-enabled"
              checked={enabled}
              onCheckedChange={setEnabled}
              disabled={saving}
            />
          </Field>
          <Field data-invalid={invalid} data-disabled={saving}>
            <FieldLabel htmlFor="announcement-markdown">
              {t('content')}
            </FieldLabel>
            <Textarea
              id="announcement-markdown"
              value={markdown}
              onChange={(event) => setMarkdown(event.target.value)}
              className="min-h-48 max-h-80"
              rows={9}
              maxLength={20_000}
              disabled={saving}
              aria-invalid={invalid}
              aria-describedby="announcement-content-hint"
              placeholder={t('placeholder')}
            />
            <FieldDescription id="announcement-content-hint">
              {invalid ? t('contentRequired') : t('contentHint')}
            </FieldDescription>
          </Field>
          {markdown.trim() && (
            <Field>
              <FieldLabel>{t('preview')}</FieldLabel>
              <div className="max-h-72 overflow-y-auto rounded-lg border p-4 [overflow-wrap:anywhere]">
                <MarkdownText text={markdown} />
              </div>
            </Field>
          )}
        </FieldGroup>
      </ManagementDialog>
    </>
  )
}
