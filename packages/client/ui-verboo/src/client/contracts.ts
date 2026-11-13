import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {
  HostObservable,
  InjectFace,
  PropsLocale,
  PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { ThemePreference } from '@deepseek-ai/dsh-client-ui-theme/client'
import type { ProductSnapshot } from './model.ts'
import type {
  ConnectionId,
  PlanId,
  StaminaStatus,
} from '@deepseek-ai/dsh-api-verboo-product/types'
import type { McpServerInput } from '@deepseek-ai/dsh-api-verboo-mcp/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { Key } from './locales.ts'
import type {} from '@deepseek-ai/dsh-openai-account/remote'
import type { SubscriptionUsage } from './subscription-usage-resource.ts'
import type { ConnectionStateSource } from '@deepseek-ai/dsh-client-connection/client'
/** Transport observations; a disconnected conversation cannot report a confirmed idle state. */
export interface ExecutionInjected {
  hooks: { executionConnection: ConnectionStateSource }
}
/** Session-scoped execution facts rendered below the composer. */
export type ExecutionProps = PropsRuntime<'conversation.composer.dock'> & PropsLocale<'verboo'> & InjectFace<ExecutionInjected>
/** Theme and language choices observed by product components. */
export interface PreferenceSnapshot {
  theme: ThemePreference
  locale: string
  languages: readonly { id: string; label: string }[]
}
/** Renderer-bound account observations and user commands. */
/** Stored [OI] session facts the dialog reads; presence is a storage claim only. */
export interface OpenAiStatus {
  /** Whether a session is stored for this installation. */
  readonly signedIn: boolean
  /** ChatGPT plan named by the stored token, such as `team`. */
  readonly planType?: string
  /** End of the paid window, as an ISO-8601 instant. */
  readonly activeUntil?: string
}

/** The actions and stores the product face contributes to every surface it mounts. */
export interface ProductInjected {
  hooks: {
    product: HostObservable<ProductSnapshot>
    preferences: HostObservable<PreferenceSnapshot>
    navigation: HostObservable<readonly { id: MainPanelId; label: string }[]>
    /** Stored [OI] session facts, refreshed on every read of the account page. */
    externalStatus: HostObservable<OpenAiStatus>
  }
  start(): void
  reopen(): void
  cancel(): void
  retryAccount(): void
  signOut(): Promise<boolean>
  startSession(): void
  openSession(id: SessionId): void
  openWorkspace(id: WorkspaceId): void
  addProject(): Promise<void>
  renameProject(id: WorkspaceId, title: string): Promise<void>
  removeProject(id: WorkspaceId): Promise<void>
  sessionMenu(
    id: SessionId,
    title: string,
    point: { x: number; y: number },
  ): void
  selectPanel(id: MainPanelId | null): void
  toggleSidebar(): void
  loadPlans(): void
  loadConnections(): void
  /** Start one [OI] sign-in: build the URL, open it, and return the handle it issued. */
  beginOpenAiSignIn(): Promise<{ url: string; handle: string } | undefined>
  /** Wait for the browser to reach the callback, then finish the [OI] sign-in. */
  completeOpenAiSignIn(handle: string): Promise<boolean>
  /** Read the stored [OI] session's plan facts. */
  openAiStatus(): Promise<OpenAiStatus>
  /** Remove the stored [OI] session. */
  signOutOpenAi(): Promise<void>
  /** Refresh the external subscription reading after a sign-in change. */
  refreshSubscriptionUsage(): void
  /** Re-read the stored [OI] session and open the dialog that reports it. */
  openOpenAiDialog(): void
  /** Close the [OI] dialog. */
  closeOpenAiDialog(): void
  refreshStamina(): void
  connect(slug: string, label: string): Promise<boolean>
  reopenConnection(id: ConnectionId): void
  disconnect(id: ConnectionId): Promise<boolean>
  /** Re-read every user-defined MCP server and its live connection state. */
  loadMcpServers(): void
  /** Create or replace one user-defined MCP server. */
  saveMcpServer(input: McpServerInput): Promise<boolean>
  /** Remove one user-defined MCP server and withdraw its tools. */
  deleteMcpServer(name: string): Promise<boolean>
  /** Connect or disconnect one stored definition without editing it. */
  setMcpEnabled(name: string, enabled: boolean): Promise<boolean>
  /** Test a definition without saving it. */
  probeMcpServer(input: McpServerInput): Promise<boolean>
  /** Drop the last probe outcome. */
  clearMcpProbe(): void
  billing(id: PlanId | null, purchase: boolean): void
  dismiss(): void
  setTheme(theme: 'light' | 'dark' | 'system'): void
  setLocale(locale: string): void
  retryModel(): void
  help(): void
}
/** Localized product observations and commands for a root component. */
export type ProductProps = PropsLocale<'verboo'> & InjectFace<ProductInjected>
/** Product capabilities and the central page renderer. */
export type PageProps = ProductProps & PropsRuntime<'main'>
/** Product capabilities and the navigation renderer. */
export type SidebarProps = ProductProps & PropsRuntime<'sidebar'> & InjectFace<ExecutionInjected>
/** Product capabilities and the conversation introduction renderer. */
export type HeroProps = ProductProps & PropsRuntime<'conversation.hero.intro'>
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    verboo: Key
  }
  interface ResourceProtocolMap {
    /** Public stamina for the account encoded in the resource address. */
    'verboo-stamina': StaminaStatus[]
    /** Usage reading of the external subscription serving the account's ChatGPT route. */
    'verboo-subscription-usage': SubscriptionUsage
  }
}
