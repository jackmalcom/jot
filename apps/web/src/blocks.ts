import { Node, mergeAttributes } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';

export interface PageOption {
  id: string;
  title: string;
  emoji: string | null;
}

export const ToggleSummary = Node.create({
  name: 'toggleSummary',
  addAttributes: () => ({
    level: {
      default: 0,
      parseHTML: (el) =>
        Number(
          el.getAttribute('aria-level') ||
            el.closest('[data-type="toggle"]')?.getAttribute('data-level'),
        ) || 0,
      renderHTML: (attrs) =>
        attrs.level >= 1 && attrs.level <= 6
          ? { role: 'heading', 'aria-level': attrs.level }
          : {},
    },
  }),
  content: 'inline*',
  defining: true,
  parseHTML: () => [{ tag: 'div[data-toggle-summary]' }],
  renderHTML: ({ HTMLAttributes }) => [
    'div',
    mergeAttributes(HTMLAttributes, {
      'data-toggle-summary': '',
      class: 'toggle-summary',
    }),
    0,
  ],
  addKeyboardShortcuts() {
    return {
      Backspace: () =>
        this.editor.commands.command(({ state, tr, dispatch }) => {
          const { selection } = state;
          if (!(selection instanceof TextSelection) || !selection.$cursor)
            return false;
          const { $cursor } = selection;
          if (
            $cursor.parent.type.name !== this.name ||
            $cursor.parent.content.size !== 0 ||
            $cursor.depth < 2
          )
            return false;

          const toggleDepth = $cursor.depth - 1;
          const toggle = $cursor.node(toggleDepth);
          if (toggle.type.name !== 'toggle') return false;
          const body = toggle.lastChild;
          const paragraph = body?.firstChild;
          // Only unwrap the initial empty structure. textContent alone would
          // also classify images, nested toggles, and other non-text blocks as
          // empty, and deleting their wrapper would lose the hidden content.
          // Consume Backspace otherwise so generic/native deletion cannot
          // normalize the required summary or alter the hidden body.
          if (
            body?.type.name !== 'toggleBody' ||
            body.childCount !== 1 ||
            paragraph?.type.name !== 'paragraph' ||
            paragraph.content.size !== 0
          )
            return true;

          const pos = $cursor.before(toggleDepth);
          const $pos = state.doc.resolve(pos);
          if (
            !$pos.parent.canReplaceWith(
              $pos.index(),
              $pos.index() + 1,
              paragraph.type,
            )
          )
            return true;
          if (dispatch) {
            tr.replaceWith(pos, pos + toggle.nodeSize, paragraph);
            tr.setSelection(TextSelection.create(tr.doc, pos + 1));
            tr.scrollIntoView();
          }
          return true;
        }),
      Enter: () => {
        const { $from } = this.editor.state.selection;
        if ($from.parent.type.name !== this.name) return false;
        const togglePos = $from.before($from.depth - 1);
        const dom = this.editor.view.nodeDOM(togglePos) as HTMLElement;
        if (dom?.dataset.open !== 'true')
          dom?.querySelector<HTMLButtonElement>('.toggle-disclosure')?.click();
        return this.editor.commands.setTextSelection($from.after() + 2);
      },
    };
  },
});
export const ToggleBody = Node.create({
  name: 'toggleBody',
  content: 'block+',
  defining: true,
  parseHTML: () => [{ tag: 'div[data-toggle-body]' }],
  renderHTML: ({ HTMLAttributes }) => [
    'div',
    mergeAttributes(HTMLAttributes, {
      'data-toggle-body': '',
      class: 'toggle-body',
    }),
    0,
  ],
});
export const Toggle = Node.create({
  name: 'toggle',
  group: 'block',
  content: 'toggleSummary toggleBody',
  defining: true,
  isolating: true,
  addAttributes: () => ({
    level: {
      default: 0,
      parseHTML: (el) => Number(el.getAttribute('data-level')) || 0,
      renderHTML: (attrs) => ({ 'data-level': attrs.level }),
    },
  }),
  parseHTML: () => [{ tag: 'section[data-type="toggle"]' }],
  renderHTML: ({ HTMLAttributes }) => [
    'section',
    mergeAttributes(HTMLAttributes, { 'data-type': 'toggle' }),
    0,
  ],
  addNodeView() {
    return ({ node, editor, getPos }) => {
      const dom = document.createElement('section');
      dom.className = 'toggle-block';
      dom.dataset.type = 'toggle';
      dom.dataset.level = String(node.attrs.level);
      dom.dataset.open = 'false';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'toggle-disclosure';
      button.contentEditable = 'false';
      button.spellcheck = false;
      button.setAttribute('aria-label', 'Expand toggle');
      button.setAttribute('aria-expanded', 'false');
      const icon = document.createElementNS(
        'http://www.w3.org/2000/svg',
        'svg',
      );
      icon.classList.add('toggle-disclosure-icon');
      icon.setAttribute('viewBox', '0 0 24 24');
      icon.setAttribute('width', '16');
      icon.setAttribute('height', '16');
      icon.setAttribute('fill', 'none');
      icon.setAttribute('stroke', 'currentColor');
      icon.setAttribute('stroke-width', '2');
      icon.setAttribute('stroke-linecap', 'round');
      icon.setAttribute('stroke-linejoin', 'round');
      icon.setAttribute('aria-hidden', 'true');
      icon.setAttribute('focusable', 'false');
      const chevron = document.createElementNS(
        'http://www.w3.org/2000/svg',
        'path',
      );
      chevron.setAttribute('d', 'm9 6 6 6-6 6');
      icon.append(chevron);
      button.append(icon);
      const contentDOM = document.createElement('div');
      contentDOM.className = 'toggle-inner';
      button.onclick = () => {
        const open = dom.dataset.open !== 'true';
        if (!open) {
          const pos = getPos();
          if (
            typeof pos === 'number' &&
            editor.state.selection.from > pos + node.child(0).nodeSize &&
            editor.state.selection.to < pos + node.nodeSize
          ) {
            editor.commands.setTextSelection(pos + node.child(0).nodeSize);
          }
        }
        dom.dataset.open = String(open);
        button.setAttribute('aria-expanded', String(open));
        button.setAttribute(
          'aria-label',
          open ? 'Collapse toggle' : 'Expand toggle',
        );
      };
      dom.append(button, contentDOM);
      return {
        dom,
        contentDOM,
        update(next) {
          if (next.type.name !== 'toggle') return false;
          node = next;
          dom.dataset.level = String(next.attrs.level);
          return true;
        },
        stopEvent: (event) => button.contains(event.target as globalThis.Node),
        ignoreMutation: (mutation) =>
          mutation.type !== 'selection' &&
          (mutation.target === dom || button.contains(mutation.target)),
      };
    };
  },
});
export function pageReference(
  getPages: () => PageOption[],
  onpage: (id: string) => void,
) {
  return Node.create({
    name: 'pageReference',
    group: 'block',
    atom: true,
    selectable: true,
    addAttributes: () => ({
      pageId: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-page-id'),
        renderHTML: (attrs) => ({ 'data-page-id': attrs.pageId }),
      },
      title: { default: 'Untitled' },
    }),
    parseHTML: () => [{ tag: 'a[data-page-id]' }],
    renderHTML: ({ node, HTMLAttributes }) => [
      'a',
      mergeAttributes(HTMLAttributes, {
        'data-type': 'page-reference',
        href: '/p/' + encodeURIComponent(node.attrs.pageId),
      }),
      node.attrs.title,
    ],
    addNodeView() {
      return ({ node }) => {
        const dom = document.createElement('a');
        dom.className = 'page-reference';
        dom.contentEditable = 'false';
        function update(next: typeof node) {
          node = next;
          const page = getPages().find((p) => p.id === node.attrs.pageId);
          dom.dataset.pageId = node.attrs.pageId;
          dom.dataset.fallbackTitle = node.attrs.title;
          dom.href = '/p/' + encodeURIComponent(node.attrs.pageId);
          dom.textContent =
            (page?.emoji || '↗') +
            ' ' +
            (page?.title || node.attrs.title + ' (unavailable)');
        }
        update(node);
        dom.onclick = (event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey) return;
          event.preventDefault();
          if (getPages().some((p) => p.id === node.attrs.pageId))
            onpage(node.attrs.pageId);
        };
        return {
          dom,
          update(next) {
            if (next.type.name !== 'pageReference') return false;
            update(next);
            return true;
          },
          stopEvent: () => true,
          ignoreMutation: () => true,
        };
      };
    },
  });
}
