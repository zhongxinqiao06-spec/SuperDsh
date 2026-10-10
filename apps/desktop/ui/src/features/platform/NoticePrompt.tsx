import { useState } from 'react'
import {
  Button,
  Checkbox,
  Input,
  MarkdownText,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { PlatformSelect } from './PlatformSelect.tsx'
import type { PlatformJson } from '@superdsh/core/client/platform'
import {
  object,
  rows,
  string,
  labels,
  type Row,
  type Request,
  type Run,
} from './platform-model.ts'
function SchemaField({
  schema,
  value,
  change,
  label,
  required = false,
  depth = 0,
}: {
  schema: Row
  value: PlatformJson | undefined
  change(value: PlatformJson): void
  label: string
  required?: boolean
  depth?: number
}) {
  if (depth > 6) return <p>此表单层级过深，请在目标设备回答。</p>
  const title = string(schema.title) || label
  if (schema.type === 'object' || schema.properties)
    return (
      <fieldset>
        <legend>{title}</legend>
        {Object.entries(object(schema.properties)).map(([key, definition]) => (
          <SchemaField
            key={key}
            schema={object(definition)}
            value={object(value)[key]}
            change={(next) => change({ ...object(value), [key]: next })}
            label={key}
            required={
              Array.isArray(schema.required) && schema.required.includes(key)
            }
            depth={depth + 1}
          />
        ))}
      </fieldset>
    )
  if (Array.isArray(schema.enum))
    return (
      <label>
        {title}
        <PlatformSelect
          label={title}
          required={required}
          value={string(value)}
          onChange={change}
          options={schema.enum.map((option) => ({
            value: String(option),
            label: String(option),
          }))}
        />
      </label>
    )
  if (schema.type === 'boolean')
    return <Checkbox label={title} checked={value === true} onChange={change} />
  if (schema.type === 'array') {
    const choices = object(schema.items).enum
    if (Array.isArray(choices))
      return (
        <fieldset>
          <legend>{title}</legend>
          {choices.map((option) => (
            <Checkbox
              key={String(option)}
              label={String(option)}
              checked={Array.isArray(value) && value.includes(option)}
              onChange={(checked) =>
                change(
                  checked
                    ? [...(Array.isArray(value) ? value : []), option]
                    : (Array.isArray(value) ? value : []).filter(
                        (item) => item !== option,
                      ),
                )
              }
            />
          ))}
        </fieldset>
      )
    return (
      <label>
        {title}
        <textarea
          className="platformFieldTextarea"
          required={required}
          value={Array.isArray(value) ? value.map(String).join('\n') : ''}
          onChange={(event) =>
            change(event.target.value.split('\n').filter(Boolean))
          }
          placeholder="每行一项"
        />
      </label>
    )
  }
  return (
    <label>
      {title}
      <Input
        required={required}
        type={
          schema.type === 'number' || schema.type === 'integer'
            ? 'number'
            : 'text'
        }
        step={schema.type === 'integer' ? 1 : 'any'}
        value={typeof value === 'number' ? value : string(value)}
        onChange={(event) =>
          change(
            schema.type === 'number' || schema.type === 'integer'
              ? Number(event.target.value)
              : event.target.value,
          )
        }
      />
    </label>
  )
}
function InputQuestions({
  questions,
  value,
  change,
}: {
  questions: Row[]
  value: Row
  change(value: Row): void
}) {
  const answers = object(value.answers)
  const update = (id: string, answer: Row) =>
    change({ answers: { ...answers, [id]: answer } })
  return (
    <>
      {questions.map((question) => {
        const id = string(question.id),
          answer = object(answers[id]),
          selected = Array.isArray(answer.optionIds) ? answer.optionIds : []
        return (
          <fieldset key={id}>
            <legend>{string(question.header) || '请回答'}</legend>
            <MarkdownText text={string(question.prompt)} labels={labels} />
            {rows(question.options).map((option) => (
              <div key={string(option.id)}>
                {question.multiple ? (
                  <Checkbox
                    label={string(option.label)}
                    checked={selected.includes(option.id ?? '')}
                    onChange={(checked) =>
                      update(id, {
                        optionIds: checked
                          ? [...selected, option.id ?? '']
                          : selected.filter((item) => item !== option.id),
                        customText: string(answer.customText),
                      })
                    }
                  />
                ) : (
                  <Button
                    className="platformQuestionOption"
                    size="sm"
                    variant="outline"
                    aria-pressed={selected.includes(option.id ?? '')}
                    onClick={() =>
                      update(id, {
                        optionIds: [option.id ?? ''],
                        customText: '',
                      })
                    }
                  >
                    {string(option.label)}
                  </Button>
                )}
                {option.description && (
                  <small>{string(option.description)}</small>
                )}
              </div>
            ))}
            {question.allowCustom && (
              <label>
                补充回答
                <Input
                  value={string(answer.customText)}
                  onChange={(event) =>
                    update(id, {
                      optionIds: question.multiple ? selected : [],
                      customText: event.target.value,
                    })
                  }
                />
              </label>
            )}
          </fieldset>
        )
      })}
    </>
  )
}
export function NoticePrompt({
  notice,
  sessionId,
  disabled,
  request,
  run,
  refresh,
}: {
  notice: Row
  sessionId: string
  disabled: boolean
  request: Request
  run: Run
  refresh(): Promise<void>
}) {
  const [answers, setAnswers] = useState<Record<string, PlatformJson>>({})
  return (
    <section className="platformNotice">
      <strong>{string(notice.title)}</strong>
      <p>{string(notice.message)}</p>
      {rows(notice.actions).map((action) => {
        const actionId = string(action.actionId),
          input = object(action.input),
          ui = object(input.uiSchema),
          value = answers[actionId]
        return (
          <form
            key={actionId}
            onSubmit={(event) => {
              event.preventDefault()
              void run(async () => {
                if (
                  ui.component === 'inputRequest' &&
                  rows(ui.questions).some((question) => {
                    const answer = object(
                      object(object(value).answers)[string(question.id)],
                    )
                    return (
                      !(
                        Array.isArray(answer.optionIds) &&
                        answer.optionIds.length
                      ) && !string(answer.customText).trim()
                    )
                  })
                )
                  throw new Error('请回答所有问题')
                await request({
                  operation: 'respond',
                  sessionId,
                  noticeId: string(notice.noticeId),
                  body: {
                    actionId,
                    ...(input.required ? { input: value ?? {} } : {}),
                  },
                })
                await refresh()
              })
            }}
          >
            {input.required === true &&
              (ui.component === 'inputRequest' ? (
                <InputQuestions
                  questions={rows(ui.questions)}
                  value={object(value)}
                  change={(next) =>
                    setAnswers((previous) => ({
                      ...previous,
                      [actionId]: next,
                    }))
                  }
                />
              ) : (
                <SchemaField
                  schema={object(input.schema)}
                  value={value}
                  label="回答"
                  required
                  change={(next) =>
                    setAnswers((previous) => ({
                      ...previous,
                      [actionId]: next,
                    }))
                  }
                />
              ))}
            <Button
              type="submit"
              size="sm"
              variant={action.style === 'primary' ? 'primary' : 'outline'}
              disabled={disabled}
              data-style={string(action.style)}
            >
              {string(action.label)}
            </Button>
          </form>
        )
      })}
    </section>
  )
}
