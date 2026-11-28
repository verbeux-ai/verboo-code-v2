import { useRef } from 'react'
import type { CSSProperties, KeyboardEventHandler, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { IconCloseOutlineRegular, IconWarningOutlineRegular } from './icons/index.tsx'
import { useModalLayer } from './useModalLayer.ts'
import css from './Modal.module.css'

interface ModalBaseProps {
  open: boolean
  onClose: () => void
  title: string
  tone?: 'warning'
  description?: string
  children?: ReactNode
  footer?: ReactNode
  className?: string
  contentClassName?: string
  shortcutModal?: string
  onKeyDownCapture?: KeyboardEventHandler<HTMLDivElement>
  backdropBlur?: boolean
  motion?: { durationMs: number; closing: boolean }
}

type ModalProps = ModalBaseProps & (
  | { headless: true; closeLabel?: never }
  | { headless?: false; closeLabel: string }
)

/**
 * Render a centered, body-portaled modal over a blurred page mask.
 * @param props.open - whether the dialog is showing.
 * @param props.onClose - application close command, Escape, or mask click; while a menu is open inside the
 * dialog, Escape belongs to that menu first.
 * @param props.title - dialog heading (aria-label in every mode).
 * @param props.tone - warning adds an amber title icon and compact title-to-body spacing; ignored for headless dialogs.
 * @param props.closeLabel - localized accessible close-button label.
 * @param props.description - optional supporting sentence under the title.
 * @param props.children - dialog body; mark its initial-focus control with
 * data-modal-autofocus instead of React autoFocus to preserve return focus.
 * @param props.footer - action row (Cancel / Create).
 * @param props.contentClassName - optional class for a scrollable content region.
 * @param props.backdropBlur - disable when the caller already blurs the page; defaults to true.
 * @param props.shortcutModal - command scope allowed by shortcut owners; unnamed
 * dialogs block application commands unless their owner allows the "other" scope.
 * @param props.headless - render children directly in the card (no default
 * header/close/body chrome); mask, card, Escape, and aria-label remain.
 * @param props.onKeyDownCapture - handle a nested dialog's keys before the document Escape listeners.
 * @param props.motion - slide in, or keep an inert overlay mounted while the caller animates dismissal.
 * @returns the overlay while open or animating dismissal.
 */
export function Modal({
  open, onClose, title, closeLabel, description, children, footer, className, contentClassName,
  onKeyDownCapture, headless = false, backdropBlur = true, shortcutModal, tone, motion,
}: ModalProps) {
  const dialog = useRef<HTMLDivElement>(null)
  useModalLayer(dialog, open, onClose)

  if (!open && !motion?.closing) return null

  return createPortal((
    <div className={css.root} role="presentation" onKeyDownCapture={onKeyDownCapture}
      data-motion={motion === undefined ? undefined : open ? 'enter' : 'exit'}
      style={motion === undefined ? undefined : { '--modal-motion-duration': `${motion.durationMs}ms` } as CSSProperties}
      {...{ inert: open ? undefined : '' }} aria-hidden={!open || undefined}>
      <div className={css.mask} style={backdropBlur ? undefined : { backdropFilter: 'none' }} aria-hidden="true" onClick={onClose} />
      <div
        ref={dialog}
        tabIndex={-1}
        data-shortcut-modal={shortcutModal}
        className={clsx(css.dialog, !headless && tone === 'warning' && css.warning, className)}
        role="dialog"
        aria-modal={open || undefined}
        aria-label={title}
      >
        {headless
          ? children
          : (
            <>
              <div className={clsx(css.content, contentClassName)}>
                <div className={css.header}>
                  <h2 className={css.title}>
                    {tone === 'warning' && <IconWarningOutlineRegular size={18} className={css.warningIcon} aria-hidden="true" />}
                    {title}
                  </h2>
                  <button type="button" className={css.close} aria-label={closeLabel} onClick={onClose}>
                    <IconCloseOutlineRegular size={14} />
                  </button>
                </div>
                {description !== undefined && description !== '' && (
                  <p className={css.description}>{description}</p>
                )}
                {children !== undefined && <div className={css.body}>{children}</div>}
              </div>
              {footer !== undefined && <div className={css.footer}>{footer}</div>}
            </>
          )}
      </div>
    </div>
  ), document.body)
}
