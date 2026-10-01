import type { Node } from '@tiptap/pm/model';
import {
  NodeSelection,
  type EditorState,
  type Transaction,
} from '@tiptap/pm/state';
import {
  relativePositionToAbsolutePosition,
  ySyncPluginKey,
} from '@tiptap/y-tiptap';
import * as Y from 'yjs';

export interface BlockHandleAnchor {
  pos: number;
  node: Node;
  relative: Y.RelativePosition | null;
}

export function blockHandleAnchor(
  state: EditorState,
  pos: number,
): BlockHandleAnchor | null {
  const node = state.doc.nodeAt(pos);
  if (!node) return null;
  const sync = ySyncPluginKey.getState(state);
  let relative: Y.RelativePosition | null = null;
  if (sync) {
    for (const [type, mapped] of sync.binding.mapping) {
      if (mapped === node && type instanceof Y.XmlElement) {
        // Anchor inside the block's Y element, including leaf/image elements.
        // A boundary anchor could resolve to the next block after deletion.
        const candidate = Y.createRelativePositionFromTypeIndex(type, 0);
        // Equal blocks can share a ProseMirror node instance; verify the
        // absolute location rather than choosing the first matching value.
        if (
          relativePositionToAbsolutePosition(
            sync.doc,
            sync.type,
            candidate,
            sync.binding.mapping,
          ) ===
          pos + 1
        ) {
          relative = candidate;
          break;
        }
      }
    }
  }
  return { pos, node, relative };
}

/** Resolve the action target without letting background updates override hover. */
export function blockHandleTarget(
  transaction: Transaction,
  current: BlockHandleAnchor | null,
  pinned: boolean,
  state: EditorState,
): number | null {
  if (pinned && current) {
    if (transaction.getMeta(ySyncPluginKey)) {
      const sync = ySyncPluginKey.getState(state);
      if (!sync || !current.relative) return null;
      const inside = relativePositionToAbsolutePosition(
        sync.doc,
        sync.type,
        current.relative,
        sync.binding.mapping,
      );
      if (inside == null || inside < 1) return null;
      const pos = inside - 1;
      return state.doc.nodeAt(pos)?.type === current.node.type ? pos : null;
    }
    const mapped = transaction.mapping.mapResult(current.pos);
    return mapped.deleted ? null : mapped.pos;
  }
  const selection = state.selection;
  if (selection instanceof NodeSelection) return selection.from;
  const pos = selection.$from;
  let depth = pos.depth;
  while (
    depth > 1 &&
    !['listItem', 'taskItem', 'toggle'].includes(pos.node(depth).type.name)
  )
    depth--;
  return depth ? pos.before(depth) : null;
}
