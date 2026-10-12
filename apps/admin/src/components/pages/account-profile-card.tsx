'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { useAuth } from '@/components/auth/auth-context'
import { useManagementText } from '@/components/management/controls'
import { ManagementDialog } from '@/components/management/presentation'
import {
  EmailCodeField,
  DisplayNameField,
} from '@/components/auth/account-identity-fields'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { SettingsSection } from '@/components/settings/settings-section'
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { authApi } from '@/features/auth/api'
import {
  isValidEmail,
  isValidDisplayName,
  normalizeEmail,
} from '@/features/auth/account-profile'
import type { AuthMe } from '@/features/auth/types'

export function AccountProfileCard({
  me,
  token,
  onMeChange,
}: {
  me: AuthMe
  token: string
  onMeChange: (me: AuthMe) => void
}) {
  const t = useTranslations('pages.settings.profile')
  const tr = useManagementText()
  const { emailVerificationRequired, refreshConfig } = useAuth()
  const [displayName, setDisplayName] = useState(me.displayName)
  const [email, setEmail] = useState(me.email ?? '')
  const [code, setCode] = useState('')
  const [saving, setSaving] = useState<'displayName' | 'email' | null>(null)
  const [editing, setEditing] = useState<'displayName' | 'email' | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    setDisplayName(me.displayName)
  }, [me.displayName])
  useEffect(() => {
    setEmail(me.email ?? '')
    setCode('')
  }, [me.email])
  useEffect(() => {
    void refreshConfig().catch(() => undefined)
  }, [refreshConfig])
  useEffect(() => {
    if (!editing) setCode('')
  }, [editing])
  const save = async (kind: 'displayName' | 'email') => {
    if (saving || !token) return
    setSaving(kind)
    setError('')
    try {
      const updated =
        kind === 'displayName'
          ? await authApi.updateProfile(token, displayName)
          : await authApi.updateEmail(token, email, code || undefined)
      onMeChange(updated)
      if (kind === 'email') setCode('')
      setEditing(null)
      toast.success(
        t(kind === 'displayName' ? 'displayNameSaved' : 'emailSaved'),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : t('failed'))
      void refreshConfig().catch(() => undefined)
    } finally {
      setSaving(null)
    }
  }
  return (
    <>
      <SettingsSection
        title={t('title')}
        description={t('description')}
        action={
          <Button
            variant="outline"
            onClick={() => {
              setDisplayName(me.displayName)
              setError('')
              setEditing('displayName')
            }}
          >
            {tr('修改昵称', 'Edit display name')}
          </Button>
        }
      >
        <dl className="space-y-4 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <dt className="text-muted-foreground">
              {tr('显示名称', 'Display name')}
            </dt>
            <dd>{me.displayName}</dd>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <dt className="text-muted-foreground">{t('email')}</dt>
            <dd className="flex flex-wrap items-center gap-3">
              <span className="break-all">{me.email || '—'}</span>
              {me.email && (
                <Badge variant={me.emailVerified ? 'secondary' : 'outline'}>
                  {t(me.emailVerified ? 'verified' : 'unverified')}
                </Badge>
              )}
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setEmail(me.email ?? '')
                  setCode('')
                  setError('')
                  setEditing('email')
                }}
              >
                {t(me.email ? 'changeEmail' : 'bindEmail')}
              </Button>
            </dd>
          </div>
        </dl>
      </SettingsSection>
      <ManagementDialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null)
        }}
        title={
          editing === 'email'
            ? t(me.email ? 'changeEmail' : 'bindEmail')
            : tr('修改昵称', 'Edit display name')
        }
        description={
          editing === 'email' ? t('emailDescription') : t('description')
        }
        busy={Boolean(saving)}
        error={error}
        footer={
          <>
            <Button
              variant="outline"
              disabled={Boolean(saving)}
              onClick={() => setEditing(null)}
            >
              {tr('取消', 'Cancel')}
            </Button>
            <Button
              type="button"
              disabled={
                Boolean(saving) ||
                (editing === 'email'
                  ? !isValidEmail(email) ||
                    (normalizeEmail(email) === me.email && me.emailVerified) ||
                    (emailVerificationRequired && code.length !== 6)
                  : !isValidDisplayName(displayName) ||
                    displayName.trim() === me.displayName)
              }
              onClick={() => {
                if (editing) void save(editing)
              }}
            >
              {saving ? <Spinner data-icon="inline-start" /> : null}
              {tr('保存', 'Save')}
            </Button>
          </>
        }
      >
        <FieldGroup>
          {editing === 'displayName' ? (
            <DisplayNameField
              value={displayName}
              onChange={setDisplayName}
              disabled={Boolean(saving)}
            />
          ) : (
            <>
              <Field>
                <div className="flex flex-wrap items-center gap-2">
                  <FieldLabel htmlFor="profile-email">{t('email')}</FieldLabel>
                  {me.email && normalizeEmail(email) === me.email ? (
                    <Badge variant={me.emailVerified ? 'secondary' : 'outline'}>
                      {t(me.emailVerified ? 'verified' : 'unverified')}
                    </Badge>
                  ) : null}
                </div>
                <Input
                  id="profile-email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  disabled={Boolean(saving)}
                  onChange={(event) => {
                    setEmail(event.currentTarget.value)
                    setCode('')
                  }}
                />
                <FieldDescription>{t('emailDescription')}</FieldDescription>
              </Field>
              {emailVerificationRequired ? (
                <EmailCodeField
                  email={email}
                  value={code}
                  onChange={setCode}
                  purpose="bind"
                  token={token}
                  disabled={Boolean(saving)}
                  id="profile-email-code"
                />
              ) : (
                <FieldDescription>{t('verificationDisabled')}</FieldDescription>
              )}
            </>
          )}
        </FieldGroup>
      </ManagementDialog>
    </>
  )
}
