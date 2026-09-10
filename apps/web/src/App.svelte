<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import {
    FileText,
    House,
    ChevronRight,
    ChevronDown,
    Plus,
    Search,
    Trash2,
    PanelLeftClose,
    Menu,
    MoreHorizontal,
    ArrowUpRight,
    LogOut,
    X,
    FolderInput,
    Pencil,
    RotateCcw,
    LoaderCircle,
  } from '@lucide/svelte';
  import Editor from './Editor.svelte';
  import EmojiPicker from './EmojiPicker.svelte';
  import PageTitle from './PageTitle.svelte';
  type Page = {
    id: string;
    title: string;
    emoji: string | null;
    parentId: string | null;
    position: number;
    deletedAt: number | null;
    deletionId: string | null;
  };
  let authEpoch = $state(0);
  let user = $state<{ id: string; name: string; email: string } | null>(null);
  let loading = $state(true);
  let expired = $state(false);
  let email = $state('');
  let password = $state('');
  let busy = $state(false);
  let error = $state('');
  let toast = $state('');
  let pages = $state<Page[]>([]);
  let selected = $state(location.pathname.match(/^\/p\/([^/]+)/)?.[1] || '');
  let drawer = $state(false);
  let expanded = $state(new Set<string>());
  let query = $state('');
  let trash = $state(location.pathname === '/trash');
  let connected = $state(false);
  let status = $state('Connecting…');
  let creating = $state(false);
  let draftTitle = $state('');
  let draftEmoji = $state<string | null>(null);
  let draftParent = $state<string | null>(null);
  let createError = $state('');
  let creatingBusy = $state(false);
  let titleInput = $state<HTMLInputElement>();
  let editorView = $state<Editor>();
  let recovered = $state('');
  let recentPages = $state<Page[]>([]);
  let recentError = $state('');
  let recentLoading = $state(false);
  let visitKey = '';
  let visitWrite: Promise<unknown> = Promise.resolve();
  $effect(() => {
    const account = user?.id;
    const id = current?.deletedAt ? '' : current?.id;
    const key =
      account && id && !trash ? account + ':' + id + ':' + authEpoch : '';
    if (key && key !== visitKey) {
      visitKey = key;
      visitWrite = visitWrite
        .catch(() => {})
        .then(() =>
          user?.id === account
            ? api('/pages/' + id + '/visit', 'POST')
            : undefined,
        )
        .catch(() => {});
    } else if (!key) visitKey = '';
  });
  $effect(() => {
    if (!user || selected || trash) return;
    const account = user.id;
    authEpoch;
    let cancelled = false;
    recentLoading = true;
    recentError = '';
    recentPages = [];
    void visitWrite
      .then(() => api('/recent-pages'))
      .then((result) => {
        if (!cancelled && user?.id === account) recentPages = result;
      })
      .catch(() => {
        if (!cancelled) recentError = 'Recent pages could not be loaded.';
      })
      .finally(() => {
        if (!cancelled) recentLoading = false;
      });
    return () => {
      cancelled = true;
    };
  });
  let action = $state('');
  let target = $state<Page | null>(null);
  let name = $state('');
  let parent = $state('');
  let dialog: HTMLDialogElement;
  let dragged = $state('');
  let dropTarget = $state<{
    id: string;
    placement: 'before' | 'after' | 'inside';
    pending: boolean;
  } | null>(null);
  let nestTimer: ReturnType<typeof setTimeout>;
  function clearDrop() {
    clearTimeout(nestTimer);
    dropTarget = null;
  }
  function endDrag() {
    clearDrop();
    dragged = '';
  }
  onDestroy(endDrag);
  let metaSocket: WebSocket;
  let reconnect: ReturnType<typeof setTimeout>;
  let heartbeat: ReturnType<typeof setInterval>;
  let stopped = false;
  let toastTimer: ReturnType<typeof setTimeout>;
  let current = $derived(pages.find((p) => p.id === selected));
  let activePages = $derived(pages.filter((p) => !p.deletedAt));
  let crumbs = $derived.by(() => {
    const result: Page[] = [];
    let page = current;
    const seen = new Set<string>();
    while (page && !seen.has(page.id)) {
      seen.add(page.id);
      result.unshift(page);
      page = pages.find((p) => p.id === page?.parentId);
    }
    return result;
  });
  $effect(() => {
    document.title = current ? `${current.title} · jot` : 'jot';
  });
  $effect(() => {
    if (dialog) {
      if (action && !dialog.open) dialog.showModal();
      else if (!action && dialog.open) dialog.close();
    }
  });
  function notify(message: string) {
    toast = message;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = ''), 5000);
  }
  async function api(path: string, method = 'GET', body?: any) {
    const response = await fetch('/api' + path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 401 && user) expired = true;
      throw new Error(data.message || 'Something went wrong. Try again.');
    }
    return data;
  }
  function updatePages(next: Page[]) {
    pages = next;
    if (selected && !next.some((p) => p.id === selected && !p.deletedAt)) {
      if (status !== 'Saved') recovered = editorView?.recoveryText() || '';
      home(true);
    }
  }
  function home(replace = false) {
    selected = '';
    trash = false;
    drawer = false;
    if (replace) history.replaceState({}, '', '/');
    else history.pushState({}, '', '/');
  }
  async function beginCreate(page: Page | null = null) {
    action = '';
    creating = true;
    draftTitle = '';
    draftEmoji = null;
    draftParent = page?.id || null;
    createError = '';
    query = '';
    drawer = window.matchMedia('(max-width: 700px)').matches;
    if (page) expanded = new Set([...expanded, page.id]);
    await tick();
    titleInput?.focus();
  }
  async function createPage(event: SubmitEvent) {
    event.preventDefault();
    creatingBusy = true;
    createError = '';
    try {
      const page = await api('/pages', 'POST', {
        title: draftTitle || 'Untitled',
        parentId: draftParent,
        emoji: draftEmoji,
      });
      updatePages(await api('/pages'));
      creating = false;
      select(page.id);
    } catch (e) {
      createError = (e as Error).message;
    } finally {
      creatingBusy = false;
    }
  }
  async function setEmoji(value: string | null) {
    if (!current) return;
    try {
      await api('/pages/' + current.id, 'PATCH', { emoji: value });
    } catch (e) {
      notify((e as Error).message);
    }
  }

  function connectTree() {
    if (stopped || !user || expired) return;
    const socket = (metaSocket = new WebSocket(
      `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/sync`,
    ));
    metaSocket.onopen = () => {
      connected = true;
      heartbeat = setInterval(
        () =>
          metaSocket.readyState === WebSocket.OPEN &&
          metaSocket.send(JSON.stringify({ type: 'ping' })),
        20000,
      );
    };
    metaSocket.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'tree') updatePages(msg.pages);
    };
    metaSocket.onclose = (event) => {
      if (socket !== metaSocket) return;
      connected = false;
      clearInterval(heartbeat);
      if (event.code === 4001) {
        expired = true;
        return;
      }
      if (!stopped && user)
        reconnect = setTimeout(async () => {
          try {
            const s = await api('/auth/get-session');
            if (!s) {
              expired = true;
              return;
            }
            connectTree();
          } catch {
            if (!expired) connectTree();
          }
        }, 2000);
    };
  }
  onMount(() => {
    void (async () => {
      try {
        const s = await api('/auth/get-session');
        if (s?.user) {
          user = s.user;
          updatePages(await api('/pages'));
          connectTree();
        }
      } catch (e) {
        error = (e as Error).message;
      } finally {
        loading = false;
      }
    })();
    const pop = () => {
      selected = location.pathname.match(/^\/p\/([^/]+)/)?.[1] || '';
      trash = location.pathname === '/trash';
      if (selected && !pages.some((p) => p.id === selected && !p.deletedAt))
        home(true);
    };
    window.addEventListener('popstate', pop);
    return () => {
      stopped = true;
      metaSocket?.close();
      clearTimeout(reconnect);
      clearInterval(heartbeat);
      clearTimeout(toastTimer);
      window.removeEventListener('popstate', pop);
    };
  });
  async function login(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    error = '';
    try {
      const result = await api('/auth/sign-in/email', 'POST', {
        email,
        password,
      });
      user = result.user;
      authEpoch++;
      password = '';
      expired = false;
      updatePages(await api('/pages'));
      metaSocket?.close();
      clearTimeout(reconnect);
      connectTree();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }
  async function logout() {
    try {
      await api('/auth/sign-out', 'POST', {});
      user = null;
      selected = '';
      pages = [];
      expired = false;
      metaSocket?.close();
      history.pushState({}, '', '/');
    } catch (e) {
      notify((e as Error).message);
    }
  }
  function select(id: string) {
    if (selected !== id) status = 'Connecting…';
    selected = id;
    creating = false;
    trash = false;
    drawer = false;
    history.pushState({}, '', '/p/' + id);
    let page = pages.find((p) => p.id === id);
    const next = new Set(expanded);
    const seen = new Set<string>();
    while (page?.parentId && !seen.has(page.parentId)) {
      seen.add(page.parentId);
      next.add(page.parentId);
      page = pages.find((p) => p.id === page?.parentId);
    }
    expanded = next;
  }
  function toggle(id: string) {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    expanded = next;
  }
  function open(kind: string, page: Page | null = null) {
    if (kind === 'create') {
      void beginCreate(page);
      return;
    }
    action = kind;
    target = page;
    name = kind === 'rename' ? page?.title || '' : '';
    parent = kind === 'create' ? page?.id || '' : page?.parentId || '';
    error = '';
  }
  function allowedParent(p: Page) {
    if (!target || action === 'create') return true;
    let ancestor: Page | undefined = p;
    const seen = new Set<string>();
    while (ancestor && !seen.has(ancestor.id)) {
      if (ancestor.id === target.id) return false;
      seen.add(ancestor.id);
      ancestor = pages.find((p) => p.id === ancestor?.parentId);
    }
    return true;
  }
  async function submit(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    error = '';
    try {
      if (action === 'rename')
        await api('/pages/' + target!.id, 'PATCH', { title: name });
      else if (action === 'move')
        await api('/pages/' + target!.id, 'PATCH', {
          parentId: parent || null,
        });
      else if (action === 'delete') {
        await api('/pages/' + target!.id, 'DELETE');
        updatePages(await api('/pages'));
        notify('Page moved to trash.');
      }
      action = '';
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }
  async function restore(page: Page) {
    try {
      await api('/pages/' + page.id + '/restore', 'POST');
      notify('Page restored.');
    } catch (e) {
      notify((e as Error).message);
    }
  }
  async function reorder(page: Page, direction: number) {
    const siblings = activePages.filter((p) => p.parentId === page.parentId);
    const index = siblings.findIndex((p) => p.id === page.id);
    if (index + direction < 0 || index + direction >= siblings.length) return;
    const beforeId =
      direction < 0 ? siblings[index - 1].id : siblings[index + 2]?.id || null;
    try {
      await api('/pages/' + page.id, 'PATCH', {
        parentId: page.parentId,
        beforeId,
      });
      action = '';
    } catch (e) {
      notify((e as Error).message);
    }
  }
  function canDrop(page: Page) {
    if (!connected || !dragged) return false;
    let ancestor: Page | undefined = page;
    const seen = new Set<string>();
    while (ancestor && !seen.has(ancestor.id)) {
      if (ancestor.id === dragged) return false;
      seen.add(ancestor.id);
      ancestor = pages.find((p) => p.id === ancestor?.parentId);
    }
    return true;
  }
  function dragOver(event: DragEvent, page: Page) {
    event.stopPropagation();
    if (!canDrop(page)) {
      clearDrop();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const ratio = (event.clientY - bounds.top) / bounds.height;
    const central = ratio >= 0.25 && ratio <= 0.75;
    const placement = ratio < 0.5 ? 'before' : 'after';
    if (
      dropTarget?.id === page.id &&
      central &&
      (dropTarget.pending || dropTarget.placement === 'inside')
    )
      return;
    if (
      dropTarget?.id === page.id &&
      !central &&
      !dropTarget.pending &&
      dropTarget.placement === placement
    )
      return;
    clearDrop();
    dropTarget = { id: page.id, placement, pending: central };
    if (central) {
      nestTimer = setTimeout(() => {
        if (!canDrop(page) || dropTarget?.id !== page.id || !dropTarget.pending)
          return;
        dropTarget = { id: page.id, placement: 'inside', pending: false };
        expanded = new Set([...expanded, page.id]);
      }, 325);
    }
  }
  function dragLeave(event: DragEvent) {
    const row = event.currentTarget as HTMLElement;
    if (
      !(event.relatedTarget instanceof Node) ||
      !row.contains(event.relatedTarget)
    )
      clearDrop();
  }
  async function drop(event: DragEvent, page: Page) {
    event.preventDefault();
    event.stopPropagation();
    if (!canDrop(page) || dropTarget?.id !== page.id) {
      endDrag();
      return;
    }
    const id = dragged;
    const placement = dropTarget.placement;
    const siblings = activePages.filter(
      (p) => p.parentId === page.parentId && p.id !== id,
    );
    const next = siblings[siblings.findIndex((p) => p.id === page.id) + 1];
    endDrag();
    try {
      await api('/pages/' + id, 'PATCH', {
        parentId: placement === 'inside' ? page.id : page.parentId,
        beforeId:
          placement === 'inside'
            ? null
            : placement === 'before'
              ? page.id
              : next?.id || null,
      });
      if (placement === 'inside') expanded = new Set([...expanded, page.id]);
      updatePages(await api('/pages'));
    } catch (e) {
      notify((e as Error).message);
    }
  }
  function editorMessage(msg: any) {
    if (msg.type === 'status') status = msg.value;
    else if (msg.type === 'tree') updatePages(msg.pages);
    else if (msg.type === 'expired') expired = true;
    else if (msg.type === 'error' || msg.type === 'info') notify(msg.message);
  }
</script>

<svelte:window
  onkeydown={(event) => {
    if (event.key === 'Escape') {
      drawer = false;
      endDrag();
    }
  }}
/>

{#snippet tree(parentId: string | null, depth = 0)}
  {#each activePages.filter((p) => p.parentId === parentId) as page (page.id)}
    {@const hasChildren = activePages.some((p) => p.parentId === page.id)}
    {#if dropTarget?.id === page.id && dropTarget.placement === 'before'}
      <div
        class="tree-drop-line"
        style={`--depth:${depth}`}
        aria-hidden="true"
      ></div>
    {/if}
    <div
      class="tree-row"
      class:dragging={dragged === page.id}
      class:drop-inside={dropTarget?.id === page.id &&
        dropTarget.placement === 'inside'}
      class:drop-pending={dropTarget?.id === page.id && dropTarget.pending}
      class:selected={selected === page.id && !trash}
      style={`--depth:${depth}`}
      draggable={connected}
      role="group"
      aria-label={page.title}
      ondragstart={(event) => {
        endDrag();
        dragged = page.id;
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', page.id);
        }
      }}
      ondragend={endDrag}
      ondragleave={dragLeave}
      ondragover={(event) => dragOver(event, page)}
      ondrop={(e) => drop(e, page)}
    >
      {#if hasChildren}
        <button
          class="tree-toggle"
          aria-label={`${expanded.has(page.id) ? 'Collapse' : 'Expand'} ${page.title}`}
          aria-expanded={expanded.has(page.id)}
          onclick={() => toggle(page.id)}
        >
          <span class="tree-icon-default" aria-hidden="true">
            {#if page.emoji}<span class="page-emoji">{page.emoji}</span
              >{:else}<FileText size={16} />{/if}
          </span>
          <span class="tree-icon-toggle" aria-hidden="true">
            {#if expanded.has(page.id)}<ChevronDown
                size={16}
              />{:else}<ChevronRight size={16} />{/if}
          </span>
        </button>
      {/if}
      <button class="tree-page" onclick={() => select(page.id)}>
        {#if !hasChildren}<span class="tree-leaf-icon" aria-hidden="true">
            {#if page.emoji}<span class="page-emoji">{page.emoji}</span
              >{:else}<FileText size={16} />{/if}
          </span>{/if}
        <span>{page.title}</span>
      </button>
      {#if hasChildren && !expanded.has(page.id)}
        <span
          class="tree-child-count"
          title={activePages.filter((p) => p.parentId === page.id).length +
            ' nested pages'}
          aria-label={activePages.filter((p) => p.parentId === page.id).length +
            ' nested pages'}
          >{activePages.filter((p) => p.parentId === page.id).length}</span
        >
      {/if}
      {#if dropTarget?.id === page.id && dropTarget.placement === 'inside'}
        <span class="tree-drop-hint">Move inside</span>
      {/if}
      <button
        class="tree-more"
        class:drag-hidden={!!dragged}
        aria-label={`Actions for ${page.title}`}
        disabled={!connected}
        onclick={() => open('menu', page)}><MoreHorizontal size={17} /></button
      >
    </div>
    {#if expanded.has(page.id)}{@render tree(page.id, depth + 1)}{/if}
    {#if dropTarget?.id === page.id && dropTarget.placement === 'after'}
      <div
        class="tree-drop-line"
        style={`--depth:${depth}`}
        aria-hidden="true"
      ></div>
    {/if}
  {/each}
{/snippet}

{#if loading}
  <div class="loading-screen">
    <span class="wordmark">jot<span>.</span></span><LoaderCircle
      class="spin"
      size={20}
    />
  </div>
{:else if !user}
  <main class="login-screen">
    <div class="login-brand wordmark">jot<span>.</span></div>
    <form class="login-card" onsubmit={login}>
      <h1>Sign in</h1>
      <label
        >Email<input
          type="email"
          autocomplete="username"
          bind:value={email}
          required
          placeholder="you@example.com"
        /></label
      ><label
        >Password<input
          type="password"
          autocomplete="current-password"
          bind:value={password}
          required
        /></label
      >{#if error}<p class="error" role="alert">{error}</p>{/if}<button
        class="primary login-submit"
        disabled={busy}
        >{busy ? 'Signing in…' : 'Sign in'}<ArrowUpRight size={18} /></button
      >
      <p class="login-footnote">Ask the owner of this instance for access.</p>
    </form>
  </main>
{:else}
  <div class="app-shell">
    {#if drawer}<button
        class="drawer-backdrop"
        aria-label="Close navigation"
        onclick={() => (drawer = false)}
      ></button>{/if}
    <aside class:open={drawer} aria-label="Pages">
      <div class="sidebar-brand">
        <a
          class="wordmark"
          href="/"
          onclick={(e) => {
            e.preventDefault();
            home();
          }}>jot<span>.</span></a
        >
        <button
          class="icon-button home-button"
          aria-label="Home"
          aria-current={!selected && !trash ? 'page' : undefined}
          onclick={() => home()}><House size={18} /></button
        >
        <button
          class="mobile-only icon-button"
          aria-label="Close navigation"
          onclick={() => (drawer = false)}><PanelLeftClose size={18} /></button
        >
      </div>
      <div class="search-field">
        <Search size={16} /><input
          aria-label="Find a page"
          placeholder="Find a page…"
          bind:value={query}
        />{#if query}<button
            aria-label="Clear search"
            onclick={() => (query = '')}><X size={14} /></button
          >{/if}
      </div>
      <div class="sidebar-heading">
        <span>PAGES</span><button
          class="icon-button"
          aria-label="Create page"
          disabled={!connected}
          onclick={() => open('create')}><Plus size={18} /></button
        >
      </div>
      <nav class="page-tree" aria-label="Page tree">
        {#if query}{#each activePages.filter((p) => p.title
              .toLowerCase()
              .includes(query.toLowerCase())) as page}<button
              class="search-result"
              onclick={() => {
                select(page.id);
                query = '';
              }}
              >{#if page.emoji}<span class="page-emoji" aria-hidden="true"
                  >{page.emoji}</span
                >{:else}<FileText size={16} />{/if}{page.title}</button
            >{/each}{:else}{@render tree(null)}{/if}
        {#if creating}<form
            class="sidebar-create"
            aria-label="New page"
            onsubmit={createPage}
          >
            {#if draftParent}<div class="draft-parent">
                Inside {pages.find((p) => p.id === draftParent)?.title}
              </div>{/if}
            <div class="draft-row">
              <EmojiPicker
                value={draftEmoji}
                onchange={(value) => {
                  draftEmoji = value;
                }}
              /><input
                bind:this={titleInput}
                aria-label="Page title"
                bind:value={draftTitle}
                maxlength="200"
                placeholder="Untitled"
                onkeydown={(event) => {
                  if (event.key === 'Escape') {
                    event.stopPropagation();
                    creating = false;
                  }
                }}
              />
            </div>
            {#if createError}<p class="error" role="alert">
                {createError}
              </p>{/if}
            <div class="draft-actions">
              <button type="button" onclick={() => (creating = false)}
                >Cancel</button
              ><button
                class="primary"
                type="submit"
                disabled={creatingBusy || !connected}
                >{creatingBusy ? 'Creating…' : 'Create page'}</button
              >
            </div>
          </form>{/if}
        <button
          class="new-page"
          disabled={!connected}
          onclick={() => open('create')}><Plus size={16} />New page</button
        >
      </nav>
      <div class="sidebar-bottom">
        <button
          class:active={trash}
          class="trash-link"
          onclick={() => {
            selected = '';
            trash = true;
            creating = false;
            drawer = false;
            history.pushState({}, '', '/trash');
          }}><Trash2 size={16} />Trash</button
        >
        <div class="user-row">
          <div class="avatar">{user.name.slice(0, 1).toUpperCase()}</div>
          <div class="user-details">
            <strong>{user.name}</strong>
            {#if !connected}<span role="status"
                ><i aria-hidden="true"></i>Offline</span
              >{/if}
          </div>
          <button class="icon-button" aria-label="Sign out" onclick={logout}
            ><LogOut size={17} /></button
          >
        </div>
      </div>
    </aside>
    <main class="workspace" inert={drawer}>
      <button
        class="mobile-only icon-button mobile-nav"
        aria-label="Open navigation"
        onclick={() => (drawer = true)}><Menu size={20} /></button
      >
      {#if trash}
        <section class="document trash-view">
          <h1>Trash</h1>
          {#each pages.filter((p) => p.deletedAt && p.deletionId === p.id) as page}<div
              class="trash-row"
            >
              {#if page.emoji}<span class="page-emoji" aria-hidden="true"
                  >{page.emoji}</span
                >{:else}<FileText size={19} />{/if}<span>{page.title}</span
              ><button disabled={!connected} onclick={() => restore(page)}
                ><RotateCcw size={16} />Restore</button
              >
            </div>{/each}{#if !pages.some((p) => p.deletedAt)}<div
              class="empty-trash"
            >
              <Trash2 size={30} />
              <p>Nothing in the trash.</p>
            </div>{/if}
        </section>
      {:else if current}
        <section class="document">
          {#if crumbs.length > 1}<nav
              class="breadcrumbs"
              aria-label="Parent pages"
            >
              {#each crumbs.slice(0, -1) as crumb, i}{#if i}<ChevronRight
                    size={12}
                  />{/if}<button onclick={() => select(crumb.id)}
                  >{#if crumb.emoji}<span class="page-emoji" aria-hidden="true"
                      >{crumb.emoji}</span
                    >{/if}{crumb.title}</button
                >{/each}
            </nav>{/if}
          <div class="page-icon">
            <EmojiPicker
              value={current.emoji}
              onchange={setEmoji}
              disabled={!connected}
            />
          </div>
          <div class="page-title-row">
            {#key current.id}
              <PageTitle
                title={current.title}
                disabled={!connected || !!current.deletedAt}
                onsave={async (title) => {
                  const id = current!.id;
                  await api('/pages/' + id, 'PATCH', { title });
                  updatePages(await api('/pages'));
                }}
              />
            {/key}
            <div class="page-controls">
              <span class="save-status"
                ><i class:saved={status === 'Saved'}></i>{status}</span
              ><button
                class="icon-button"
                aria-label="Page actions"
                disabled={!connected}
                onclick={() => open('menu', current!)}
                ><MoreHorizontal size={20} /></button
              >
            </div>
          </div>
          {#key user.id + ':' + selected + ':' + authEpoch}<Editor
              bind:this={editorView}
              pageId={selected}
              isDeleted={!!current.deletedAt}
              {user}
              pages={activePages}
              onpage={select}
              onmessage={editorMessage}
            />{/key}
        </section>
      {:else}
        <section class="home-view" aria-label="Home">
          <h1>Recently viewed</h1>
          {#if recentLoading}<p class="muted" role="status">Loading…</p>
          {:else if recentError}<p class="error" role="alert">{recentError}</p>
          {:else if !recentPages.length}<p class="muted">
              No recently viewed pages.
            </p>
          {:else}<nav aria-label="Recently viewed pages">
              {#each recentPages as page}
                <button onclick={() => select(page.id)}>
                  {#if page.emoji}<span class="page-emoji" aria-hidden="true"
                      >{page.emoji}</span
                    >{:else}<FileText size={18} />{/if}
                  <span>{page.title}</span>
                </button>
              {/each}
            </nav>{/if}
        </section>
        {#if recovered}<section class="document recovery">
            <p>This page was deleted. Your unsynced text is saved below.</p>
            <textarea aria-label="Recovered edits" readonly value={recovered}
            ></textarea><button
              onclick={() => {
                recovered = '';
              }}>Dismiss</button
            >
          </section>{/if}
      {/if}
    </main>
  </div>
{/if}

<dialog
  bind:this={dialog}
  onclose={() => (action = '')}
  oncancel={() => (action = '')}
>
  <div class="dialog-heading">
    <h2>
      {action === 'menu'
        ? target?.title
        : action === 'rename'
          ? 'Rename page'
          : action === 'move'
            ? 'Move page'
            : 'Move to trash?'}
    </h2>
    <button
      class="icon-button"
      aria-label="Close dialog"
      onclick={() => (action = '')}><X size={20} /></button
    >
  </div>
  {#if action === 'menu'}<div class="action-menu">
      <button onclick={() => open('rename', target)}
        ><Pencil size={17} />Rename</button
      ><button onclick={() => open('create', target)}
        ><Plus size={17} />Add nested page</button
      ><button onclick={() => open('move', target)}
        ><FolderInput size={17} />Move to…</button
      ><button onclick={() => reorder(target!, -1)}>↑ Move up</button><button
        onclick={() => reorder(target!, 1)}>↓ Move down</button
      ><button class="danger" onclick={() => open('delete', target)}
        ><Trash2 size={17} />Move to trash</button
      >
    </div>
  {:else}<form onsubmit={submit}>
      {#if action === 'rename'}<label
          >Page title<input
            aria-label="Page title"
            bind:value={name}
            maxlength="200"
            placeholder="Untitled"
          /></label
        >{/if}{#if action === 'move'}<label
          >Inside<select bind:value={parent}
            ><option value="">Top level</option
            >{#each activePages.filter(allowedParent) as page}<option
                value={page.id}>{page.title}</option
              >{/each}</select
          ></label
        >{/if}{#if action === 'delete'}<p>
          “{target?.title}” and its nested pages will move to trash. You can
          restore them later.
        </p>{/if}{#if error}<p class="error" role="alert">{error}</p>{/if}
      <div class="dialog-footer">
        <button type="button" onclick={() => (action = '')}>Cancel</button
        ><button class="primary" disabled={busy || !connected}
          >{busy
            ? 'Saving…'
            : action === 'delete'
              ? 'Move to trash'
              : 'Save'}</button
        >
      </div>
    </form>{/if}
</dialog>
{#if expired && user}<div class="session-overlay">
    <form class="login-card" onsubmit={login}>
      <h2>Sign in again</h2>
      <p>Your edits are saved on this device.</p>
      <label
        >Email<input
          type="email"
          autocomplete="username"
          bind:value={email}
          required
        /></label
      ><label
        >Password<input
          type="password"
          autocomplete="current-password"
          bind:value={password}
          required
        /></label
      >{#if error}<p class="error">{error}</p>{/if}<button
        class="primary"
        disabled={busy}>Sign in</button
      >
    </form>
  </div>{/if}
{#if toast}<div class="toast" role="status">
    {toast}<button aria-label="Dismiss message" onclick={() => (toast = '')}
      ><X size={15} /></button
    >
  </div>{/if}
