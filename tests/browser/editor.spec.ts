import {
  test,
  expect,
  type Page,
  type APIRequestContext,
} from '@playwright/test';
const content = (page: Page) =>
  page.getByRole('textbox', { name: 'Page content' }).evaluate((el) => {
    const clone = el.cloneNode(true) as HTMLElement;
    clone
      .querySelectorAll('.collaboration-carets__caret')
      .forEach((node) => node.remove());
    return clone.textContent;
  });
const password = 'browser-test-password-123';
async function provision(request: APIRequestContext, name: string) {
  const email = `${name.toLowerCase()}-${crypto.randomUUID()}@example.com`;
  const response = await request.post('/api/operator', {
    headers: { authorization: 'Bearer browser-operator-test-secret' },
    data: { action: 'create', name, email, password },
  });
  expect(response.status(), await response.text()).toBe(200);
  return email;
}
async function login(page: Page, email: string) {
  await page.goto('/');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('.app-shell')).toBeVisible();
}
async function create(page: Page, name: string) {
  const menu = page.getByRole('button', {
    name: 'Open navigation',
    exact: true,
  });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('button', { name: 'Create page', exact: true }).click();
  await page.getByLabel('Page title', { exact: true }).fill(name);
  await page
    .getByRole('button', { name: 'Create page', exact: true })
    .last()
    .click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await expect(
    page.getByRole('textbox', { name: 'Page content' }),
  ).toBeVisible();
}
test('two users merge text, recover offline edits, format lists, and preserve content on reload', async ({
  browser,
  page,
  request,
  baseURL,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const alice = await provision(request, 'Alice');
  const bob = await provision(request, 'Bob');
  await login(page, alice);
  await create(page, `Shared ${testInfo.project.name} ${Date.now()}`);
  const editor = page.getByRole('textbox', { name: 'Page content' });
  await editor.fill('A shared beginning.');
  await expect(page.locator('.save-status')).toHaveText('Saved');
  const context = await browser.newContext({ baseURL });
  const second = await context.newPage();
  second.on('pageerror', (e) => errors.push(e.message));
  await login(second, bob);
  await second.goto(page.url());
  const other = second.getByRole('textbox', { name: 'Page content' });
  await expect(other).toContainText('A shared beginning.');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
  await other.click();
  await second.keyboard.press('ControlOrMeta+End');
  await Promise.all([
    page.keyboard.insertText(' Alice was here.'),
    second.keyboard.insertText(' Bob was here.'),
  ]);
  await expect
    .poll(async () => (await content(page)) === (await content(second)))
    .toBe(true);
  await expect(editor).toContainText('Alice');
  await expect(editor).toContainText('Bob');
  await page.context().setOffline(true);
  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(' Saved while offline.');
  await expect(page.locator('.save-status')).toContainText('Offline');
  await other.click();
  await second.keyboard.press('ControlOrMeta+End');
  await second.keyboard.type(' An online edit.');
  await page.context().setOffline(false);
  await expect(other).toContainText('Saved while offline.');
  await expect(editor).toContainText('An online edit.');
  await expect(page.locator('.save-status')).toHaveText('Saved');
  await page.reload();
  await expect(
    page.getByRole('textbox', { name: 'Page content' }),
  ).toContainText('Saved while offline.');
  await expect(page.locator('.save-status')).toHaveText('Saved');
  await page.getByRole('textbox', { name: 'Page content' }).click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/todo');
  await page.keyboard.press('Enter');
  await page.keyboard.type('A collaborative task');
  await expect(second.locator('li[data-type="taskItem"]')).toContainText(
    'A collaborative task',
  );
  await page
    .locator('li[data-type="taskItem"] input[type="checkbox"]')
    .first()
    .check();
  await expect(
    second.locator('li[data-type="taskItem"] input[type="checkbox"]').first(),
  ).toBeChecked();
  await expect(page.locator('body')).not.toHaveCSS('overflow-x', 'scroll');
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `test-results/${testInfo.project.name}-editor.png`,
    fullPage: true,
  });
  expect(errors).toEqual([]);
  await context.close();
});
test('nested pages, move validation, trash and restore work through touch controls', async ({
  page,
  request,
}, testInfo) => {
  const email = await provision(request, 'Tree');
  await login(page, email);
  const name = `Parent ${testInfo.project.name} ${Date.now()}`;
  await create(page, name);
  await page.getByRole('button', { name: 'Page actions', exact: true }).click();
  await page
    .getByRole('button', { name: 'Add nested page', exact: true })
    .click();
  await page.getByLabel('Page title').fill('Nested page');
  await page
    .getByRole('button', { name: 'Create page', exact: true })
    .last()
    .click();
  await expect(
    page.getByRole('heading', { name: 'Nested page', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Page actions', exact: true }).click();
  await page.getByRole('button', { name: 'Move to…', exact: true }).click();
  await expect(
    page
      .getByLabel('Inside')
      .locator(
        'option[value="' + new URL(page.url()).pathname.split('/').pop() + '"]',
      ),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page
    .locator('.breadcrumbs')
    .getByRole('button', { name, exact: true })
    .click();
  await page.getByRole('button', { name: 'Page actions', exact: true }).click();
  await page
    .getByRole('button', { name: 'Move to trash', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Move to trash', exact: true })
    .click();
  const menu = page.getByRole('button', {
    name: 'Open navigation',
    exact: true,
  });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('button', { name: 'Trash', exact: true }).click();
  await page
    .locator('.trash-row')
    .filter({ hasText: name })
    .getByRole('button', { name: 'Restore' })
    .click();
  await expect(
    page.locator('.trash-row').filter({ hasText: name }),
  ).toHaveCount(0);
});
test('keyboard block insertion, slash commands, nesting, movement and undo', async ({
  page,
  request,
}, testInfo) => {
  const email = await provision(request, 'Writer');
  await login(page, email);
  await create(page, `Editing ${testInfo.project.name} ${Date.now()}`);
  await expect(page.locator('.save-status')).toHaveText('Saved');
  const editor = page.getByRole('textbox', { name: 'Page content' });
  await editor.click();
  await page.keyboard.insertText('First paragraph');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('Second paragraph');
  await expect(editor.locator('p')).toHaveText([
    'First paragraph',
    'Second paragraph',
  ]);
  await page.keyboard.press('ControlOrMeta+Shift+ArrowUp');
  await expect(editor.locator('p')).toHaveText([
    'Second paragraph',
    'First paragraph',
  ]);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(editor).toContainText('First paragraph');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('/');
  await expect(
    page.getByRole('toolbar', { name: 'Insert block' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Bullet list', exact: true }).click();
  await editor.locator('li p').last().click();
  await page.keyboard.insertText('Parent item');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('Nested item');
  await page.keyboard.press('Tab');
  await expect(editor.locator('li li')).toContainText('Nested item');
  await page.keyboard.press('Shift+Tab');
  await expect(editor.locator('li li')).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+b');
  await editor.locator('li p').last().click();
  await page.keyboard.insertText(' bold');
  await expect(editor.locator('strong')).toContainText('bold');
  const ime = await page.context().newCDPSession(page);
  await editor.locator('li p').last().click();
  await ime.send('Input.imeSetComposition', {
    text: '日本語',
    selectionStart: 3,
    selectionEnd: 3,
  });
  await ime.send('Input.insertText', { text: '日本語' });
  await expect(editor).toContainText('日本語');
  await ime.detach();
  await expect(page.locator('.save-status')).toHaveText('Saved');
});
test('pending edits survive refresh and deletion, and expired sessions can resume', async ({
  page,
  browser,
  request,
  baseURL,
}, testInfo) => {
  const email = await provision(request, 'Recovery');
  const otherEmail = await provision(request, 'Helper');
  await login(page, email);
  await create(page, `Recovery ${testInfo.project.name} ${Date.now()}`);
  await expect(page.locator('.save-status')).toHaveText('Saved');
  const editor = page.getByRole('textbox', { name: 'Page content' });
  await editor.fill('Durable content');
  await expect(page.locator('.save-status')).toHaveText('Saved');
  const reset = await request.post('/api/operator', {
    headers: { authorization: 'Bearer browser-operator-test-secret' },
    data: { action: 'reset-password', email, password },
  });
  expect(reset.ok()).toBe(true);
  await expect(
    page.getByRole('heading', { name: 'Sign in again' }),
  ).toBeVisible();
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('.save-status')).toHaveText('Saved');
  await page.context().setOffline(true);
  await editor.click();
  await page.keyboard.insertText(' Local recovery.');
  await expect(page.locator('.save-status')).toContainText('Offline');
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.context().setOffline(false);
  await page.reload();
  await expect(
    page.getByRole('textbox', { name: 'Page content' }),
  ).toContainText('Local recovery.');
  await expect(page.locator('.save-status')).toHaveText('Saved');
  const context = await browser.newContext({ baseURL });
  const other = await context.newPage();
  await login(other, otherEmail);
  const id = new URL(page.url()).pathname.split('/').pop();
  await page.context().setOffline(true);
  await page.getByRole('textbox', { name: 'Page content' }).click();
  await page.keyboard.insertText(' Keep this after deletion.');
  const removed = await context.request.delete('/api/pages/' + id, {
    headers: { origin: baseURL! },
  });
  expect(removed.ok()).toBe(true);
  await page.context().setOffline(false);
  await expect(page).toHaveURL(baseURL + '/');
  await expect(page.getByLabel('Recovered edits')).toHaveValue(
    /Keep this after deletion/,
  );
  await expect(page.getByRole('textbox', { name: 'Page content' })).toHaveCount(
    0,
  );
  await context.close();
});
test('quiet home, inline creation, synced emoji, and navigation after deletion', async ({
  page,
  request,
  browser,
  baseURL,
}, testInfo) => {
  const email = await provision(request, 'Minimal');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Sign in', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Ask the owner of this instance for access.'),
  ).toBeVisible();
  await login(page, email);
  await expect(page).toHaveURL(baseURL + '/');
  await expect(
    page.locator('.workspace .document, .workspace .empty-state'),
  ).toHaveCount(0);
  await expect(page.locator('.workspace')).toHaveCSS(
    'background-color',
    'rgba(0, 0, 0, 0)',
  );
  expect(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue('--bg')
        .trim(),
    ),
  ).toBe('#000');
  const menu = page.getByRole('button', {
    name: 'Open navigation',
    exact: true,
  });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('button', { name: 'Create page', exact: true }).click();
  await expect(page.locator('dialog')).not.toBeVisible();
  const form = page.getByRole('form', { name: 'New page' });
  await expect(form).toBeVisible();
  const name = `Emoji ${testInfo.project.name} ${Date.now()}`;
  await form.getByLabel('Page title').fill(name);
  await form.getByLabel('Choose page emoji').click();
  await form.getByLabel('Page title').click();
  await expect(form.locator('.emoji-popover')).toBeHidden();
  await form.getByLabel('Choose page emoji').click();
  await form.getByRole('tab', { name: 'Food and drink', exact: true }).click();
  await expect(
    form.getByRole('menu', { name: 'Favorites', exact: true }),
  ).toBeHidden();
  await expect
    .poll(() =>
      form
        .getByRole('tabpanel')
        .evaluate((el) => el.scrollWidth - el.clientWidth),
    )
    .toBeLessThanOrEqual(1);

  await form
    .getByRole('combobox', { name: 'Search', exact: true })
    .fill('memo');
  await form.getByRole('option', { name: /memo/ }).click();
  await form.getByRole('button', { name: 'Create page', exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await expect(page.locator('.page-icon summary')).toContainText('📝');
  const url = page.url();
  const context = await browser.newContext({ baseURL });
  const other = await context.newPage();
  await login(other, email);
  await other.goto(url);
  await page.getByRole('button', { name: 'Rename page', exact: true }).click();
  await expect(page.locator('dialog')).not.toBeVisible();
  const titleField = page.getByRole('textbox', {
    name: 'Page title',
    exact: true,
  });
  await titleField.fill(name + ' renamed');
  await titleField.press('Enter');
  await expect(
    other.getByRole('heading', { name: name + ' renamed', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Rename page', exact: true }).click();
  await titleField.fill('Discard this title');
  await titleField.press('Escape');
  await expect(
    page.getByRole('heading', { name: name + ' renamed', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Rename page', exact: true }).click();
  await titleField.fill(name);
  await page.getByLabel('Choose page emoji').click();
  await expect(other.getByRole('heading', { name, exact: true })).toBeVisible();
  await page.getByLabel('Choose page emoji').click();
  await page.reload();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await page.getByLabel('Choose page emoji').click();
  const viewport = page.viewportSize()!;
  if (testInfo.project.name === 'mobile') {
    await page.touchscreen.tap(viewport.width - 8, viewport.height - 8);
  } else {
    await page.mouse.click(viewport.width - 8, viewport.height - 8);
  }
  await expect(page.locator('.page-icon .emoji-popover')).toBeHidden();
  await page.getByLabel('Choose page emoji').click();
  await page
    .getByRole('combobox', { name: 'Search', exact: true })
    .press('Escape');
  await expect(page.locator('.page-icon .emoji-popover')).toBeHidden();
  await expect(page.getByLabel('Choose page emoji')).toBeFocused();
  await page.getByLabel('Choose page emoji').click();
  await page
    .getByRole('combobox', { name: 'Search', exact: true })
    .fill('octopus');
  await page.getByRole('option', { name: /octopus/ }).click();
  await expect(other.locator('.page-icon summary')).toContainText('🐙');
  await page.reload();
  await expect(page.locator('.page-icon summary')).toContainText('🐙');
  await page.getByLabel('Choose page emoji').click();
  await page.getByRole('button', { name: /Choose a skin tone/ }).click();
  await page.getByRole('option', { name: 'Medium-Dark', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Search', exact: true })
    .fill('thumbs up');
  await page.getByRole('option', { name: /thumbs up/ }).click();
  await expect(other.locator('.page-icon summary')).toContainText('👍🏾');
  await page.getByLabel('Choose page emoji').click();
  await page.getByRole('tab', { name: 'Food and drink', exact: true }).click();
  await expect(
    page.getByRole('menu', { name: 'Favorites', exact: true }),
  ).toBeHidden();
  await expect
    .poll(() =>
      page
        .getByRole('tabpanel')
        .evaluate((el) => el.scrollWidth - el.clientWidth),
    )
    .toBeLessThanOrEqual(1);
  await page.screenshot({
    path: `test-results/${testInfo.project.name}-emoji-picker.png`,
  });
  await page.getByRole('button', { name: 'Remove emoji', exact: true }).click();
  await expect(page.locator('.page-icon summary svg')).toHaveClass(
    /lucide-file-text/,
  );
  await expect(other.locator('.page-icon summary svg')).toHaveClass(
    /lucide-file-text/,
  );
  await page.getByRole('button', { name: 'Page actions', exact: true }).click();
  await page
    .getByRole('button', { name: 'Move to trash', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Move to trash', exact: true })
    .click();
  await expect(page).toHaveURL(baseURL + '/');
  await expect(other).toHaveURL(baseURL + '/');
  await expect(page.getByRole('textbox', { name: 'Page content' })).toHaveCount(
    0,
  );
  await page.reload();
  await expect(page.locator('.workspace .document')).toHaveCount(0);
  await page.goto(baseURL + '/trash');
  await expect(
    page.getByRole('heading', { name: 'Trash', exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: `test-results/${testInfo.project.name}-minimal-trash.png`,
  });
  await context.close();
});

test('drag indicators reorder pages and holding over a page nests them', async ({
  page,
  request,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop',
    'Native HTML drag and drop requires a mouse.',
  );
  await login(page, await provision(request, 'Drag'));
  const prefix = 'Drag ' + Date.now();
  const names = [prefix + ' A', prefix + ' B', prefix + ' C'];
  const ids: string[] = [];
  for (const name of names) {
    await create(page, name);
    ids.push(new URL(page.url()).pathname.split('/').pop()!);
  }
  const row = (index: number) =>
    page.getByRole('group', { name: names[index], exact: true });
  async function startDrag(source: number, target: number, fraction: number) {
    const from = (await row(source).boundingBox())!;
    const to = (await row(target).boundingBox())!;
    await page.mouse.move(from.x + 70, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + 80, from.y + from.height / 2, { steps: 3 });
    await page.mouse.move(to.x + 70, to.y + to.height * fraction, {
      steps: 10,
    });
    await page.mouse.move(to.x + 71, to.y + to.height * fraction);
  }
  const pages = async () => (await page.request.get('/api/pages')).json();
  await startDrag(0, 2, 0.9);
  await expect(page.locator('.tree-drop-line')).toHaveCount(1);
  await page.mouse.up();
  await expect
    .poll(async () =>
      (await pages())
        .filter((p: any) => ids.includes(p.id))
        .map((p: any) => p.id),
    )
    .toEqual([ids[1], ids[2], ids[0]]);

  await startDrag(1, 2, 0.5);
  await expect(row(2)).toHaveClass(/drop-pending/);
  await expect(row(2)).toHaveClass(/drop-inside/);
  await page.screenshot({ path: 'test-results/desktop-drag-nest.png' });
  await page.mouse.up();
  await expect
    .poll(
      async () => (await pages()).find((p: any) => p.id === ids[1]).parentId,
    )
    .toBe(ids[2]);
  await expect(
    row(2).getByRole('button', { name: 'Collapse ' + names[2], exact: true }),
  ).toHaveAttribute('aria-expanded', 'true');

  await startDrag(2, 1, 0.5);
  await expect(
    page.locator('.tree-drop-line, .drop-inside, .drop-pending'),
  ).toHaveCount(0);
  await page.mouse.up();
  expect((await pages()).find((p: any) => p.id === ids[2]).parentId).toBeNull();

  await startDrag(1, 2, 0.1);
  await expect(page.locator('.tree-drop-line')).toHaveCount(1);
  await page.mouse.up();
  await expect
    .poll(
      async () => (await pages()).find((p: any) => p.id === ids[1]).parentId,
    )
    .toBeNull();
  await expect
    .poll(async () =>
      (await pages())
        .filter((p: any) => ids.includes(p.id))
        .map((p: any) => p.id),
    )
    .toEqual([ids[1], ids[2], ids[0]]);
  await expect(
    page.locator('.tree-drop-line, .drop-inside, .drop-pending'),
  ).toHaveCount(0);
});

test('new content blocks persist, toggle locally, and keep controls out of the document', async ({
  page,
  request,
  browser,
  baseURL,
}, testInfo) => {
  const email = await provision(request, 'Blocks');
  await login(page, email);
  const targetName = 'Reference ' + Date.now();
  await create(page, targetName);
  const targetURL = page.url();
  const name = 'Content ' + testInfo.project.name + ' ' + Date.now();
  await create(page, name);
  const url = page.url();
  const editor = page.getByRole('textbox', { name: 'Page content' });
  const command = async (value: string) => {
    await editor.click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type('/' + value);
    await expect(
      page.getByRole('toolbar', { name: 'Insert block' }),
    ).toBeVisible();
    await page.keyboard.press('Enter');
  };
  await expect(page.locator('.child-pages')).toHaveCount(0);
  for (let level = 1; level <= 6; level++) {
    await command('h' + level);
    await page.keyboard.type('Heading ' + level);
    await expect(editor.locator('h' + level)).toHaveText('Heading ' + level);
    await page.keyboard.press('Enter');
  }
  await command('toggle');
  await expect(editor.locator('.toggle-block')).toHaveAttribute(
    'data-open',
    'false',
  );
  await page.keyboard.type('Details');
  await expect(editor.locator('.toggle-summary')).toHaveText('Details');
  await page.keyboard.press('Enter');
  await expect(editor.locator('.toggle-body')).toBeVisible();
  await page.keyboard.type('Hidden content');
  await editor
    .getByRole('button', { name: 'Collapse toggle', exact: true })
    .click();
  await expect(editor.locator('.toggle-body')).toBeHidden();

  // Each reader starts with toggles collapsed, regardless of another reader's state.
  await expect(page.locator('.save-status')).toHaveText('Saved');
  const context = await browser.newContext({ baseURL });
  const other = await context.newPage();
  await login(other, email);
  await other.goto(url);
  await expect(other.locator('.toggle-body')).toBeHidden();
  await editor
    .getByRole('button', { name: 'Expand toggle', exact: true })
    .click();
  await expect(other.locator('.toggle-body')).toBeHidden();
  await editor
    .getByRole('button', { name: 'Collapse toggle', exact: true })
    .click();
  // Leave the container using the paragraph after it.
  await editor.locator(':scope > p').last().click();
  await command('heading toggle 3');
  await expect(editor.locator('.toggle-block[data-level="3"]')).toHaveAttribute(
    'data-open',
    'false',
  );
  await editor.locator('.toggle-block[data-level="3"] .toggle-summary').click();
  await page.keyboard.type('More details');
  await editor.locator(':scope > p').last().click();
  await command('image');
  const imageForm = page.getByRole('form', { name: 'Insert image' });
  await expect(imageForm).toBeVisible();
  await imageForm.getByLabel('Image description').fill('A test pixel');
  await imageForm.getByLabel('Upload image').setInputFiles({
    name: 'pixel.png',
    mimeType: 'image/png',
    buffer: Buffer.concat([
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=',
        'base64',
      ),
      Buffer.alloc(2_100_000),
    ]),
  });
  await expect(editor.getByRole('img', { name: 'A test pixel' })).toBeVisible();
  await expect
    .poll(() =>
      editor
        .locator('img')
        .evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBe(1);
  await expect(other.getByRole('img', { name: 'A test pixel' })).toBeVisible();
  await command('page');
  const form = page.getByRole('form', { name: 'Insert page link' });
  await form.getByLabel('Find page to link').fill(targetName);
  await form.getByRole('button', { name: targetName, exact: false }).click();
  await expect(
    editor.getByRole('link', { name: targetName, exact: false }),
  ).toBeVisible();
  await editor.locator(':scope > p').last().click();
  await page.keyboard.type('Delete this block');
  if (testInfo.project.name === 'desktop') {
    await expect(
      page.getByRole('toolbar', { name: 'Formatting' }),
    ).toBeHidden();
    await editor.locator('p').filter({ hasText: 'Delete this block' }).hover();
  } else {
    await expect(
      page.getByRole('toolbar', { name: 'Formatting' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Bold', exact: true }).click();
    await page.keyboard.type(' bold');
    await expect(editor.locator('strong')).toHaveText(' bold');
  }
  await page
    .getByRole('button', { name: 'Block actions', exact: true })
    .click();
  await page
    .getByRole('menuitem', { name: 'Delete block', exact: true })
    .click();
  await expect(editor).not.toContainText('Delete this block');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(editor).toContainText('Delete this block');
  await expect(page.locator('.save-status')).toHaveText('Saved');
  await page.reload();
  await expect(editor.locator('.toggle-block')).toHaveCount(2);
  await expect(editor.locator('.toggle-body').first()).toBeHidden();
  await expect(editor.locator('.toggle-body').first()).toContainText(
    'Hidden content',
  );
  await expect(editor.getByRole('img', { name: 'A test pixel' })).toBeVisible();
  await page.screenshot({
    path: 'test-results/' + testInfo.project.name + '-content-blocks.png',
    fullPage: true,
  });
  await editor.getByRole('link', { name: targetName, exact: false }).click();
  await expect(page).toHaveURL(targetURL);
  const menu = page.getByRole('button', {
    name: 'Open navigation',
    exact: true,
  });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  const recent = page.getByRole('navigation', {
    name: 'Recently viewed pages',
  });
  await expect(recent.getByRole('button')).toHaveText([targetName, name]);
  await other.goto(baseURL + '/');
  await expect(
    other
      .getByRole('navigation', { name: 'Recently viewed pages' })
      .getByRole('button'),
  ).toHaveText([targetName, name]);
  if (testInfo.project.name === 'mobile') {
    await expect
      .poll(() =>
        page
          .locator('aside')
          .evaluate((el) => el.getBoundingClientRect().right),
      )
      .toBeLessThanOrEqual(0);
  }
  await page.screenshot({
    path: 'test-results/' + testInfo.project.name + '-home.png',
  });
  await context.close();
});

test('block copy retains rich content when pasted', async ({
  page,
  request,
  context,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop',
    'Clipboard keyboard integration uses a desktop browser.',
  );
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await login(page, await provision(request, 'Copy'));
  await create(page, 'Copy blocks');
  const editor = page.getByRole('textbox', { name: 'Page content' });
  await editor.click();
  await page.keyboard.type('/h2');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Copied heading');
  await page
    .getByRole('button', { name: 'Block actions', exact: true })
    .click();
  await page.getByRole('menuitem', { name: 'Copy block', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Copied');
  await editor.locator('h2').click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.press('ControlOrMeta+v');
  await expect(editor.locator('h2')).toHaveText([
    'Copied heading',
    'Copied heading',
  ]);
  await editor.locator('h2').last().click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .toBe('Copied heading');
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByLabel('Link URL').fill('https://example.com');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(editor.locator('a[href="https://example.com"]')).toHaveText(
    'Copied heading',
  );
});

test('collapsed parents show a child count without a sticky caret', async ({
  page,
  request,
}, testInfo) => {
  await login(page, await provision(request, 'Caret'));
  const parentName =
    'Parent with children ' + testInfo.project.name + ' ' + Date.now();
  const childName = 'Child ' + testInfo.project.name + ' ' + Date.now();
  await create(page, parentName);
  await page.getByRole('button', { name: 'Page actions', exact: true }).click();
  await page
    .getByRole('button', { name: 'Add nested page', exact: true })
    .click();
  await page.getByLabel('Page title').fill(childName);
  await page
    .getByRole('form', { name: 'New page' })
    .getByRole('button', { name: 'Create page', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: childName, exact: true }),
  ).toBeVisible();
  const menu = page.getByRole('button', {
    name: 'Open navigation',
    exact: true,
  });
  if (await menu.isVisible()) await menu.click();
  const parent = page.getByRole('group', {
    name: parentName,
    exact: true,
  });
  await parent
    .getByRole('button', { name: 'Collapse ' + parentName, exact: true })
    .click();
  await expect(parent.getByLabel('1 nested pages')).toBeVisible();
  await parent.getByRole('button', { name: parentName, exact: true }).click();
  if (testInfo.project.name === 'mobile') await menu.click();
  else {
    await page.mouse.move(800, 80);
    await expect(parent.locator('.tree-icon-toggle')).toHaveCSS('opacity', '0');
    await parent.hover();
    await expect(parent.locator('.tree-icon-toggle')).toHaveCSS('opacity', '1');
  }
  await parent
    .getByRole('button', { name: 'Expand ' + parentName, exact: true })
    .click();
  await expect(parent.locator('.tree-child-count')).toHaveCount(0);
  await expect(
    page.getByRole('group', { name: childName, exact: true }),
  ).toBeVisible();
});

test('mobile formatting follows the visible viewport and hides after leaving the editor', async ({
  page,
  request,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'Mobile toolbar only.');
  await login(page, await provision(request, 'Keyboard'));
  await create(page, 'Keyboard toolbar');
  const editor = page.getByRole('textbox', { name: 'Page content' });
  await editor.click();
  await page.keyboard.type('Mobile content');
  const toolbar = page.getByRole('toolbar', { name: 'Formatting' });
  await expect(toolbar).toBeVisible();
  const viewportBottom = await page.evaluate(() => {
    const viewport = window.visualViewport!;
    Object.defineProperty(viewport, 'height', {
      configurable: true,
      value: innerHeight - 300,
    });
    Object.defineProperty(viewport, 'offsetTop', {
      configurable: true,
      value: 20,
    });
    viewport.dispatchEvent(new Event('resize'));
    return viewport.height + viewport.offsetTop;
  });
  await expect
    .poll(async () => {
      const bounds = (await toolbar.boundingBox())!;
      return Math.abs(bounds.y + bounds.height - viewportBottom);
    })
    .toBeLessThanOrEqual(1);
  await page.screenshot({ path: 'test-results/mobile-keyboard-toolbar.png' });
  await page.getByRole('button', { name: 'Rename page', exact: true }).click();
  await expect(toolbar).toBeHidden();
});
