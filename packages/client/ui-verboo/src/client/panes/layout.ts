/** Persisted conversation-pane layout and bounded recursive geometry. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'

/** First-release product limit, independent of window dimensions. */
export const MAX_PANES = 4
/** Side-by-side or stacked split. */
export type PaneAxis = 'x' | 'y'
/** One independently selected conversation. */
export interface PaneLeaf {
  kind: 'pane'
  id: string
  sessionId: SessionId | null
  workspaceId?: WorkspaceId | undefined
}
/** A divider joining two independently splittable subtrees. */
export interface PaneSplit {
  kind: 'split'
  id: string
  axis: PaneAxis
  ratio: number
  first: PaneNode
  second: PaneNode
}
/** Persisted layout node. */
export type PaneNode = PaneLeaf | PaneSplit
/** Versioned, installation-local arrangement. */
export interface PaneLayout {
  version: 1
  root: PaneNode
  focused: string
}
/** Fractional rectangle inside a containing canvas. */
export interface PaneRect {
  x: number
  y: number
  width: number
  height: number
}
/** Leaves in stable layout traversal order.
 * @param node - layout subtree.
 * @returns its panes. */
export function leaves(node: PaneNode): PaneLeaf[] {
  return node.kind === 'pane' ? [node] : [...leaves(node.first), ...leaves(node.second)]
}
/** Replace a node without changing any other pane identity.
 * @param node - subtree.
 * @param id - node identity.
 * @param replace - transformation.
 * @returns updated subtree. */
export function mapNode(node: PaneNode, id: string, replace: (node: PaneNode) => PaneNode): PaneNode {
  if (node.id === id) return replace(node)
  if (node.kind === 'pane') return node
  return { ...node, first: mapNode(node.first, id, replace), second: mapNode(node.second, id, replace) }
}
/** Remove a leaf and collapse its parent.
 * @param node - subtree.
 * @param id - removed pane.
 * @returns surviving subtree, or null for its only leaf. */
export function removePane(node: PaneNode, id: string): PaneNode | null {
  if (node.kind === 'pane') return node.id === id ? null : node
  const first = removePane(node.first, id)
  const second = removePane(node.second, id)
  return first === null ? second : second === null ? first : { ...node, first, second }
}
/** Compute normalized rectangles for nodes and dividers.
 * @param node - subtree.
 * @param rect - containing rectangle.
 * @param result - accumulator.
 * @returns node rectangles. */
export function rectangles(
  node: PaneNode,
  rect: PaneRect = { x: 0, y: 0, width: 1, height: 1 },
  result = new Map<string, PaneRect>(),
): Map<string, PaneRect> {
  result.set(node.id, rect)
  if (node.kind === 'split') {
    const horizontal = node.axis === 'x'
    rectangles(
      node.first,
      {
        ...rect,
        width: horizontal ? rect.width * node.ratio : rect.width,
        height: horizontal ? rect.height : rect.height * node.ratio,
      },
      result,
    )
    rectangles(
      node.second,
      {
        ...rect,
        x: rect.x + (horizontal ? rect.width * node.ratio : 0),
        y: rect.y + (horizontal ? 0 : rect.height * node.ratio),
        width: horizontal ? rect.width * (1 - node.ratio) : rect.width,
        height: horizontal ? rect.height : rect.height * (1 - node.ratio),
      },
      result,
    )
  }
  return result
}
/** Minimum canvas size for all descendants.
 * @param node - subtree.
 * @param width - minimum leaf width.
 * @param height - minimum leaf height.
 * @returns required dimensions. */
export function minimumSize(node: PaneNode, width: number, height: number): { width: number; height: number } {
  if (node.kind === 'pane') return { width, height }
  const a = minimumSize(node.first, width, height)
  const b = minimumSize(node.second, width, height)
  return node.axis === 'x'
    ? { width: Math.max(a.width / node.ratio, b.width / (1 - node.ratio)), height: Math.max(a.height, b.height) }
    : { width: Math.max(a.width, b.width), height: Math.max(a.height / node.ratio, b.height / (1 - node.ratio)) }
}
/** Validate the local-storage document before retaining sessions.
 * @param value - parsed storage value.
 * @returns supported layout, or null. */
