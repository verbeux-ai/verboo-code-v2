/**
 * Deterministic grouping of catalog toolkits into human-readable categories.
 *
 * The table below is the authority for known slugs. An unknown slug falls back
 * to a keyword heuristic and finally to `others`, so the catalog never renders
 * an unlabeled group and the ordering stays stable between reads.
 *
 * @module
 */

/** Stable category identities shared by the filter chips and their locale keys. */
export type CategoryId =
  | 'development'
  | 'communication'
  | 'productivity'
  | 'files'
  | 'design'
  | 'data'
  | 'crm'
  | 'support'
  | 'finance'
  | 'others'

/** Display order of every category; `others` always sorts last. */
export const CATEGORY_ORDER: readonly CategoryId[] = [
  'development',
  'communication',
  'productivity',
  'files',
  'design',
  'data',
  'crm',
  'support',
  'finance',
  'others',
]

/**
 * Known toolkit slugs by category. Slugs are stored normalized: lower case with
 * separators removed, which is how `categoryOf` looks them up.
 */
const CATEGORY_TABLE: Readonly<Record<string, CategoryId>> = {
  github: 'development',
  gitlab: 'development',
  bitbucket: 'development',
  gitea: 'development',
  jira: 'development',
  linear: 'development',
  sentry: 'development',
  vercel: 'development',
  netlify: 'development',
  railway: 'development',
  cloudflare: 'development',
  aws: 'development',
  gcp: 'development',
  azure: 'development',
  docker: 'development',
  kubernetes: 'development',
  postman: 'development',
  circleci: 'development',
  githubactions: 'development',
  slack: 'communication',
  discord: 'communication',
  teams: 'communication',
  zoom: 'communication',
  telegram: 'communication',
  whatsapp: 'communication',
  twilio: 'communication',
  sendgrid: 'communication',
  mailchimp: 'communication',
  gmail: 'communication',
  outlook: 'communication',
  notion: 'productivity',
  googlecalendar: 'productivity',
  calendly: 'productivity',
  todoist: 'productivity',
  asana: 'productivity',
  trello: 'productivity',
  clickup: 'productivity',
  monday: 'productivity',
  confluence: 'productivity',
  evernote: 'productivity',
  coda: 'productivity',
  docusign: 'productivity',
  googledrive: 'files',
  dropbox: 'files',
  box: 'files',
  onedrive: 'files',
  sharepoint: 'files',
  googlecloudstorage: 'files',
  figma: 'design',
  canva: 'design',
  miro: 'design',
  sketch: 'design',
  framer: 'design',
  invision: 'design',
  airtable: 'data',
  bigquery: 'data',
  snowflake: 'data',
  postgres: 'data',
  mysql: 'data',
  mongodb: 'data',
  redis: 'data',
  clickhouse: 'data',
  datadog: 'data',
  grafana: 'data',
  looker: 'data',
  tableau: 'data',
  metabase: 'data',
  amplitude: 'data',
  mixpanel: 'data',
  segment: 'data',
  googleanalytics: 'data',
  hubspot: 'crm',
  salesforce: 'crm',
  pipedrive: 'crm',
  close: 'crm',
  zoho: 'crm',
  copper: 'crm',
  attio: 'crm',
  zendesk: 'support',
  freshdesk: 'support',
  helpscout: 'support',
  intercom: 'support',
  servicenow: 'support',
  front: 'support',
  crisp: 'support',
  stripe: 'finance',
  paypal: 'finance',
  quickbooks: 'finance',
  xero: 'finance',
  wise: 'finance',
  revolut: 'finance',
  plaid: 'finance',
  ramp: 'finance',
  brex: 'finance',
  chargebee: 'finance',
}

/**
 * Keyword hints for slugs the table does not name. Longer, more specific hints
 * come first so `helpdesk` resolves to support before the generic `desk` rule.
 */
const KEYWORD_HINTS: readonly (readonly [string, CategoryId])[] = [
  ['whiteboard', 'design'],
  ['design', 'design'],
  ['canvas', 'design'],
  ['proto', 'design'],
  ['calendar', 'productivity'],
  ['schedul', 'productivity'],
  ['todo', 'productivity'],
  ['note', 'productivity'],
  ['task', 'productivity'],
  ['helpdesk', 'support'],
  ['support', 'support'],
  ['ticket', 'support'],
  ['crm', 'crm'],
  ['sales', 'crm'],
  ['deal', 'crm'],
  ['lead', 'crm'],
  ['invoice', 'finance'],
  ['billing', 'finance'],
  ['pay', 'finance'],
  ['finance', 'finance'],
  ['accounting', 'finance'],
  ['bank', 'finance'],
  ['warehouse', 'data'],
  ['analytic', 'data'],
  ['metric', 'data'],
  ['dashboard', 'data'],
  ['sql', 'data'],
  ['db', 'data'],
  ['data', 'data'],
  ['storage', 'files'],
  ['drive', 'files'],
  ['file', 'files'],
  ['mail', 'communication'],
  ['chat', 'communication'],
  ['messag', 'communication'],
  ['git', 'development'],
  ['code', 'development'],
  ['deploy', 'development'],
  ['devops', 'development'],
  ['ci', 'development'],
]

/**
 * Resolve the catalog category of one toolkit slug.
 * @param slug - host-provided toolkit identity.
 * @returns the matching category, never undefined.
 */
export function categoryOf(slug: string): CategoryId {
  const normalized = slug.toLocaleLowerCase().replaceAll(/[^a-z0-9]/g, '')
  const known = CATEGORY_TABLE[normalized]
  if (known !== undefined) return known
  for (const [needle, category] of KEYWORD_HINTS)
    if (normalized.includes(needle)) return category
  return 'others'
}
