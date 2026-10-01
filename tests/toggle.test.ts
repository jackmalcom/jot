import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getSchema,
  type Command,
  type CommandProps,
  type Editor,
} from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import type { Node } from '@tiptap/pm/model';
import {
  EditorState,
  NodeSelection,
  TextSelection,
  type Transaction,
  type PluginView,
} from '@tiptap/pm/state';
import { history, redo, undo } from '@tiptap/pm/history';
import type { EditorView } from '@tiptap/pm/view';
import {
  initProseMirrorDoc,
  prosemirrorToYDoc,
  redo as yRedo,
  undo as yUndo,
  ySyncPlugin,
  yUndoPlugin,
} from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import {
  Toggle,
  ToggleBody,
  ToggleSummary,
  pageReference,
  toggleUnwrapHistory,
} from '../apps/web/src/blocks.ts';

const schema = getSchema([
  StarterKit,
  Image,
  Toggle,
  ToggleBody,
  ToggleSummary,
  pageReference(
    () => [],
    () => {},
  ),
]);
const paragraph = (text = '') =>
  schema.node('paragraph', null, text ? schema.text(text) : []);
const toggle = ({
  summary = '',
  body = [paragraph()],
  level = 0,
}: { summary?: string; body?: Node[]; level?: number } = {}) =>
  schema.node('toggle', { level }, [
    schema.node(
      'toggleSummary',
      { level },
      summary ? schema.text(summary) : [],
    ),
    schema.node('toggleBody', null, body),
  ]);

// Exercise the actual extension shortcut with real ProseMirror transactions
// and history, without requiring a DOM or a browser. Only Tiptap's command
// dispatch boundary is stubbed; key-event routing and native spellchecking
// still require the browser suite.
function harness(nodes: Node[], cursor: number, collaborative = false) {
  let doc = schema.node('doc', null, nodes);
  const ydoc = collaborative ? prosemirrorToYDoc(doc) : null;
  const fragment = ydoc?.getXmlFragment('prosemirror');
  let plugins = [history()];
  if (fragment) {
    const initial = initProseMirrorDoc(fragment, schema);
    doc = initial.doc;
    plugins = [
      ySyncPlugin(fragment, { mapping: initial.mapping }),
      yUndoPlugin(),
      toggleUnwrapHistory(),
    ];
  }
  let state = EditorState.create({ doc, plugins });
  state = state.apply(
    state.tr.setSelection(TextSelection.create(state.doc, cursor)),
  );
  let documentTransactions = 0;
  const pluginViews: PluginView[] = [];
  let shouldDispatch = true;
  function dispatch(tr: Transaction) {
    const previous = state;
    state = state.apply(tr);
    if (tr.docChanged) documentTransactions++;
    for (const pluginView of pluginViews) pluginView.update?.(view, previous);
  }
  // The real Yjs sync/history plugin lifecycle needs only state/dispatch for
  // these tests. DOM selection and keyboard routing remain browser coverage.
  const view = {
    get state() {
      return state;
    },
    hasFocus: () => false,
    dispatch,
  } as unknown as EditorView;
  for (const plugin of plugins) {
    const pluginView = plugin.spec.view?.(view);
    if (pluginView) pluginViews.push(pluginView);
  }
  const editor = {
    commands: {
      command(callback: Command) {
        const tr = state.tr;
        const handled = callback({
          state,
          tr,
          dispatch: shouldDispatch ? () => {} : undefined,
        } as CommandProps);
        if (shouldDispatch) dispatch(tr);
        else assert.equal(tr.docChanged, false, 'dry run must not mutate');
        return handled;
      },
    },
  } as unknown as Editor;
  assert.ok(ToggleSummary.config.addKeyboardShortcuts);
  const shortcuts = ToggleSummary.config.addKeyboardShortcuts.call({
    name: ToggleSummary.name,
    options: ToggleSummary.options,
    storage: ToggleSummary.storage,
    editor,
    type: schema.nodes.toggleSummary,
    parent: undefined,
  });
  return {
    get state() {
      return state;
    },
    get documentTransactions() {
      return documentTransactions;
    },
    dispatch,
    ydoc,
    fragment,
    undo: () => (ydoc ? yUndo(state) : undo(state, dispatch)),
    redo: () => (ydoc ? yRedo(state) : redo(state, dispatch)),
    destroy() {
      for (const pluginView of pluginViews.reverse()) pluginView.destroy?.();
      ydoc?.destroy();
    },
    backspace(dryRun = false) {
      shouldDispatch = !dryRun;
      try {
        return shortcuts.Backspace({ editor });
      } finally {
        shouldDispatch = true;
      }
    },
  };
}

