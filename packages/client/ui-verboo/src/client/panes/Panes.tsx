/** Product pane composition over the shipped Conversation content and controls. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { Menu, MenuItemButton, Tooltip, observeComposition } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  InjectFace,
  PropsLocale,
  PropsRenderFactories,
  PropsRenderSlots,
  PropsRuntime,
  HostObservable,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { Config } from '../../config.ts'
import type { PaneSnapshot } from './controller.ts'
import { leaves, MAX_PANES, minimumSize, rectangles, boxAt } from './layout.ts'
import type { PaneAxis, PaneLeaf, PaneNode, PaneRect, PaneSplit } from './layout.ts'
import { Glyph } from '../Glyph.tsx'
import { Busy } from '../PageParts.tsx'
import { paneShortcutKeys } from './shortcut-labels.ts'
import css from './Panes.module.css'

/** Narrow pane commands and independent layout observation. */
export interface PanesInjected {
  hooks: {
    panes: HostObservable<PaneSnapshot>
    paneSaveError: HostObservable<boolean>
    panePreferences: HostObservable<ConfigFormSnapshot<Pick<Config, 'paneLayout' | 'minimalist'>>>
  }
  minimumWidth: number
  minimumHeight: number
  focusPane(id: string): void
  focusPaneInput(id: string): void
  focusComposer(id: string): void
  paneFocusTarget(ownerId: string): HTMLElement | null
  splitPane(id: string, axis: PaneAxis): void
  closePane(id: string): void
  resizePane(id: string, ratio: number, persist?: boolean): void
  savePanes(): void
  choosePane(id: string | null): void
  selectConversation(id: string, sessionId: SessionId): void
  createConversation(id: string, workspaceId: WorkspaceId): Promise<void>
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** One explicit Session-scoped occurrence of the existing Conversation. */
    'verboo.pane': {
      kind: 'single'
      scope: 'session-maybe'
      owner: { pane: PaneLeaf; canSplitX: boolean; canSplitY: boolean }
    }
  }
}

/** Root renderer receives layout only; stream subscriptions stay inside each pane. */
export type PanesProps = PropsRuntime<'main'> &
  PropsRenderSlots<'verboo.pane'> &
  PropsLocale<'verboo'> &
  InjectFace<PanesInjected>
/** Independent conversation renderer and inherited Session input. */
export type PaneProps = PropsRuntime<'verboo.pane'> &
  PropsRenderFactories &
  PropsLocale<'verboo'> &
  InjectFace<PanesInjected>

/** Normalize a rectangle into percentage positioning without remounting leaves during splits.
 * @param box - fractional rectangle.
 * @returns inline geometry. */
function position(box: PaneRect): CSSProperties {
  return {
    left: `${box.x * 100}%`,
    top: `${box.y * 100}%`,
    width: `${box.width * 100}%`,
    height: `${box.height * 100}%`,
  }
}
function splits(node: PaneNode): PaneSplit[] {
  return node.kind === 'pane' ? [] : [node, ...splits(node.first), ...splits(node.second)]
}

