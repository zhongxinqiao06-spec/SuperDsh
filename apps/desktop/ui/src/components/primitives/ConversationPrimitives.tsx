import { forwardRef, type HTMLAttributes } from 'react'
import clsx from 'clsx'
import css from './ConversationPrimitives.module.css'

/** Shared product composer surface; callers own their editor and transport. */
export const ComposerCard = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement>
>(function ComposerCard({ className, ...props }, ref) {
  return (
    <div
      {...props}
      ref={ref}
      className={className ?? css.composer}
      data-composer-card
    />
  )
})

/** The same message bubble is used for native and API v2 presentations. */
export function UserMessageBubble({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={clsx(className ?? css.bubble)} />
}
