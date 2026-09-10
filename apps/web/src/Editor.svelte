<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { Editor } from '@tiptap/core';
  import Image from '@tiptap/extension-image';
  import { DOMSerializer, Fragment } from '@tiptap/pm/model';
  import { NodeSelection, type SelectionBookmark } from '@tiptap/pm/state';
  import {
    Toggle,
    ToggleSummary,
    ToggleBody,
    pageReference,
    type PageOption,
  } from './blocks';
  import StarterKit from '@tiptap/starter-kit';
  import Collaboration from '@tiptap/extension-collaboration';
  import CollaborationCaret from '@tiptap/extension-collaboration-caret';
  import TaskList from '@tiptap/extension-task-list';
  import TaskItem from '@tiptap/extension-task-item';
  import Placeholder from '@tiptap/extension-placeholder';
  import { yUndoPluginKey } from '@tiptap/y-tiptap';
  import { TextSelection } from '@tiptap/pm/state';
  import {
    GripVertical,
    Copy,
    ImageIcon,
    FileText,
    Heading,
    ChevronsRight,
    Bold,
    Italic,
    Link,
    List,
    ListOrdered,
    ListTodo,
    Type,
    ArrowUp,
    ArrowDown,
    Plus,
    Trash2,
    Undo2,
    Redo2,
    ChevronRight,
    ChevronLeft,
  } from '@lucide/svelte';
  import { PageSync } from './sync';
  let {
    pageId,
    user,
    onmessage,
    isDeleted = false,
    pages,
    onpage,
  }: {
    pageId: string;
    pages: PageOption[];
    onpage: (id: string) => void;
    isDeleted?: boolean;
    user: { id: string; name: string };
    onmessage: (message: any) => void;
  } = $props();
  let host: HTMLDivElement;
  let editor = $state<Editor>();
  let sync = $state<PageSync>();
  let revision = $state(0);
  let slash = $state(false);
  let slashStart = 0;
  let slashEnd = 0;
  let slashQuery = $state('');
  let slashIndex = $state(0);
  let dismissedSlash = '';
  let slashX = $state(0);
  let slashY = $state(0);
  let focused = $state(false);
  let keyboardBottom = $state(0);
  let wrap: HTMLDivElement;
  let blockPos = $state<number | null>(null);
  let blockTop = $state(0);
  let blockMenu = $state(false);
  let blockMenuAbove = $state(false);
  let insertForm = $state<'image' | 'page' | null>(null);
  let imageURL = $state('');
  let imageAlt = $state('');
  let pageQuery = $state('');
  let uploading = $state(false);
  let insertBookmark: SelectionBookmark | null = null;
  let copied = $state(false);

  let ready = $state(false);
  let failed = $state('');
  let deleted = $state(false);
  let people = $state<{ name: string; color: string }[]>([]);
  let linkDialog = $state(false);
  let linkBookmark: SelectionBookmark | null = null;
  let linkValue = $state('');
  const blockTypes = [
    { name: 'Text', type: 'paragraph', icon: Type, aliases: 'text paragraph' },
    {
      name: 'Bullet list',
      type: 'bulletList',
      icon: List,
      aliases: 'bullet unordered list',
    },
    {
      name: 'Numbered list',
      type: 'orderedList',
      icon: ListOrdered,
      aliases: 'number ordered list',
    },
    {
      name: 'To-do list',
      type: 'taskList',
      icon: ListTodo,
      aliases: 'todo task checkbox check list',
    },
    {
      name: 'Image',
      type: 'image',
      icon: ImageIcon,
      aliases: 'image photo picture',
    },
    {
      name: 'Page link',
      type: 'page',
      icon: FileText,
      aliases: 'page link reference',
    },
    {
      name: 'Toggle',
      type: 'toggle',
      icon: ChevronRight,
      aliases: 'toggle collapse',
    },
    ...[1, 2, 3, 4, 5, 6].map((level) => ({
      name: 'Heading ' + level,
      type: 'h' + level,
      icon: Heading,
      aliases: 'heading ' + level + ' h' + level,
    })),
    ...[1, 2, 3, 4, 5, 6].map((level) => ({
      name: 'Heading toggle ' + level,
      type: 'toggle' + level,
      icon: ChevronsRight,
      aliases:
        'heading toggle ' +
        level +
        ' toggle heading ' +
        level +
        ' toggleh' +
        level,
    })),
  ];
  const filteredBlocks = $derived(
    blockTypes.filter((item) =>
      (item.name + ' ' + item.aliases)
        .toLowerCase()
        .replaceAll('-', '')
        .includes(slashQuery.toLowerCase().replaceAll('-', '')),
    ),
  );
  const matchingPages = $derived(
    pages.filter((page) =>
      page.title.toLowerCase().includes(pageQuery.toLowerCase()),
    ),
  );
  function updateViewport() {
    const vp = window.visualViewport;
    keyboardBottom = vp
      ? Math.max(0, innerHeight - vp.height - vp.offsetTop)
      : 0;
    positionSlash();
  }
  function positionSlash() {
    if (!editor || !slash) return;
    const bounds = editor.view.coordsAtPos(editor.state.selection.from);
    const vp = window.visualViewport;
    const bottom = (vp?.height || innerHeight) + (vp?.offsetTop || 0) - 60;
    const height = Math.min(280, filteredBlocks.length * 42 + 16);
    slashX = Math.max(8, Math.min(bounds.left, innerWidth - 268));
    slashY = Math.max(
      (vp?.offsetTop || 0) + 8,
      bounds.bottom + height > bottom
        ? bounds.top - height - 6
        : bounds.bottom + 6,
    );
  }
  function selectedBlock(instance: Editor) {
    const selection = instance.state.selection;
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
  function positionHandle(pos: number | null) {
    if (!editor || pos == null) return;
    const dom = editor.view.nodeDOM(pos);
    if (dom instanceof HTMLElement) {
      blockPos = pos;
      blockTop =
        dom.getBoundingClientRect().top - wrap.getBoundingClientRect().top;
    }
  }
  function hoverBlock(event: PointerEvent) {
    if (!editor || blockMenu || event.pointerType === 'touch') return;
    const element = event.target instanceof Element ? event.target : null;
    let node = element?.closest(
      '.tiptap > *, li, .toggle-block, .toggle-body > *',
    );
    if (!node || !host.contains(node)) return;
    const pos = editor.view.posAtDOM(node, 0);
    const resolved = editor.state.doc.resolve(pos);
    if (resolved.depth && resolved.parent.type.name !== 'doc')
      positionHandle(resolved.before());
    else positionHandle(pos);
  }
  onMount(() => {
    let cancelled = false;
    const viewport = window.visualViewport;
    viewport?.addEventListener('resize', updateViewport);
    viewport?.addEventListener('scroll', updateViewport);
    window.addEventListener('resize', updateViewport);
    updateViewport();
    const outside = (event: PointerEvent) => {
      if (
        !(event.target instanceof Element) ||
        !event.target.closest('.block-actions, .block-handle')
      )
        blockMenu = false;
    };
    document.addEventListener('pointerdown', outside);
    const dismissForm = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && insertForm && !uploading) {
        event.preventDefault();
        cancelInsert();
      } else if (event.key === 'Escape' && linkDialog) {
        event.preventDefault();
        linkDialog = false;
        editor?.commands.focus();
      }
    };
    document.addEventListener('keydown', dismissForm);

    const provider = (sync = new PageSync(pageId, user.id, (msg) => {
      if (msg.type === 'deleted') {
        deleted = true;
        editor?.setEditable(false);
      }
      onmessage(msg);
    }));
    provider.awareness.on('change', () => {
      people = [...provider.awareness.getStates().entries()]
        .filter(([id]) => id !== provider.doc.clientID)
        .map(([, state]) => state.user)
        .filter(Boolean);
    });
    void (async () => {
      try {
        await provider.persistence.whenSynced;
        if (cancelled) return;
        editor = new Editor({
          element: host,
          extensions: [
            StarterKit.configure({
              undoRedo: false,
              heading: { levels: [1, 2, 3, 4, 5, 6] },
              codeBlock: false,
              blockquote: false,
              horizontalRule: false,
              code: false,
              strike: false,
              link: { openOnClick: false, autolink: true },
            }),
            Image.configure({ allowBase64: false }),
            Toggle,
            ToggleSummary,
            ToggleBody,
            pageReference(() => pages, onpage),
            TaskList,
            TaskItem.configure({
              nested: true,
              HTMLAttributes: { 'data-type': 'taskItem' },
            }),
            Collaboration.configure({ document: provider.doc }),
            CollaborationCaret.configure({
              provider,
              user: { name: user.name, color: '#4263eb' },
            }),
            Placeholder.configure({
              placeholder: 'Write something, or type / for blocks…',
            }),
          ],
          editorProps: {
            attributes: {
              'aria-label': 'Page content',
              role: 'textbox',
              'aria-multiline': 'true',
              spellcheck: 'true',
            },
            handleKeyDown: (_, event) => {
              if (event.isComposing) return false;
              if (
                (event.ctrlKey || event.metaKey) &&
                event.key.toLowerCase() === 'k'
              ) {
                openLink();
                slash = false;
                void tick().then(() =>
                  wrap
                    .querySelector<HTMLInputElement>('.link-form input')
                    ?.focus(),
                );
                return true;
              }
              if (slash && filteredBlocks.length) {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  slashIndex =
                    (slashIndex +
                      (event.key === 'ArrowDown' ? 1 : -1) +
                      filteredBlocks.length) %
                    filteredBlocks.length;
                  void tick().then(() =>
                    wrap
                      .querySelector('.slash-menu button.active')
                      ?.scrollIntoView({ block: 'nearest' }),
                  );
                  return true;
                }
                if (event.key === 'Enter') {
                  block(
                    filteredBlocks[
                      Math.min(slashIndex, filteredBlocks.length - 1)
                    ].type,
                  );
                  return true;
                }
              }
              if (event.key === 'Escape') {
                if (slash) {
                  dismissedSlash = slashStart + ':' + slashQuery;
                  slash = false;
                  return true;
                }
                blockMenu = false;
              }
              if (
                event.key === 'Tab' &&
                (editor?.isActive('listItem') || editor?.isActive('taskItem'))
              ) {
                indent(event.shiftKey);
                return true;
              }
              if (
                (event.ctrlKey || event.metaKey) &&
                event.shiftKey &&
                ['ArrowUp', 'ArrowDown'].includes(event.key)
              ) {
                move(event.key === 'ArrowUp' ? -1 : 1);
                return true;
              }
              return false;
            },
            handlePaste: (_, event) => {
              const file = Array.from(event.clipboardData?.files || []).find(
                (file) => file.type.startsWith('image/'),
              );
              if (!file) return false;
              insertBookmark = editor!.state.selection.getBookmark();
              void uploadImage(file);
              return true;
            },
          },
          onFocus: () => {
            focused = true;
          },
          onBlur: () => {
            setTimeout(() => {
              focused = !!wrap?.contains(document.activeElement);
            }, 0);
          },
          onTransaction: ({ editor: instance, transaction }) => {
            revision++;
            if (insertBookmark)
              insertBookmark = insertBookmark.map(transaction.mapping);
            if (linkBookmark)
              linkBookmark = linkBookmark.map(transaction.mapping);
            if (blockMenu && blockPos != null) {
              const mapped = transaction.mapping.mapResult(blockPos);
              if (mapped.deleted) {
                blockMenu = false;
                blockPos = null;
              } else positionHandle(mapped.pos);
            } else positionHandle(selectedBlock(instance));
            const fromPos = instance.state.selection.$from;
            const text = fromPos.parent.isTextblock
              ? fromPos.parent.textBetween(0, fromPos.parentOffset, '\n')
              : '';
            const match = text.match(/(?:^|\s)\/([a-z0-9 -]*)$/i);
            if (match && instance.state.selection.empty && !insertForm) {
              const query = match[1];
              const start = fromPos.pos - query.length - 1;
              if (query !== slashQuery || start !== slashStart) slashIndex = 0;
              slashStart = start;
              slashEnd = fromPos.pos;
              slashQuery = query;
              slash = dismissedSlash !== start + ':' + query;
              void tick().then(positionSlash);
            } else {
              slash = false;
              dismissedSlash = '';
            }
          },
        });
        ready = true;
        provider.deleted = isDeleted;
        deleted = isDeleted;
        editor.setEditable(!deleted);
        await provider.start();
      } catch (error) {
        console.error('Editor initialization failed', error);
        failed =
          'The editor could not start. Reload the page; your saved notes are safe.';
      }
    })();
    return () => {
      cancelled = true;
      viewport?.removeEventListener('resize', updateViewport);
      viewport?.removeEventListener('scroll', updateViewport);
      window.removeEventListener('resize', updateViewport);
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', dismissForm);
      editor?.destroy();
      void provider.destroy();
    };
  });
  $effect(() => {
    if (sync && ready) {
      deleted = isDeleted;
      editor?.setEditable(!deleted);
      if (deleted) {
        sync.deleted = true;
        sync.ws?.close();
      } else if (sync.deleted) {
        sync.deleted = false;
        sync.connect();
      }
    }
  });
  function stopCapture() {
    if (editor)
      yUndoPluginKey.getState(editor.state)?.undoManager.stopCapturing();
  }
  function block(type: string) {
    if (!editor) return;
    stopCapture();
    let chain = editor.chain().focus();
    if (slash) chain = chain.deleteRange({ from: slashStart, to: slashEnd });
    slash = false;
    chain.run();
    if (type === 'image' || type === 'page') {
      insertForm = type;
      imageURL = '';
      imageAlt = '';
      pageQuery = '';
      insertBookmark = editor.state.selection.getBookmark();
      void tick().then(() =>
        wrap.querySelector<HTMLInputElement>('.insert-form input')?.focus(),
      );
      return;
    }
    chain = editor.chain().focus();
    if (type === 'paragraph') chain.clearNodes().setParagraph().run();
    else if (type === 'bulletList') chain.toggleBulletList().run();
    else if (type === 'orderedList') chain.toggleOrderedList().run();
    else if (type === 'taskList') chain.toggleTaskList().run();
    else if (/^h[1-6]$/.test(type))
      chain
        .setHeading({ level: Number(type[1]) as 1 | 2 | 3 | 4 | 5 | 6 })
        .run();
    else if (type.startsWith('toggle')) {
      chain
        .insertContent({
          type: 'toggle',
          attrs: { level: Number(type.slice(6)) || 0 },
          content: [
            {
              type: 'toggleSummary',
              attrs: { level: Number(type.slice(6)) || 0 },
            },
            { type: 'toggleBody', content: [{ type: 'paragraph' }] },
          ],
        })
        .run();
      // Start writing the summary, while the body remains collapsed.
      const toggleFrom = editor.state.selection.$from;
      for (let depth = toggleFrom.depth; depth > 0; depth--) {
        if (toggleFrom.node(depth).type.name === 'toggle') {
          editor.commands.setTextSelection(toggleFrom.before(depth) + 2);
          break;
        }
      }
    }
    slash = false;
    stopCapture();
  }
  function insertNode(node: { type: string; attrs: Record<string, unknown> }) {
    if (!editor || editor.isDestroyed) return;
    if (insertBookmark)
      editor.view.dispatch(
        editor.state.tr.setSelection(insertBookmark.resolve(editor.state.doc)),
      );
    editor
      .chain()
      .focus()
      .insertContent([node, { type: 'paragraph' }])
      .run();
    insertForm = null;
    insertBookmark = null;
    failed = '';
    stopCapture();
  }
  function insertImageURL() {
    if (!/^https?:\/\//i.test(imageURL.trim())) {
      failed = 'Use an http:// or https:// image URL.';
      return;
    }
    insertNode({
      type: 'image',
      attrs: { src: imageURL.trim(), alt: imageAlt.trim() },
    });
  }
  async function uploadImage(file: File) {
    if (uploading) return;
    uploading = true;
    failed = '';
    try {
      if (file.size > 5_000_000)
        throw new Error('Images must be 5 MB or smaller.');
      const response = await fetch('/api/images', {
        method: 'POST',
        headers: { 'content-type': file.type },
        body: file,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message);
      insertNode({
        type: 'image',
        attrs: { src: result.src, alt: imageAlt || file.name },
      });
    } catch (error) {
      failed = (error as Error).message;
    } finally {
      uploading = false;
    }
  }
  function cancelInsert() {
    insertForm = null;
    insertBookmark = null;
    failed = '';
    editor?.commands.focus();
  }
  function toggleBlockMenu() {
    blockMenu = !blockMenu;
    if (blockMenu) {
      const viewport = window.visualViewport;
      const bottom =
        (viewport?.height || innerHeight) + (viewport?.offsetTop || 0);
      blockMenuAbove =
        wrap.getBoundingClientRect().top + blockTop + 118 > bottom - 60;
    }
  }
  function copyBlock() {
    if (!editor || blockPos == null) return;
    const node = editor.state.doc.nodeAt(blockPos);
    if (!node) return;
    const container = document.createElement('div');
    container.append(
      DOMSerializer.fromSchema(editor.schema).serializeFragment(
        Fragment.from(node),
      ),
    );
    const text =
      node.textContent ||
      node.attrs.alt ||
      node.attrs.title ||
      node.attrs.src ||
      '';
    const html = container.innerHTML;
    const fallback = () => {
      const listener = (event: ClipboardEvent) => {
        event.preventDefault();
        event.clipboardData?.setData('text/plain', text);
        event.clipboardData?.setData('text/html', html);
      };
      document.addEventListener('copy', listener);
      const result = document.execCommand('copy');
      document.removeEventListener('copy', listener);
      if (!result)
        throw new Error(
          'Copy failed. Select the block and copy it with your keyboard.',
        );
    };
    void (async () => {
      try {
        if (
          navigator.clipboard?.write &&
          typeof ClipboardItem !== 'undefined'
        ) {
          await navigator.clipboard
            .write([
              new ClipboardItem({
                'text/plain': new Blob([text], { type: 'text/plain' }),
                'text/html': new Blob([html], { type: 'text/html' }),
              }),
            ])
            .catch(fallback);
        } else fallback();
        blockMenu = false;
        copied = true;
        setTimeout(() => {
          copied = false;
        }, 1500);
      } catch (error) {
        failed = (error as Error).message;
      }
    })();
  }
  function move(direction: number) {
    if (!editor) return;
    const { state, view } = editor;
    const fromPos = state.selection.$from;
    let depth = fromPos.depth;
    while (
      depth > 1 &&
      !['listItem', 'taskItem'].includes(fromPos.node(depth).type.name)
    )
      depth--;
    if (depth < 1) return;
    const parent = fromPos.node(depth - 1),
      index = fromPos.index(depth - 1),
      target = index + direction;
    if (target < 0 || target >= parent.childCount) return;
    const node = fromPos.node(depth),
      from = fromPos.before(depth),
      neighbor = parent.child(target);
    const tr = state.tr.delete(from, from + node.nodeSize);
    const insertAt =
      direction < 0 ? from - neighbor.nodeSize : from + neighbor.nodeSize;
    tr.insert(insertAt, node);
    tr.setSelection(TextSelection.near(tr.doc.resolve(insertAt + 1)));
    stopCapture();
    view.dispatch(tr);
    stopCapture();
    view.focus();
  }
  function removeBlock() {
    if (!editor || blockPos == null) return;
    const node = editor.state.doc.nodeAt(blockPos);
    if (!node) return;
    const pos = blockPos;
    blockMenu = false;
    stopCapture();
    editor
      .chain()
      .focus()
      .deleteRange({ from: pos, to: pos + node.nodeSize })
      .run();
    stopCapture();
  }
  function indent(out = false) {
    if (!editor) return;
    const type = editor.isActive('taskItem') ? 'taskItem' : 'listItem';
    const chain = editor.chain().focus();
    if (out) chain.liftListItem(type).run();
    else chain.sinkListItem(type).run();
  }
  function openLink() {
    if (!editor) return;
    const selection = window.getSelection();
    if (
      selection?.anchorNode && selection.focusNode &&
      editor.view.dom.contains(selection.anchorNode) &&
      editor.view.dom.contains(selection.focusNode)
    ) {
      editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(
        editor.state.doc,
        editor.view.posAtDOM(selection.anchorNode, selection.anchorOffset),
        editor.view.posAtDOM(selection.focusNode, selection.focusOffset),
      )));
    }
    linkBookmark = editor.state.selection.getBookmark();
    linkValue = editor.getAttributes('link').href || '';
    linkDialog = true;
  }
  function saveLink() {
    if (!editor) return;
    if (linkBookmark)
      editor.view.dispatch(
        editor.state.tr.setSelection(linkBookmark.resolve(editor.state.doc)),
      );
    const value = linkValue.trim();
    if (!value)
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
    else if (/^(https?:\/\/|mailto:)/i.test(value))
      editor
        .chain()
        .focus()
        .extendMarkRange('link')
        .setLink({ href: value })
        .run();
    else {
      failed = 'Links must start with https://, http://, or mailto:.';
      return;
    }
    failed = '';
    linkDialog = false;
    linkBookmark = null;
  }
  $effect(() => {
    const currentPages = pages;
    if (!ready) return;
    host
      .querySelectorAll<HTMLAnchorElement>('.page-reference')
      .forEach((link) => {
        const page = currentPages.find(
          (page) => page.id === link.dataset.pageId,
        );
        link.textContent =
          (page?.emoji || '↗') +
          ' ' +
          (page?.title || link.dataset.fallbackTitle + ' (unavailable)');
      });
  });
  export function recoveryText() {
    return editor?.getText() || '';
  }