/** Resize one subtree with pointer capture and accessible keyboard adjustments. */
function Divider({
  node,
  box,
  width,
  height,
  minimumWidth,
  minimumHeight,
  resize,
  save,
  label,
  focused,
}: {
  node: PaneSplit
  box: PaneRect
  width: number
  height: number
  minimumWidth: number
  minimumHeight: number
  resize: (id: string, ratio: number, persist?: boolean) => void
  save: () => void
  label: string
  focused: boolean
}) {
  const horizontal = node.axis === 'x'
  const span = horizontal ? box.width * width : box.height * height
  const first = minimumSize(node.first, minimumWidth, minimumHeight)
  const second = minimumSize(node.second, minimumWidth, minimumHeight)
  const low = (horizontal ? first.width : first.height) / span
  const high = 1 - (horizontal ? second.width : second.height) / span
  const clamp = (ratio: number) => Math.max(low, Math.min(high, ratio))
  const drag = useRef<{ start: number; ratio: number } | null>(null)
  const finish = (event: ReactPointerEvent<HTMLDivElement>) => {
    save()
    drag.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
  }
  const style: CSSProperties = horizontal
    ? { left: `${(box.x + box.width * node.ratio) * 100}%`, top: `${box.y * 100}%`, height: `${box.height * 100}%` }
    : { top: `${(box.y + box.height * node.ratio) * 100}%`, left: `${box.x * 100}%`, width: `${box.width * 100}%` }
  return (
    <div
      className={css.divider}
      data-axis={node.axis}
      data-focused={focused || undefined}
      style={style}
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={horizontal ? 'vertical' : 'horizontal'}
      aria-valuemin={Math.round(low * 100)}
      aria-valuemax={Math.round(high * 100)}
      aria-valuenow={Math.round(node.ratio * 100)}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        drag.current = { start: horizontal ? event.clientX : event.clientY, ratio: node.ratio }
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        if (drag.current === null) return
        resize(
          node.id,
          clamp(drag.current.ratio + ((horizontal ? event.clientX : event.clientY) - drag.current.start) / span),
          false,
        )
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={() => {
        drag.current = null
      }}
      onKeyDown={(event) => {
        const decrement = horizontal ? 'ArrowLeft' : 'ArrowUp'
        const increment = horizontal ? 'ArrowRight' : 'ArrowDown'
        if (event.key !== decrement && event.key !== increment && event.key !== 'Home') return
        event.preventDefault()
        resize(node.id, clamp(event.key === 'Home' ? 0.5 : node.ratio + (event.key === decrement ? -0.025 : 0.025)))
      }}
    />
  )
}

/** Render stable pane siblings; only their rectangles change when the tree changes.
 * @param props - injected pane data and existing render seats.
 * @returns split workspace. */