test('Backspace converts an empty ordinary or heading toggle into a focused paragraph', () => {
  for (const level of [0, 1, 2, 3, 4, 5, 6]) {
    const h = harness([toggle({ level })], 2);
    assert.equal(h.backspace(), true);
    assert.deepEqual(h.state.doc.toJSON(), {
      type: 'doc',
      content: [{ type: 'paragraph' }],
    });
    assert.equal(h.state.selection.from, 1);
    assert.equal(h.state.selection.to, 1);
    assert.equal(h.state.selection.$from.parent.type.name, 'paragraph');
    assert.equal(h.documentTransactions, 1);
    assert.equal(
      h.backspace(),
      false,
      'further editing uses ordinary shortcuts',
    );
    assert.equal(h.documentTransactions, 1);
  }
});

test('empty toggle removal is a single undoable and redoable document transaction', () => {
  const h = harness([toggle({ level: 3 })], 2);
  const before = h.state.doc;
  h.backspace();
  const after = h.state.doc;
  assert.equal(h.documentTransactions, 1);
  assert.equal(undo(h.state, h.dispatch), true);
  assert.ok(h.state.doc.eq(before));
  assert.equal(h.state.selection.from, 2);
  assert.equal(h.state.selection.$from.parent.type.name, 'toggleSummary');
  assert.equal(redo(h.state, h.dispatch), true);
  assert.ok(h.state.doc.eq(after));
  assert.equal(h.state.selection.from, 1);
});

test('Backspace removes only an empty nested toggle and preserves its surroundings', () => {
  const inner = toggle({ level: 2 });
  const before = toggle({
    summary: 'Outer toggle',
    body: [paragraph('Before'), inner, paragraph('After')],
  });
  const doc = schema.node('doc', null, [before]);
  let innerPos: number | undefined;
  doc.descendants((node, pos) => {
    if (node === inner) innerPos = pos;
  });
  assert.notEqual(innerPos, undefined);
  const h = harness([before], innerPos! + 2);
  assert.equal(h.backspace(), true);
  assert.ok(
    h.state.doc.eq(
      schema.node('doc', null, [
        toggle({
          summary: 'Outer toggle',
          body: [paragraph('Before'), paragraph(), paragraph('After')],
        }),
      ]),
    ),
  );
  assert.equal(h.state.selection.from, innerPos! + 1);
  assert.equal(h.state.selection.$from.parent.type.name, 'paragraph');
  assert.equal(h.documentTransactions, 1);
});

test('Backspace protects body content even when it has no text', () => {
  const bodies: [string, Node[]][] = [
    ['text', [paragraph('Hidden content')]],
    ['nested toggle', [toggle()]],
    ['image', [schema.node('image', { src: '/test-image.png' })]],
    ['horizontal rule', [schema.node('horizontalRule')]],
    ['page reference', [schema.node('pageReference', { pageId: 'page-id' })]],
    ['multiple empty paragraphs', [paragraph(), paragraph()]],
    ['empty heading', [schema.node('heading', { level: 2 })]],
    ['hard break', [schema.node('paragraph', null, schema.node('hardBreak'))]],
  ];
  for (const [name, body] of bodies) {
    const h = harness([toggle({ body, level: 3 })], 2);
    const before = h.state.doc;
    assert.equal(
      h.backspace(),
      true,
      `${name}: consume native/fallback deletion`,
    );
    assert.ok(
      h.state.doc.eq(before),
      `${name}: preserve all nodes and attributes`,
    );
    assert.equal(h.state.selection.from, 2);
    assert.equal(h.documentTransactions, 0);
  }
});

test('Backspace leaves ordinary text and nonempty summaries to normal editing', () => {
  const examples: [Node, number][] = [
    [paragraph('Ordinary text'), 1],
    [paragraph('Ordinary text'), 5],
    [toggle({ summary: 'Summary' }), 2],
    [toggle({ summary: 'Summary' }), 5],
  ];
  for (const [node, cursor] of examples) {
    const h = harness([node], cursor);
    const before = h.state.doc;
    assert.equal(h.backspace(), false);
    assert.ok(h.state.doc.eq(before));
    assert.equal(h.documentTransactions, 0);
  }
});