export function readLayout(value: unknown): PaneLayout | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('version' in value) ||
    value.version !== 1 ||
    !('root' in value) ||
    !('focused' in value) ||
    typeof value.focused !== 'string'
  )
    return null
  const ids = new Set<string>()
  const sessions = new Set<string>()
  let count = 0
  function valid(node: unknown, depth: number): node is PaneNode {
    if (
      typeof node !== 'object' ||
      node === null ||
      depth > MAX_PANES ||
      !('id' in node) ||
      typeof node.id !== 'string' ||
      node.id.length === 0 ||
      ids.has(node.id) ||
      !('kind' in node)
    )
      return false
    ids.add(node.id)
    if (node.kind === 'pane') {
      if (
        !('sessionId' in node) ||
        (node.sessionId !== null && (typeof node.sessionId !== 'string' || sessions.has(node.sessionId)))
      )
        return false
      if ('workspaceId' in node && typeof node.workspaceId !== 'string') return false
      if (typeof node.sessionId === 'string') sessions.add(node.sessionId)
      return ++count <= MAX_PANES
    }
    return (
      node.kind === 'split' &&
      'axis' in node &&
      (node.axis === 'x' || node.axis === 'y') &&
      'ratio' in node &&
      typeof node.ratio === 'number' &&
      Number.isFinite(node.ratio) &&
      node.ratio > 0 &&
      node.ratio < 1 &&
      'first' in node &&
      'second' in node &&
      valid(node.first, depth + 1) &&
      valid(node.second, depth + 1)
    )
  }
  if (!valid(value.root, 0) || !leaves(value.root).some(p => p.id === value.focused)) return null
  return { version: 1, root: value.root, focused: value.focused }
}
/** Find the nearest pane in one spatial direction.
 * @param layout - current arrangement.
 * @param direction - arrow direction.
 * @returns neighboring pane id, or current focus. */
export function neighbor(layout: PaneLayout, direction: 'left' | 'right' | 'up' | 'down'): string {
  const boxes = rectangles(layout.root)
  const current = boxAt(boxes, layout.focused)
  const horizontal = direction === 'left' || direction === 'right'
  const center = horizontal ? current.x + current.width / 2 : current.y + current.height / 2
  const cross = horizontal ? current.y + current.height / 2 : current.x + current.width / 2
  const sign = direction === 'left' || direction === 'up' ? -1 : 1
  let best = layout.focused
  let distance = Infinity
  for (const pane of leaves(layout.root)) {
    if (pane.id === layout.focused) continue
    const box = boxAt(boxes, pane.id)
    const overlap = horizontal
      ? Math.min(current.y + current.height, box.y + box.height) - Math.max(current.y, box.y)
      : Math.min(current.x + current.width, box.x + box.width) - Math.max(current.x, box.x)
    if (overlap <= 0.001) continue
    const along = (horizontal ? box.x + box.width / 2 : box.y + box.height / 2) - center
    const perpendicular = Math.abs((horizontal ? box.y + box.height / 2 : box.x + box.width / 2) - cross)
    if (along * sign > 0.001 && Math.abs(along) + perpendicular * 2 < distance) {
      distance = Math.abs(along) + perpendicular * 2
      best = pane.id
    }
  }
  return best
}

/** Resolve a rectangle produced from the same tree.
 * @param boxes - computed node positions.
 * @param id - existing node.
 * @returns its position. */
export function boxAt(boxes: ReadonlyMap<string, PaneRect>, id: string): PaneRect {
  const box = boxes.get(id)
  if (box === undefined) throw new Error('Pane node has no computed rectangle')
  return box
}
