import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { Modal, useModalLayer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { FirstUseProps, FirstUseStep } from './contracts.ts'
import { Glyph } from './Glyph.tsx'
import boo from './assets/verboo-mascot.png'
import product from './Product.module.css'
import css from './FirstUseTour.module.css'

const steps = [
  { feature: 'desktop_first_use_step_project', titleKey: 'firstUseProjectTitle', bodyKey: 'firstUseProjectBody', target: '[data-verboo-tour-project], [data-sidebar-opener]', side: 'right' },
  { feature: 'desktop_first_use_step_model', titleKey: 'firstUseModelTitle', bodyKey: 'firstUseModelBody', target: '[data-model-selection-trigger]', side: 'above' },
  { feature: 'desktop_first_use_step_message', titleKey: 'firstUseMessageTitle', bodyKey: 'firstUseMessageBody', target: '[data-composer-card]', side: 'above' },
  { feature: 'desktop_first_use_step_split', titleKey: 'firstUseSplitTitle', bodyKey: 'firstUseSplitBody', target: '[data-verboo-tour-split]', side: 'below' },
  { feature: 'desktop_first_use_step_tools', titleKey: 'firstUseToolsTitle', bodyKey: 'firstUseToolsBody', target: '[data-sidebar-right-expand], [data-sidebar-right-toggle]', side: 'below' },
  { feature: 'desktop_first_use_step_connections', titleKey: 'connections', bodyKey: 'firstUseConnectionsBody',
    target: '[data-verboo-tour-connections], [data-sidebar-opener]', side: 'right' },
] as const satisfies readonly { feature: FirstUseStep; titleKey: string; bodyKey: string; target: string; side: string }[]

type Target = typeof steps[number]
const margin = 16
const gap = 18
const padding = 5

function place(target: DOMRect, card: HTMLElement, preferred: Target['side']) {
  const { innerWidth: width, innerHeight: height } = window
  const topSafe = Math.max(margin, parseFloat(getComputedStyle(card).getPropertyValue('--dsh-frame-overlay-top')) || 0)
  const { width: cardWidth, height: cardHeight } = card.getBoundingClientRect()
  const midX = target.left + target.width / 2
  const midY = target.top + target.height / 2
  const left = Math.max(margin, Math.min(midX - cardWidth / 2, width - cardWidth - margin))
  const clampY = (y: number) => Math.max(topSafe, Math.min(y, height - cardHeight - margin))
  const right = target.right + gap
  if (preferred === 'right' && right + cardWidth <= width - margin) {
    const top = clampY(midY - cardHeight / 2)
    return { left: right, top, side: 'right', arrow: midY - top }
  }
  if (preferred === 'above' && target.top - gap - cardHeight >= topSafe || target.bottom + gap + cardHeight > height - margin) {
    return { left, top: clampY(target.top - gap - cardHeight), side: 'above', arrow: midX - left }
  }
  return { left, top: clampY(target.bottom + gap), side: 'below', arrow: midX - left }
}

const defaultStyle = { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }

function useSpotlight(target: Target) {
  const card = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{
    ring: CSSProperties
    popup: CSSProperties
    side: string
  } | null>(null)
  useLayoutEffect(() => {
    const popup = card.current
    if (popup === null) return
    let anchor: HTMLElement | undefined
    let frame = 0
    const resize = new ResizeObserver(schedule)
    function measure() {
      if (popup === null) return
      const candidates = Array.from(document.querySelectorAll<HTMLElement>(target.target)).filter((element) => {
        const rect = element.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0 && rect.left < window.innerWidth
          && rect.right > 0 && rect.top < window.innerHeight && rect.bottom > 0
          && getComputedStyle(element).visibility !== 'hidden'
          && element.closest('[hidden], [inert], [aria-hidden="true"]') === null
      })
      const next = candidates.find(element => element.closest('[data-pane-focused]')) ?? candidates[0]
      if (next !== anchor) {
        if (anchor !== undefined) resize.unobserve(anchor)
        anchor = next
        if (next !== undefined) resize.observe(next)
      }
      if (anchor === undefined) {
        setPosition(null)
        return
      }
      const rect = anchor.getBoundingClientRect()
      const { side, arrow, ...pin } = place(rect, popup, target.side)
      const ring = {
        left: rect.left - padding, top: rect.top - padding,
        width: rect.width + padding * 2, height: rect.height + padding * 2,
      }
      const popupStyle = { ...pin, '--tour-arrow': `${arrow}px` } as CSSProperties
      setPosition(previous => previous?.side === side
        && previous.popup.left === pin.left && previous.popup.top === pin.top
        && previous.ring.left === ring.left && previous.ring.top === ring.top
        && previous.ring.width === ring.width && previous.ring.height === ring.height
        ? previous : { ring, popup: popupStyle, side })
    }
    function schedule() {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(measure)
    }
    const changes = new MutationObserver(schedule)
    changes.observe(document.body, { subtree: true, childList: true, attributes: true,
      attributeFilter: ['hidden', 'aria-hidden', 'data-pane-focused', 'data-wide', 'data-sidebar-right-open'] })
    resize.observe(popup)
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    measure()
    return () => {
      changes.disconnect()
      resize.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
      cancelAnimationFrame(frame)
    }
  }, [target])
  return { card, position }
}

function GuidedSteps({ index, onBack, onNext, onClose, t }: {
  index: number
  onBack(this: void): void
  onNext(this: void): void
  onClose(this: void): void
  t: FirstUseProps['t']
}) {
  const step = steps[index] ?? steps[0]
  const { card, position } = useSpotlight(step)
  useModalLayer(card, true, onClose)
  const last = index === steps.length - 1
  return createPortal(
    <div className={css.overlay} data-verboo-first-use-tour data-tour-step={step.feature}>
      {position === null ? <div className={css.dim} aria-hidden /> : <div className={css.spotlight} style={position.ring} aria-hidden />}
      <div ref={card} className={css.tip} role="dialog" aria-modal="true" aria-label={t(step.titleKey)}
        tabIndex={-1} style={position?.popup ?? defaultStyle} data-point={position?.side}
        onKeyDown={(event) => {
          if (event.altKey || event.shiftKey || event.metaKey || event.ctrlKey || event.nativeEvent.isComposing || event.repeat) return
          if (event.key === 'ArrowRight') { event.preventDefault(); onNext() }
          if (event.key === 'ArrowLeft') { event.preventDefault(); onBack() }
        }}>
        <div className={css.tipTop}>
          <span>{t('firstUseProgress', { current: String(index + 1), total: String(steps.length) })}</span>
          <button type="button" className={product.iconButton} onClick={onClose} aria-label={t('firstUseClose')}><Glyph name="x" size={16} /></button>
        </div>
        <div aria-live="polite" aria-atomic="true">
          <h2>{t(step.titleKey)}</h2>
          <p>{t(step.bodyKey)}</p>
        </div>
        <div className={css.tipButtons}>
          <button type="button" className={product.secondary} onClick={onBack} disabled={index === 0}>
            <Glyph name="chevron-left" size={16} />{t('firstUseBack')}
          </button>
          <button type="button" className={product.primary} data-modal-autofocus onClick={onNext}>
            {t(last ? 'firstUseDone' : 'firstUseNext')}<Glyph name={last ? 'check' : 'arrow-right'} size={16} />
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/** Welcome new desktop users and explain the controls in their actual positions. */
export function FirstUseTour({
  t, useFirstUse, observeFirstUse, startFirstUse, observeFirstUseStep, backFirstUse, finishFirstUse,
}: FirstUseProps) {
  const { visible, measurable } = useFirstUse(state => state)
  const [index, setIndex] = useState<number | null>(null)
  const step = index === null ? undefined : steps[index]
  useEffect(() => {
    if (visible && measurable && step !== undefined) observeFirstUseStep(step.feature, 'started')
  }, [visible, measurable, step, observeFirstUseStep])
  useEffect(() => {
    if (visible && measurable) observeFirstUse()
    if (!visible) setIndex(null)
  }, [visible, measurable, observeFirstUse])
  if (!visible) return null
  const close = () => {
    if (step !== undefined) observeFirstUseStep(step.feature, 'cancelled')
    finishFirstUse(false)
  }
  if (index !== null && step !== undefined) return <GuidedSteps index={index} t={t} onClose={close}
    onBack={() => {
      if (index === 0) return
      backFirstUse()
      setIndex(index - 1)
    }}
    onNext={() => {
      observeFirstUseStep(step.feature, 'completed')
      if (index === steps.length - 1) finishFirstUse(true)
      else setIndex(index + 1)
    }} />
  const title = t('firstUseWelcome')
  return <Modal open headless onClose={close} title={title} className={css.welcome ?? ''}>
    <div className={css.mascotStage} aria-hidden>
      <Glyph name="sparkles" className={css.sparkleLeft} size={25} />
      <img src={boo} alt="" width={114} height={114} />
      <Glyph name="sparkles" className={css.sparkleRight} size={19} />
    </div>
    <button type="button" className={[product.iconButton, css.close].join(' ')} aria-label={t('firstUseClose')} onClick={close}><Glyph name="x" size={19} /></button>
    <div className={css.welcomeCopy}>
      <h2>{title}</h2>
      <p>{t('firstUseThanks')}</p>
    </div>
    <div className={css.welcomeButtons}>
      <button type="button" className={product.primary} data-modal-autofocus onClick={() => {
        startFirstUse()
        setIndex(0)
      }}>{t('firstUseStart')}<Glyph name="arrow-right" size={17} /></button>
      <button type="button" className={product.secondary} onClick={close}>{t('firstUseLater')}</button>
    </div>
  </Modal>
}
