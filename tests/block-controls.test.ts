import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import * as Y from 'yjs';
import {
  initProseMirrorDoc,
  prosemirrorToYDoc,
  ySyncPluginKey,
} from '@tiptap/y-tiptap';
import {
  EditorState,
  NodeSelection,
  TextSelection,
  Plugin,
} from '@tiptap/pm/state';
import {
  blockHandleAnchor,
  blockHandleTarget,
} from '../apps/web/src/block-controls.ts';

const schema = getSchema([StarterKit, Image]);
const paragraph = (text: string) =>
  schema.node('paragraph', null, schema.text(text));
const first = paragraph('First paragraph');
const second = paragraph('Hovered paragraph');
const secondPos = first.nodeSize;
function state() {
  const doc = schema.node('doc', null, [first, second]);
  return EditorState.create({ doc, selection: TextSelection.create(doc, 1) });
}

test('awareness metadata transactions retain a hovered later block rather than the caret block', () => {
  const tr = state().tr.setMeta('updateDecorations', true);
  assert.equal(tr.docChanged, false);
  assert.equal(
    blockHandleTarget(
      tr,
      blockHandleAnchor(state(), secondPos),
      true,
      state().apply(tr),
    ),
    secondPos,
  );
});

test('collaborative edits map the hovered or open-menu block to its new position', () => {
  const tr = state().tr.insertText('Remote ', 1);
  const mappedPos = blockHandleTarget(
    tr,
    blockHandleAnchor(state(), secondPos),
    true,
    state().apply(tr),
  );
  assert.equal(mappedPos, secondPos + 'Remote '.length);
  assert.equal(tr.doc.nodeAt(mappedPos!)?.textContent, 'Hovered paragraph');
});

test('deleting the pinned block clears its action target rather than targeting its neighbor', () => {
  const tr = state().tr.delete(secondPos, secondPos + second.nodeSize);
  assert.equal(
    blockHandleTarget(
      tr,
      blockHandleAnchor(state(), secondPos),
      true,
      state().apply(tr),
    ),
    null,
  );
});

test('leaving hover or intentionally moving the caret restores selection-based targeting', () => {
  const initial = state();
  assert.equal(
    blockHandleTarget(
      initial.tr,
      blockHandleAnchor(initial, secondPos),
      false,
      initial,
    ),
    0,
  );
  const tr = initial.tr.setSelection(
    TextSelection.create(initial.doc, secondPos + 1),
  );
  assert.equal(
    blockHandleTarget(
      tr,
      blockHandleAnchor(initial, 0),
      false,
      initial.apply(tr),
    ),
    secondPos,
  );
  assert.equal(blockHandleTarget(tr, null, true, initial.apply(tr)), secondPos);
});

test('node selections keep their exact block target', () => {
  const initial = state();
  const tr = initial.tr.setSelection(
    NodeSelection.create(initial.doc, secondPos),
  );
  assert.equal(
    blockHandleTarget(
      tr,
      blockHandleAnchor(initial, 0),
      false,
      initial.apply(tr),
    ),
    secondPos,
  );
});

function collaborative(
  nodes = [first, second, paragraph('Hovered paragraph')],
) {
  const ydoc = prosemirrorToYDoc(schema.node('doc', null, nodes));
  const type = ydoc.getXmlFragment('prosemirror');
  function snapshot() {
    const { doc, mapping } = initProseMirrorDoc(type, schema);
    return EditorState.create({
      doc,
      plugins: [
        new Plugin({
          key: ySyncPluginKey,
          state: {
            init: () => ({ doc: ydoc, type, binding: { mapping } }),
            apply: (_, previous) => previous,
          },
        }),
      ],
    });
  }
  return { ydoc, type, snapshot };
}

// y-tiptap replaces the entire ProseMirror document for a remote update.
// Real Y element identities must survive that replacement; ordinary PM
// step mappings mark even surviving interior blocks as deleted.
function remoteTransaction(before: EditorState, after: EditorState) {
  return before.tr
    .replaceWith(0, before.doc.content.size, after.doc.content)
    .setMeta(ySyncPluginKey, { isChangeOrigin: true });
}

test('real Yjs identities retain a hovered block through full-document remote replacement', () => {
  const fixture = collaborative();
  try {
    const before = fixture.snapshot();
    const anchor = blockHandleAnchor(before, secondPos);
    assert.ok(anchor?.relative);
    const text = (fixture.type.get(0) as Y.XmlElement).get(0) as Y.XmlText;
    text.insert(0, 'Remote ');
    const after = fixture.snapshot();
    const tr = remoteTransaction(before, after);
    assert.equal(tr.mapping.mapResult(secondPos).deleted, true);
    assert.equal(blockHandleTarget(tr, anchor, true, after), secondPos + 7);
  } finally {
    fixture.ydoc.destroy();
  }
});

test('remote deletion clears a hovered or open-menu target instead of selecting an identical next block', () => {
  const fixture = collaborative();
  try {
    const before = fixture.snapshot();
    const anchor = blockHandleAnchor(before, secondPos);
    fixture.type.delete(1, 1);
    const after = fixture.snapshot();
    assert.equal(after.doc.nodeAt(secondPos)?.textContent, 'Hovered paragraph');
    assert.equal(
      blockHandleTarget(remoteTransaction(before, after), anchor, true, after),
      null,
    );
  } finally {
    fixture.ydoc.destroy();
  }
});

test('Y element anchors preserve leaf images and reject a deleted image beside an identical image', () => {
  const image = schema.node('image', { src: '/test.png' });
  const fixture = collaborative([first, image, image]);
  try {
    const before = fixture.snapshot();
    const anchor = blockHandleAnchor(before, secondPos);
    assert.ok(anchor?.relative);
    const text = (fixture.type.get(0) as Y.XmlElement).get(0) as Y.XmlText;
    text.insert(0, 'Remote ');
    const moved = fixture.snapshot();
    assert.equal(
      blockHandleTarget(remoteTransaction(before, moved), anchor, true, moved),
      secondPos + 7,
    );
    fixture.type.delete(1, 1);
    const after = fixture.snapshot();
    assert.equal(after.doc.nodeAt(secondPos + 7)?.type.name, 'image');
    assert.equal(
      blockHandleTarget(remoteTransaction(moved, after), anchor, true, after),
      null,
    );
  } finally {
    fixture.ydoc.destroy();
  }
});

test('selection targeting uses the final state after appended transactions', () => {
  const initial = state();
  const tr = initial.tr.setMeta('updateDecorations', true);
  const intermediate = initial.apply(tr);
  const final = intermediate.apply(
    intermediate.tr.setSelection(
      TextSelection.create(intermediate.doc, secondPos + 1),
    ),
  );
  assert.equal(
    blockHandleTarget(tr, blockHandleAnchor(initial, 0), false, final),
    secondPos,
  );
});
