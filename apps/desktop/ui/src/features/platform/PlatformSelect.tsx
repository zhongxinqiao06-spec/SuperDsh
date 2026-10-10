import { useEffect, useId, useState } from 'react'
import {
  Button,
  Menu,
  IconChevronDownOutlineRegular,
  type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'

export interface PlatformSelectOption {
  value: string
  label: string
  detail?: string
  group?: string
  disabled?: boolean
}

/** Product dropdown using the same menu, focus and selection behavior as desktop controls. */
export function PlatformSelect({
  label,
  value,
  onChange,
  options,
  placeholder = '请选择',
  disabled = false,
  required = false,
  name,
  id,
  side = 'bottom',
  triggerClassName,
  className,
}: {
  label: string
  value: string
  onChange(value: string): void
  options: readonly PlatformSelectOption[]
  placeholder?: string
  disabled?: boolean
  required?: boolean
  name?: string
  id?: string
  side?: 'top' | 'bottom'
  triggerClassName?: string
  className?: string
}) {
  const generatedId = useId()
  const controlId = id ?? generatedId
  const [open, setOpen] = useState(false)
  const [invalid, setInvalid] = useState(false)
  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])
  const selected = options.find((option) => option.value === value)
  const items: MenuEntry[] = []
  let group: string | undefined
  for (const option of options) {
    if (option.group && option.group !== group) {
      group = option.group
      items.push({
        type: 'label',
        id: `${controlId}-group-${items.length}`,
        text: group,
      })
    }
    items.push({
      id: option.value,
      label: (
        <span className="platformSelectOption">
          <span>{option.label}</span>
          {option.detail && <small>{option.detail}</small>}
        </span>
      ),
      ...(option.disabled === undefined ? {} : { disabled: option.disabled }),
    })
  }
  return (
    <span className={['platformSelect', className].filter(Boolean).join(' ')}>
      <Menu
        portal
        autoFocus
        open={open && !disabled}
        side={side}
        selectedId={value}
        items={items}
        onClose={() => setOpen(false)}
        onSelect={(next) => {
          setOpen(false)
          setInvalid(false)
          onChange(next)
        }}
        anchor={
          <Button
            id={controlId}
            size="sm"
            variant="outline"
            className={['platformSelectTrigger', triggerClassName]
              .filter(Boolean)
              .join(' ')}
            aria-label={label}
            aria-haspopup="menu"
            aria-expanded={open && !disabled}
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? `${controlId}-error` : undefined}
            disabled={disabled}
            onClick={() => setOpen((previous) => !previous)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                setOpen(true)
              }
            }}
          >
            <span>{selected?.label ?? placeholder}</span>
            <IconChevronDownOutlineRegular size={12} />
          </Button>
        }
      />
      {(required || name) && (
        <input
          className="platformSelectValue"
          aria-hidden="true"
          tabIndex={-1}
          name={name}
          value={value}
          required={required}
          disabled={disabled}
          onChange={() => {}}
          onInvalid={(event) => {
            event.preventDefault()
            setInvalid(true)
            document.getElementById(controlId)?.focus()
          }}
        />
      )}
      {invalid && (
        <small className="platformSelectInvalid" id={`${controlId}-error`}>
          请选择{label}
        </small>
      )}
    </span>
  )
}