</script>

<div class="editor-wrap" class:editor-focused={focused} bind:this={wrap}>
  {#if people.length}<div class="collaborators" aria-label="Other editors">
      {#each people as person}<span style={`--person-color:${person.color}`}
          ><i></i>{person.name}</span
        >{/each}
    </div>{/if}
  {#if deleted}<div class="notice">
      This page was moved to trash. Your local content is still here. <button
        onclick={() => {
          navigator.clipboard
            .writeText(editor?.getText() || '')
            .then(() => onmessage({ type: 'info', message: 'Content copied.' }))
            .catch(() =>
              onmessage({
                type: 'error',
                message: 'Select and copy the content below.',
              }),
            );
        }}>Copy content</button
      >
    </div>{/if}
  {#if failed}<div class="notice error" role="alert">{failed}</div>{/if}
  <div
    class="format-bar"
    class:visible={focused && ready && !deleted}
    style={`bottom:${keyboardBottom}px`}
    tabindex="-1"
    onpointerdown={(event) => {
      stopCapture();
      if (!(event.target instanceof HTMLSelectElement)) event.preventDefault();
    }}
    role="toolbar"
    aria-label="Formatting"
    data-revision={revision}
  >
    <select
      aria-label="Block type"
      disabled={!ready || deleted}
      value={editor?.isActive('taskList')
        ? 'taskList'
        : editor?.isActive('bulletList')
          ? 'bulletList'
          : editor?.isActive('orderedList')
            ? 'orderedList'
            : editor?.isActive('heading')
              ? 'h' + editor.getAttributes('heading').level
              : 'paragraph'}
      onchange={(e) => block(e.currentTarget.value)}
      >{#each blockTypes as item}<option value={item.type}>{item.name}</option
        >{/each}</select
    >
    <span class="separator"></span>
    <button
      aria-label="Bold"
      class:active={editor?.isActive('bold')}
      disabled={!ready || deleted}
      onclick={() => editor?.chain().focus().toggleBold().run()}
      ><Bold size={17} /></button
    >
    <button
      aria-label="Italic"
      class:active={editor?.isActive('italic')}
      disabled={!ready || deleted}
      onclick={() => editor?.chain().focus().toggleItalic().run()}
      ><Italic size={17} /></button
    >
    <button
      aria-label="Add link"
      disabled={!ready || deleted}
      onclick={openLink}><Link size={17} /></button
    >
    <span class="separator"></span>
    <button
      aria-label="Indent list item"
      disabled={!ready || deleted}
      onclick={() => indent()}><ChevronRight size={17} /></button
    ><button
      aria-label="Outdent list item"
      disabled={!ready || deleted}
      onclick={() => indent(true)}><ChevronLeft size={17} /></button
    >
    <span class="separator"></span><button
      aria-label="Undo"
      disabled={!ready || deleted}
      onclick={() => editor?.chain().focus().undo().run()}
      ><Undo2 size={17} /></button
    ><button
      aria-label="Redo"
      disabled={!ready || deleted}
      onclick={() => editor?.chain().focus().redo().run()}
      ><Redo2 size={17} /></button
    >
  </div>
  {#if linkDialog}<form
      class="link-form"
      onsubmit={(e) => {
        e.preventDefault();
        saveLink();
      }}
    >
      <input
        aria-label="Link URL"
        placeholder="https://…"
        bind:value={linkValue}
      /><button class="primary" type="submit">Apply</button><button
        type="button"
        onclick={() => (linkDialog = false)}>Cancel</button
      >
    </form>{/if}
  {#if insertForm}
    <form
      class="insert-form"
      aria-label={insertForm === 'image' ? 'Insert image' : 'Insert page link'}
      onsubmit={(event) => {
        event.preventDefault();
        if (insertForm === 'image') insertImageURL();
      }}
    >
      {#if insertForm === 'image'}
        <input
          aria-label="Image URL"
          type="url"
          placeholder="Image URL"
          bind:value={imageURL}
          disabled={uploading}
        />
        <input
          aria-label="Image description"
          placeholder="Description (optional)"
          bind:value={imageAlt}
          disabled={uploading}
        />
        <div class="insert-actions">
          <label class="image-upload"
            >Upload<input
              aria-label="Upload image"
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              disabled={uploading}
              onchange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (file) void uploadImage(file);
              }}
            /></label
          >
          <button type="submit" disabled={uploading || !imageURL.trim()}
            >Insert</button
          >
          <button type="button" disabled={uploading} onclick={cancelInsert}
            >Cancel</button
          >
        </div>
        {#if uploading}<span role="status">Uploading…</span>{/if}
      {:else}
        <input
          aria-label="Find page to link"
          placeholder="Find a page…"
          bind:value={pageQuery}
        />
        <div class="page-link-options">
          {#each matchingPages as page}
            <button
              type="button"
              onclick={() =>
                insertNode({
                  type: 'pageReference',
                  attrs: { pageId: page.id, title: page.title },
                })}>{page.emoji || '↗'} {page.title}</button
            >
          {/each}
          {#if !matchingPages.length}<span class="muted">No pages found.</span
            >{/if}
        </div>
        <button type="button" onclick={cancelInsert}>Cancel</button>
      {/if}
    </form>
  {/if}
  <div
    class="editor-content"
    bind:this={host}
    onpointermove={hoverBlock}
    role="presentation"
  ></div>
  {#if ready && !deleted && blockPos != null}
    <button
      class="block-handle"
      class:menu-open={blockMenu}
      style={`top:${blockTop}px`}
      aria-label="Block actions"
      aria-expanded={blockMenu}
      onpointerdown={(event) => event.preventDefault()}
      onclick={toggleBlockMenu}><GripVertical size={16} /></button
    >
    {#if blockMenu}<div
        class="block-actions"
        style={`top:${Math.max(0, blockTop + (blockMenuAbove ? -90 : 28))}px`}
        role="menu"
        tabindex="-1"
        aria-label="Block actions"
        onkeydown={(event) => {
          if (event.key === 'Escape') {
            blockMenu = false;
            editor?.commands.focus();
          }
        }}
      >
        <button
          role="menuitem"
          onpointerdown={(event) => event.preventDefault()}
          onclick={copyBlock}><Copy size={16} />Copy block</button
        >
        <button
          role="menuitem"
          onpointerdown={(event) => event.preventDefault()}
          onclick={removeBlock}><Trash2 size={16} />Delete block</button
        >
      </div>{/if}
  {/if}
  {#if copied}<span class="copy-status" role="status">Copied</span>{/if}
  {#if slash && filteredBlocks.length}<div
      class="slash-menu"
      style={`left:${slashX}px;top:${slashY}px`}
      role="toolbar"
      aria-label="Insert block"
    >
      {#each filteredBlocks as item, index}<button
          class:active={index === slashIndex}
          onpointerdown={(event) => event.preventDefault()}
          onclick={() => block(item.type)}
          ><item.icon size={18} />{item.name}</button
        >
      {/each}
    </div>{/if}
</div>