export function Panes(props: PanesProps) {
  const { usePanes, SessionProvider, renderSlot, focusPane, focusPaneInput, resizePane, minimumWidth, minimumHeight, t } = props
  const snapshot = usePanes(s => s)
  const saveError = props.usePaneSaveError(value => value)
  const minimalist = props.usePanePreferences(value => value.value?.minimalist === true)
  const restoredFocus = useRef(false)
  useEffect(() => {
    if (
      snapshot.restoring ||
      restoredFocus.current ||
      leaves(snapshot.layout.root).some(p => p.sessionId !== null && !snapshot.references.has(p.id))
    )
      return
    restoredFocus.current = true
    props.focusPaneInput(snapshot.layout.focused)
  }, [snapshot.restoring, snapshot.references])
  const host = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  useLayoutEffect(() => {
    const element = host.current
    if (element === null) return
    const update = () => {
      if (element.clientWidth > 0 && element.clientHeight > 0)
        setSize(previous =>
          previous.width === element.clientWidth && previous.height === element.clientHeight
            ? previous
            : { width: element.clientWidth, height: element.clientHeight },
        )
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => {
      observer.disconnect()
    }
  }, [])
  const { layout } = snapshot
  const panes = leaves(layout.root)
  const bounds = minimumSize(layout.root, minimumWidth, minimumHeight)
  const width = Math.max(size.width, panes.length > 1 ? bounds.width : 0)
  const height = Math.max(size.height, panes.length > 1 ? bounds.height : 0)
  const boxes = rectangles(layout.root)
  return (
    <div className={css.workspace} data-verboo-panes="" data-pane-split={panes.length > 1 || undefined}
      data-conversation-minimalist={minimalist || undefined}
      aria-label={t('paneWorkspace')}>
      {saveError && (
        <div className={css.saveNotice} role="alert">
          {t('paneSaveFailed')}
          <button type="button" onClick={props.savePanes}>
            {t('retry')}
          </button>
        </div>
      )}
      <div className={css.viewport} ref={host}>
        <div className={css.canvas} style={{ width: width || '100%', height: height || '100%' }}>
          {snapshot.restoring && <Busy label={t('loading')} />}
          {!snapshot.restoring &&
            panes.map((pane) => {
              const box = boxAt(boxes, pane.id)
              const owner = {
                pane,
                canSplitX: panes.length < MAX_PANES && box.width * size.width >= minimumWidth * 2,
                canSplitY: panes.length < MAX_PANES && box.height * size.height >= minimumHeight * 2,
              }
              return (
                <section
                  key={pane.id}
                  className={css.pane}
                  style={position(box)}
                  data-pane-id={pane.id}
                  data-pane-focused={pane.id === layout.focused || undefined}
                  onPointerDownCapture={(event) => {
                    const target = event.target
                    const card = target instanceof Element ? target.closest('[data-composer-card]') : null
                    const inputClick = target instanceof Element && card !== null
                      && (target === card || target.closest('[data-input-scroll]') !== null)
                    if (pane.id !== layout.focused && inputClick && event.button === 0 && !event.defaultPrevented) {
                      // The first click selects this input; another click edits it.
                      event.preventDefault()
                      focusPaneInput(pane.id)
                    } else focusPane(pane.id)
                  }}
                  onFocusCapture={() => {
                    focusPane(pane.id)
                  }}
                >
                  <SessionProvider
                    session={snapshot.references.get(pane.id)}
                    empty={() => renderSlot('verboo.pane', owner)}
                  >
                    {renderSlot('verboo.pane', owner)}
                  </SessionProvider>
                </section>
              )
            })}
          {splits(layout.root).map(node => (
            <Divider
              key={node.id}
              node={node}
              box={boxAt(boxes, node.id)}
              width={width}
              height={height}
              minimumWidth={minimumWidth}
              minimumHeight={minimumHeight}
              resize={resizePane}
              save={props.savePanes}
              label={t('paneResize')}
              focused={leaves(node).some(pane => pane.id === layout.focused)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

/** Existing controller observations and commands needed by the conversation chooser. */
export type ChoicesProps = Pick<PaneProps,
  'pane' | 't' | 'useSessions' | 'useWorkspaces' | 'usePanes' | 'selectConversation' | 'createConversation'> & { inline?: boolean }

/** Conversation search is local to its pane; project and session data use the existing controller hooks. */
export function Choices(props: ChoicesProps) {
  const { pane, t, useSessions, useWorkspaces, usePanes, selectConversation, createConversation } = props
  const catalog = useSessions(s => s)
  const workspaces = useWorkspaces(s => s)
  const busy = usePanes(s => s.busy === pane.id)
  const failed = usePanes(s => s.failure === pane.id)
  const opened = usePanes(s => leaves(s.layout.root).flatMap(p => p.sessionId === null ? [] : [p.sessionId]))
  const [query, setQuery] = useState('')
  const inherited =
    pane.workspaceId ??
    workspaces.items.find(w => pane.sessionId !== null && w.sessionIds.includes(pane.sessionId))?.workspaceId
  const [project, setProject] = useState<WorkspaceId | undefined>(inherited)
  const selectedProject = [project, inherited].find(id => workspaces.items.some(w => w.workspaceId === id))
    ?? workspaces.items[0]?.workspaceId
  const input = useRef<HTMLInputElement>(null)
  const results = useRef<HTMLDivElement>(null)
  const composition = useRef<ReturnType<typeof observeComposition> | null>(null)
  useEffect(() => {
    input.current?.focus()
    // Portaled menus first measure while hidden; focus after that layout commits.
    const frame = props.inline ? undefined : requestAnimationFrame(() => { input.current?.focus() })
    const observer = observeComposition(document)
    composition.current = observer
    return () => {
      composition.current = null
      observer.dispose()
      if (frame !== undefined) cancelAnimationFrame(frame)
    }
  }, [props.inline])
  const normalized = query.trim().toLocaleLowerCase()
  const candidates = catalog.ids
    .flatMap((id) => {
      const row = catalog.byId[id]
      return row === undefined ? [] : [row]
    })
    .filter(s => s.origin !== 'subagent' && !workspaces.archivedSessionIds.includes(s.id))
    .map(session => ({ session, project: workspaces.items.find(w => w.sessionIds.includes(session.id)) }))
    .filter(row => row.project?.workspaceId === selectedProject && selectedProject !== undefined)
    .filter(row => row.session.displayTitle.toLocaleLowerCase().includes(normalized))
    .sort((a, b) => b.session.updatedAt - a.session.updatedAt)
    .slice(0, 30)
  const rows = (
    <>
      {candidates.map(({ session }) => (
        <MenuItemButton
          key={session.id}
          role={props.inline ? 'button' : 'menuitem'}
          disabled={busy}
          current={session.id === pane.sessionId}
          onSelect={() => {
            selectConversation(pane.id, session.id)
          }}
        >
          <span className={css.choiceRow}>
            <span className={css.choiceTitle} data-conversation-choice={session.id}>
              {session.displayTitle}
            </span>
            {opened.includes(session.id) && <span className={css.choiceOpened}>{t('paneOpened')}</span>}
          </span>
        </MenuItemButton>
      ))}
      {candidates.length === 0 && (
        <p className={css.empty}>{t(catalog.phase === 'pending' ? 'loading' : 'paneNoResults')}</p>
      )}
    </>
  )
  return (
    <div className={css.choices} data-conversation-choices=""
      onKeyDown={(event) => {
        if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
          || composition.current?.guards(event.nativeEvent)) return
        const target = event.target
        if (target !== input.current && !(target instanceof Node && results.current?.contains(target))) return
        const buttons = Array.from(results.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
        if (buttons.length === 0) return
        if (event.key === 'Enter' && target === input.current) {
          event.preventDefault()
          buttons[0]?.click()
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          const index = buttons.findIndex(button => button === target)
          const next = index === -1 ? (event.key === 'ArrowDown' ? 0 : buttons.length - 1)
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
          buttons[next]?.focus()
          buttons[next]?.scrollIntoView({ block: 'nearest' })
        }
      }}>
      <input
        ref={input}
        className={css.search}
        aria-label={t('paneSearch')}
        placeholder={t('paneSearch')}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
        }}
        disabled={busy}
      />
      <div className={css.newConversation}>
        <label className={css.projectFilter}>
          <span>{t('paneProject')}</span>
          <select
            aria-label={t('paneProject')}
            value={selectedProject ?? ''}
            onChange={(event) => {
              setProject(event.target.value as WorkspaceId)
            }}
            disabled={busy}
          >
            {workspaces.items.map(w => (
              <option key={w.workspaceId} value={w.workspaceId}>
                {w.title}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className={css.newButton}
          disabled={busy || selectedProject === undefined}
          onClick={() => {
            if (selectedProject !== undefined) void createConversation(pane.id, selectedProject)
          }}
        >
          <Glyph name="plus" size={16} />
          {t('newTask')}
        </button>
      </div>
      {failed && (
        <p role="alert" className={css.failure}>
          {t('paneCreateFailed')}
        </p>
      )}
      <div className={css.recentGroup}>
        <h3>{t('paneRecent')}</h3>
        <div ref={results} className={css.recent} role="group" aria-label={t('paneRecent')}>
          {rows}
        </div>
      </div>
    </div>
  )
}

/** Pane controls use the same icons and primitives inside the original conversation header. */
function PaneButtons({
  id,
  canSplitX,
  canSplitY,
  count,
  splitPane,
  closePane,
  t,
}: {
  id: string
  canSplitX: boolean
  canSplitY: boolean
  count: number
  splitPane: PanesInjected['splitPane']
  closePane: PanesInjected['closePane']
  t: PaneProps['t']
}) {
  const shortcuts = paneShortcutKeys()
  return (
    <div className={css.actions}>
      <Tooltip label={t('paneSplitRight')} shortcutKeys={shortcuts.right} portal>
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('paneSplitRight')}
          disabled={!canSplitX}
          onClick={() => {
            splitPane(id, 'x')
          }}
        >
          <Glyph name="columns-2" size={16} />
        </button>
      </Tooltip>
      <Tooltip label={t('paneSplitDown')} shortcutKeys={shortcuts.down} portal>
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('paneSplitDown')}
          disabled={!canSplitY}
          onClick={() => {
            splitPane(id, 'y')
          }}
        >
          <span className={css.horizontalIcon}>
            <Glyph name="columns-2" size={16} />
          </span>
        </button>
      </Tooltip>
      {count > 1 && (
        <Tooltip label={t('paneClose')} shortcutKeys={shortcuts.close} portal>
          <button
            type="button"
            className={css.iconButton}
            aria-label={t('paneClose')}
            onClick={() => {
              closePane(id)
            }}
          >
            <Glyph name="x" size={16} />
          </button>
        </Tooltip>
      )}
    </div>
  )
}

/** Add pane commands to the existing header without redeclaring its slots. */
export function PaneControls(
  props: PropsRuntime<'conversation.session.header.utilities'> & PropsLocale<'verboo'> & InjectFace<PanesInjected>,
) {
  const pane = props.usePanes(s => leaves(s.layout.root).find(p => p.sessionId === props.sessionId))
  const count = props.usePanes(s => leaves(s.layout.root).length)
  const element = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  useLayoutEffect(() => {
    const area = element.current?.closest<HTMLElement>('[data-pane-id]')
    if (!area) return
    const update = () => {
      setSize(previous =>
        previous.width === area.clientWidth && previous.height === area.clientHeight
          ? previous
          : { width: area.clientWidth, height: area.clientHeight },
      )
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(area)
    return () => {
      observer.disconnect()
    }
  }, [pane?.id])
  return (
    <div ref={element}>
      {pane && (
        <PaneButtons
          id={pane.id}
          count={count}
          canSplitX={count < MAX_PANES && size.width >= props.minimumWidth * 2}
          canSplitY={count < MAX_PANES && size.height >= props.minimumHeight * 2}
          splitPane={props.splitPane}
          closePane={props.closePane}
          t={props.t}
        />
      )}
    </div>
  )
}

/** Reuse the shipped header, transcript and composer Factories under an explicit Session binding. */
export function Pane(props: PaneProps) {
  const {
    pane,
    sessionId,
    useSession,
    useConversation,
    useSessions,
    usePanes,
    renderFactorySlot,
    choosePane,
    splitPane,
    closePane,
    canSplitX,
    canSplitY,
    focusComposer,
    t,
  } = props
  const session = useSession(s => s)
  const conversation = useConversation(s => s)
  const summary = useSessions(s => (sessionId === undefined ? undefined : s.byId[sessionId]))
  const selecting = usePanes(s => s.choosing === pane.id)
  const count = usePanes(s => leaves(s.layout.root).length)
  const focusRequest = usePanes(s => (s.focusRequest?.pane === pane.id ? s.focusRequest.sequence : 0))
  const appliedFocus = useRef(0)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (focusRequest === 0 || appliedFocus.current === focusRequest) return
    appliedFocus.current = focusRequest
    if (pane.sessionId === null) root.current?.querySelector<HTMLInputElement>('input')?.focus()
    else focusComposer(pane.id)
  }, [focusRequest, focusComposer, pane.id, pane.sessionId])
  const active =
    session !== undefined &&
    conversation !== undefined &&
    (conversation.activeTargets.size > 0 || (!session.blank && !session.awaitingFirstTurn) || session.running)
  const phase = active ? 'active' : session?.promptAttempted ? 'engaging' : 'blank'
  const settling =
    sessionId !== undefined && phase === 'blank' && session?.openState === 'loading' && summary?.blank !== true
  const hero =
    sessionId === undefined || (phase === 'blank' && (session?.openState === 'open' || summary?.blank === true))
  return (
    <div className={css.conversation} ref={root}>
      {pane.sessionId === null ? (
        <header className={css.header}>
          <span className={css.title}>{t('paneChoose')}</span>
          <PaneButtons
            id={pane.id}
            count={count}
            canSplitX={canSplitX}
            canSplitY={canSplitY}
            splitPane={splitPane}
            closePane={closePane}
            t={t}
          />
        </header>
      ) : (
        renderFactorySlot('conversation.header.content', {
          onChooseConversation: () => {
            choosePane(selecting ? null : pane.id)
          },
        })
      )}
      <Menu
        autoFocus={false}
        nativeTab
        open={selecting && pane.sessionId !== null}
        onClose={() => {
          choosePane(null)
        }}
        portal
        minWidthFromAnchor
        getAnchorRect={() =>
          root.current?.querySelector('[data-conversation-selector]')?.getBoundingClientRect() ?? null
        }
        returnFocus={() => props.paneFocusTarget(pane.id)}
        listClassName={css.choiceMenu}
        anchor={<span />}
      >
        {selecting && pane.sessionId !== null && <Choices {...props} />}
      </Menu>
      {pane.sessionId === null ? (
        <div className={css.emptyPane}>
          <Choices {...props} inline />
        </div>
      ) : (
        renderFactorySlot('conversation.content', {
          variant: 'embedded',
          phase: settling ? 'settling' : hero ? 'hero' : 'active',
          hero,
        })
      )}
    </div>
  )
}
