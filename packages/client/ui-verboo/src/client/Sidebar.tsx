import { workspaceDisplayTitle } from '@deepseek-ai/dsh-api-workspace-controller/default-workspace'
import { useRef, useState } from 'react'
import {
  Menu,
  Modal,
  Tooltip,
  useModalLayer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { FactoryComponentPropsOf } from '@deepseek-ai/dsh-client-ui-slots'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SidebarProps, ProductProps } from './contracts.ts'
import { Brand, BrandMark } from './Brand.tsx'
import { Glyph } from './Glyph.tsx'
import css from './Product.module.css'
const panels = {
  connections: 'verboo.connections' as MainPanelId,
  plan: 'verboo.plan' as MainPanelId,
  preferences: 'verboo.preferences' as MainPanelId,
}

function ConversationRow({
  session,
  active,
  props,
  close,
}: {
  session: SessionSummary
  active: boolean
  props: SidebarProps
  close: () => void
}) {
  const connection = props.useExecutionConnection(state => state)
  const waiting = props.useSessionStatus(state => state.get(session.id)?.pendingInteraction !== undefined)
  const state = connection === undefined ? 'connecting' : connection !== 'connected' ? 'reconnecting' : waiting ? 'waiting' : session.running ? 'working' : 'idle'
  const label = props.t(state === 'connecting' ? 'executionConnecting' : state === 'reconnecting' ? 'executionReconnecting' : state === 'waiting' ? 'executionWaiting' : state === 'working' ? 'executionWorking' : 'executionIdle')
  const title = session.blank ? props.t('newTask') : session.displayTitle
  const openMenu = (point: { x: number; y: number }) =>{
    props.sessionMenu(session.id, session.displayTitle, point) }
  return (
    <div
      className={css.sessionItem}
      data-active={active}
      data-verboo-session={session.id}
      data-state={state}
      onContextMenu={(event) => {
        event.preventDefault()
        openMenu({ x: event.clientX, y: event.clientY })
      }}
    >
      <button
        className={css.sessionRow}
        aria-current={active ? 'page' : undefined}
        title={title}
        onClick={() => {
          props.openSession(session.id)
          close()
        }}
      >
        <span className={css.sessionTitle}>{title}</span>
        <span className={css.sessionState}>
          <span className={css.executionDot} aria-hidden="true" />
          {label}
        </span>
      </button>
      <Tooltip portal label={props.t('conversationActions')}>
        <button
          className={css.rowMore}
          aria-label={`${props.t('conversationActions')}: ${title}`}
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect()
            openMenu({ x: box.right, y: box.bottom })
          }}
        >
          <Glyph name="ellipsis" size={15} />
        </button>
      </Tooltip>
    </div>
  )
}
function ProjectGroup({
  workspace,
  sessions,
  current,
  props,
  query,
  close,
}: {
  workspace: WorkspaceView
  sessions: SessionSummary[]
  current: SessionId | undefined
  props: SidebarProps
  query: string
  close: () => void
}) {
  const [menu, setMenu] = useState(false)
  const [action, setAction] = useState<'rename' | 'remove' | null>(null)
  const [title, setTitle] = useState(workspace.title)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const submit = async () => {
    setBusy(true)
    setFailed(false)
    try {
      if (action === 'rename')
        await props.renameProject(workspace.workspaceId, title.trim())
      else await props.removeProject(workspace.workspaceId)
      setAction(null)
    } catch (_error) {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <details className={css.projectGroup} open>
      <summary>
        <Glyph name="folder" size={16} />
        <span>{workspaceDisplayTitle(workspace.title,props.t('workspace'))}</span>
        <Menu
          open={menu}
          onClose={() =>{  setMenu(false) }}
          portal
          align="end"
          anchor={
            <button
              className={css.rowMore}
              aria-label={`${props.t('projectActions')}: ${workspace.title}`}
              onClick={(event) => {
                event.preventDefault()
                setMenu(!menu)
              }}
            >
              <Glyph name="ellipsis" size={15} />
            </button>
          }
          items={[
            {
              id: 'rename',
              label: props.t('renameProject'),
              disabled: !props.useWorkspaceAccess(
                workspace.workspaceId,
                'workspace/rename',
              ),
            },
            {
              id: 'remove',
              label: props.t('removeProject'),
              disabled: !props.useWorkspaceAccess(
                workspace.workspaceId,
                'workspace/delete',
              ),
            },
          ]}
          onSelect={(id) => {
            setMenu(false)
            setFailed(false)
            setTitle(workspace.title)
            setAction(id === 'rename' ? 'rename' : 'remove')
          }}
        />
      </summary>
      <div className={css.sessionList}>
        {query === '' && (
          <button
            className={css.projectStart}
            onClick={() => {
              props.openWorkspace(workspace.workspaceId)
              close()
            }}
          >
            <Glyph name="plus" size={13} />
            {props.t('newTask')}
          </button>
        )}
        {sessions.map(session => (
          <ConversationRow
            key={session.id}
            session={session}
            active={current === session.id}
            props={props}
            close={close}
          />
        ))}
      </div>
      <Modal
        open={action !== null}
        onClose={() => {
          if (!busy) setAction(null)
        }}
        title={props.t(action === 'rename' ? 'renameProject' : 'removeProject')}
        description={props.t(
          action === 'rename'
            ? 'renameProjectDescription'
            : 'removeProjectDescription',
        )}
        closeLabel={props.t('close')}
        className={css.confirmDialog ?? ''}
        footer={
          <>
            <button
              className={css.secondary}
              disabled={busy}
              onClick={() =>{  setAction(null) }}
            >
              {props.t('cancel')}
            </button>
            <button
              className={css.primary}
              disabled={busy || (action === 'rename' && title.trim() === '')}
              onClick={() => {
                void submit()
              }}
            >
              {props.t(action === 'rename' ? 'save' : 'removeProject')}
            </button>
          </>
        }
      >
        <div className={css.connectForm}>
          {action === 'rename' ? (
            <>
              <label htmlFor={`project-${workspace.workspaceId}`}>
                {props.t('projectName')}
              </label>
              <input
                id={`project-${workspace.workspaceId}`}
                value={title}
                maxLength={100}
                onChange={(event) =>{  setTitle(event.target.value) }}
                data-modal-autofocus
              />
            </>
          ) : (
            <p className={css.confirmIdentity}>{workspace.title}</p>
          )}
          {failed && (
            <p className={css.error} role="alert">
              {props.t('actionFailed')}
            </p>
          )}
        </div>
      </Modal>
    </details>
  )
}
/** Product navigation reads the canonical Workspace and Session controllers. */
export function Sidebar(props: SidebarProps) {
  const { t, collapsed, drawer, toggleSidebar, usePanelInfo } = props
  const state = props.useProduct(s => s)
  const extras = props.useNavigation(s => s)
  const selected = usePanelInfo(s => s.activePanelId)
  const wide = drawer || !collapsed
  const ref = useRef<HTMLDivElement>(null)
  useModalLayer(ref, drawer && !collapsed, toggleSidebar)
  const workspaces = props.useWorkspaces(s => s)
  const sessions = props.useSessions(s => s)
  const current = Object.values(sessions.byId).find(
    s => (s.retainedBy.mainView ?? 0) > 0,
  )?.id
  const [adding, setAdding] = useState(false)
  const [projectError, setProjectError] = useState(false)
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [archived, setArchived] = useState(false)
  const openProject = async () => {
    setAdding(true)
    setProjectError(false)
    try {
      await props.addProject()
    } catch (_error) {
      setProjectError(true)
    } finally {
      setAdding(false)
    }
  }
  const closeDrawer = () => {
    if (drawer && !collapsed) toggleSidebar()
  }
  const go = (id: MainPanelId | null) => {
    props.selectPanel(id)
    closeDrawer()
  }
  const active = state.plans?.subscriptions.find(
    s => s.status === 'active' || s.status === 'trialing',
  )
  const planLabel =
    state.plans === null
      ? t(state.plansFailed ? 'planUnavailable' : 'loading')
      : (active?.name ?? t('noPlan'))
  const needle = query.trim().toLocaleLowerCase()
  const rows = (ids: readonly SessionId[]) =>
    ids
      .filter(id => workspaces.archivedSessionIds.includes(id) === archived)
      .map(id => sessions.byId[id])
      .filter(s => s !== undefined)
      .filter(
        s =>
          s.origin !== 'subagent' &&
          (!s.blank || s.id === current) &&
          (needle === '' ||
            s.displayTitle.toLocaleLowerCase().includes(needle)),
      )
  const owned = new Set(workspaces.items.flatMap(w => w.sessionIds))
  const ungrouped = rows(sessions.ids.filter(id => !owned.has(id)))
  return (
    <div ref={ref} className={css.sidebar} data-wide={wide} data-verboo-shell>
      <div className={css.sidebarHead}>
        {wide ? <Brand t={t} /> : <BrandMark />}
        <Tooltip portal label={t(collapsed ? 'expand' : 'collapse')}>
          <button
            className={css.iconButton}
            aria-label={t(collapsed ? 'expand' : 'collapse')}
            onClick={toggleSidebar}
            data-sidebar-toggle
          >
            <Glyph
              name={collapsed ? 'panel-left-open' : 'panel-left-close'}
              size={17}
            />
          </button>
        </Tooltip>
      </div>
      <Tooltip portal label={t('newTask')} disabled={wide}>
        <button
          className={css.newTask}
          onClick={() => {
            props.startSession()
            closeDrawer()
          }}
          aria-label={t('newTask')}
        >
          <Glyph name="plus" />
          {wide && <span>{t('newTask')}</span>}
        </button>
      </Tooltip>
      <nav className={css.navigation} aria-label={t('navigation')}>
        <Tooltip portal label={t('workspace')} disabled={wide}>
          <button
            className={css.navRow}
            data-active={selected === null}
            onClick={() =>{  go(null) }}
            aria-label={t('workspace')}
            aria-current={selected === null ? 'page' : undefined}
          >
            <Glyph name="layout-grid" />
            {wide && <span>{t('workspace')}</span>}
          </button>
        </Tooltip>
        <Tooltip portal label={t('connections')} disabled={wide}>
          <button
            className={css.navRow}
            data-active={selected === panels.connections}
            onClick={() =>{  go(panels.connections) }}
            aria-label={t('connections')}
            aria-current={selected === panels.connections ? 'page' : undefined}
          >
            <Glyph name="cable" />
            {wide && <span>{t('connections')}</span>}
            {wide &&
              state.connections?.accounts.some(
                a => a.status === 'connected',
              ) && <i className={css.dot} />}
          </button>
        </Tooltip>
        {extras.map(panel => (
          <Tooltip portal key={panel.id} label={panel.label} disabled={wide}>
            <button
              className={css.navRow}
              data-active={selected === panel.id}
              onClick={() =>{  go(panel.id) }}
              aria-label={panel.label}
            >
              <Glyph name={panel.id === 'schedules' ? 'clock-3' : 'workflow'} />
              {wide && (
                <span>
                  {panel.id === 'schedules'
                    ? t('automations')
                    : panel.id === 'jobs'
                      ? t('tasks')
                      : panel.label}
                </span>
              )}
            </button>
          </Tooltip>
        ))}
      </nav>
      <div className={css.projectArea}>
        <div className={css.sectionHeader}>
          {wide && (
            <p className={css.sectionLabel}>
              {t(archived ? 'archived' : 'projects')}
            </p>
          )}
          <div className={css.sectionActions}>
            <Tooltip portal label={t('searchProjects')}>
              <button
                className={css.iconButton}
                aria-label={t('searchProjects')}
                onClick={() => {
                  if (!wide) toggleSidebar()
                  setSearching(!searching)
                }}
              >
                <Glyph name="search" size={14} />
              </button>
            </Tooltip>
            {wide && (
              <Tooltip
                portal
                label={t(archived ? 'showActive' : 'showArchived')}
              >
                <button
                  className={css.iconButton}
                  aria-label={t(archived ? 'showActive' : 'showArchived')}
                  aria-pressed={archived}
                  onClick={() =>{  setArchived(!archived) }}
                >
                  <Glyph name="archive" size={14} />
                </button>
              </Tooltip>
            )}
            <Tooltip portal label={t('addProject')}>
              <button
                className={css.iconButton}
                disabled={adding}
                aria-label={t('addProject')}
                onClick={() => {
                  void openProject()
                }}
              >
                <Glyph name={adding ? 'loader-circle' : 'plus'} size={15} />
              </button>
            </Tooltip>
          </div>
        </div>
        {searching && wide && (
          <label className={css.projectSearch}>
            <input
              value={query}
              placeholder={t('searchProjects')}
              aria-label={t('searchProjects')}
              onChange={(event) =>{  setQuery(event.target.value) }}
            />
          </label>
        )}
        {(projectError || workspaces.state === 'error') && (
          <p className={css.error} role="alert">
            {t(projectError ? 'actionFailed' : 'projectsUnavailable')}
          </p>
        )}
        {wide && (
          <div className={css.projectList}>
            {workspaces.items
              .map(workspace => ({
                workspace,
                rows: rows(workspace.sessionIds),
              }))
              .filter(
                ({ workspace, rows }) =>
                  needle === '' ||
                  rows.length > 0 ||
                  workspace.title.toLocaleLowerCase().includes(needle),
              )
              .map(({ workspace, rows }) => (
                <ProjectGroup
                  key={workspace.workspaceId}
                  workspace={workspace}
                  sessions={rows}
                  current={selected === null ? current : undefined}
                  props={props}
                  query={query}
                  close={closeDrawer}
                />
              ))}
            {ungrouped.length > 0 && (
              <div className={css.ungrouped}>
                <p className={css.sectionLabel}>{t('conversations')}</p>
                {ungrouped.map(session => (
                  <ConversationRow
                    key={session.id}
                    session={session}
                    active={session.id === current && selected === null}
                    props={props}
                    close={closeDrawer}
                  />
                ))}
              </div>
            )}
            {workspaces.phase === 'ready' &&
              workspaces.items.length === 0 &&
              ungrouped.length === 0 && (
              <p className={css.sidebarEmpty}>{t('projectsEmpty')}</p>
            )}
          </div>
        )}
      </div>
      <footer className={css.sidebarFoot}>
        <Tooltip portal label={t('plan')} disabled={wide}>
          <button
            className={css.planShortcut}
            data-active={selected === panels.plan}
            onClick={() =>{  go(panels.plan) }}
            aria-label={t('plan')}
            aria-current={selected === panels.plan ? 'page' : undefined}
          >
            <Glyph name="credit-card" />
            {wide && (
              <>
                <span>
                  <span className={css.planLabel}>{t('plan')}</span>
                  <span className={css.planName}>{planLabel}</span>
                </span>
                <Glyph name="arrow-up-right" size={15} />
              </>
            )}
          </button>
        </Tooltip>
        <Tooltip portal label={t('preferences')} disabled={wide}>
          <button
            className={css.profileShortcut}
            data-active={selected === panels.preferences}
            onClick={() =>{  go(panels.preferences) }}
            aria-label={t('preferences')}
            aria-current={selected === panels.preferences ? 'page' : undefined}
          >
            <span className={css.avatar}>
              {state.profile?.name?.slice(0, 1).toLocaleUpperCase() ?? (
                <Glyph name="circle-user-round" size={18} />
              )}
            </span>
            {wide && (
              <>
                <span className={css.profileName}>
                  {state.profile?.name ?? t('account')}
                </span>
                <Glyph name="settings-2" size={17} />
              </>
            )}
          </button>
        </Tooltip>
      </footer>
    </div>
  )
}
export function Leading(props: ProductProps) {
  return (
    <Tooltip portal label={props.t('expand')}>
      <button
        className={css.iconButton}
        onClick={props.toggleSidebar}
        aria-label={props.t('expand')}
        data-sidebar-opener
      >
        <Glyph name="panel-left-open" />
      </button>
    </Tooltip>
  )
}
export function PanelIcon({
  id,
  size,
  active,
  renderSlot,
}: FactoryComponentPropsOf<'sidebar.panel.icon'>) {
  return renderSlot('sidebar.panellist', { size, active }, { only: id })
}