test('Backspace does not intercept node or text-range selections', () => {
  const selectedNode = harness([toggle()], 2);
  selectedNode.dispatch(
    selectedNode.state.tr.setSelection(
      NodeSelection.create(selectedNode.state.doc, 0),
    ),
  );
  assert.equal(selectedNode.backspace(), false);
  assert.equal(selectedNode.documentTransactions, 0);

  const selectedText = harness([toggle({ summary: 'Summary' })], 2);
  selectedText.dispatch(
    selectedText.state.tr.setSelection(
      TextSelection.create(selectedText.state.doc, 2, 5),
    ),
  );
  assert.equal(selectedText.backspace(), false);
  assert.equal(selectedText.documentTransactions, 0);
});

test('checking whether empty-toggle Backspace can run does not mutate the document', () => {
  const h = harness([toggle()], 2);
  const before = h.state.doc;
  assert.equal(h.backspace(true), true);
  assert.ok(h.state.doc.eq(before));
  assert.equal(h.state.selection.from, 2);
  assert.equal(h.documentTransactions, 0);
});

test('Yjs undo and redo preserve the nested toggle caret through repeated cycles', () => {
  for (const level of [0, 2, 6]) {
    const inner = toggle({ level });
    const outer = toggle({ summary: 'Outer summary', body: [inner] });
    const innerPos = 2 + outer.firstChild!.nodeSize;
    const h = harness([outer, paragraph()], innerPos + 2, true);
    try {
      const before = h.state.doc;
      assert.equal(h.backspace(), true);
      const after = h.state.doc;
      assert.equal(h.state.selection.from, innerPos + 1);
      for (let cycle = 0; cycle < 3; cycle++) {
        assert.equal(h.undo(), true);
        assert.ok(h.state.doc.eq(before));
        assert.equal(h.state.selection.from, innerPos + 2);
        assert.equal(h.state.selection.$from.parent.type.name, 'toggleSummary');
        assert.equal(h.redo(), true);
        assert.ok(h.state.doc.eq(after));
        assert.equal(h.state.selection.from, innerPos + 1);
        assert.equal(h.state.selection.$from.parent.type.name, 'paragraph');
        assert.equal(h.state.selection.$from.depth, 3);
      }
    } finally {
      h.destroy();
    }
  }
});

test('Yjs toggle history follows collaborative edits before the nested replacement', () => {
  const inner = toggle({ level: 2 });
  const outer = toggle({
    summary: 'Outer summary',
    body: [paragraph('Before'), inner],
  });
  const innerPos =
    2 + outer.firstChild!.nodeSize + outer.lastChild!.firstChild!.nodeSize;
  const h = harness([outer, paragraph()], innerPos + 2, true);
  try {
    assert.equal(h.backspace(), true);
    const summary = (h.fragment!.get(0) as Y.XmlElement).get(0) as Y.XmlElement;
    const text = summary.get(0) as Y.XmlText;
    h.ydoc!.transact(() => text.insert(0, 'Remote '), 'remote');
    assert.equal(h.undo(), true);
    assert.equal(h.state.selection.from, innerPos + 2 + 'Remote '.length);
    assert.equal(h.state.selection.$from.parent.type.name, 'toggleSummary');
    assert.equal(h.redo(), true);
    assert.equal(h.state.selection.from, innerPos + 1 + 'Remote '.length);
    assert.equal(h.state.selection.$from.depth, 3);
    assert.equal(
      h.state.doc.firstChild!.firstChild!.textContent,
      'Remote Outer summary',
    );
  } finally {
    h.destroy();
  }
});

test('Yjs empty-toggle unwrapping is separate from adjacent character edits', () => {
  const inner = toggle({ summary: 'A' });
  const outer = toggle({ summary: 'Outer summary', body: [inner] });
  const innerPos = 2 + outer.firstChild!.nodeSize;
  const h = harness([outer, paragraph()], innerPos + 3, true);
  try {
    h.dispatch(h.state.tr.delete(innerPos + 2, innerPos + 3));
    const emptyToggle = h.state.doc;
    assert.equal(h.backspace(), true);
    const replacement = h.state.doc;
    h.dispatch(h.state.tr.insertText('Replacement'));
    assert.equal(h.undo(), true);
    assert.ok(h.state.doc.eq(replacement), 'undo only the following typing');
    assert.equal(h.undo(), true);
    assert.ok(h.state.doc.eq(emptyToggle), 'undo only the toggle unwrap');
    assert.equal(h.state.selection.from, innerPos + 2);
    assert.equal(h.undo(), true);
    assert.equal(
      h.state.doc.firstChild!.lastChild!.firstChild!.firstChild!.textContent,
      'A',
    );
  } finally {
    h.destroy();
  }
});
