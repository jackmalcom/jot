import {
  test,
  expect,
  type APIRequestContext,
  type Locator,
  type Page,
} from '@playwright/test';

const password = 'browser-test-password-123';
const editorFor = (page: Page) =>
  page.getByRole('textbox', { name: 'Page content' });

async function provision(request: APIRequestContext) {
  const email = `toggle-keyboard-${crypto.randomUUID()}@example.com`;
  const response = await request.post('/api/operator', {
    headers: { authorization: 'Bearer browser-operator-test-secret' },
    data: { action: 'create', name: 'Toggle keyboard', email, password },
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
  await expect(editorFor(page)).toBeVisible();
  await expect(page.locator('.save-status')).toHaveText('Saved');
}

// Keep the current caret position so this also inserts inside toggle bodies.
async function insertBlock(page: Page, query: string, name: string) {
  await page.keyboard.insertText('/' + query);
  const menu = page.getByRole('toolbar', { name: 'Insert block' });
  await expect(menu).toBeVisible();
  await menu.getByRole('button', { name, exact: true }).click();
  await expect(menu).toBeHidden();
}

async function expectCaretIn(node: Locator) {
  await expect
    .poll(() =>
      node.evaluate((element) => {
        const selection = window.getSelection();
        return !!(
          selection?.isCollapsed &&
          selection.anchorNode &&
          element.contains(selection.anchorNode)
        );
      }),
    )
    .toBe(true);
}

test.beforeEach(async ({ page, request }, testInfo) => {
  await login(page, await provision(request));
  await create(page, `Toggle ${testInfo.project.name} ${crypto.randomUUID()}`);
  await editorFor(page).click();
});

for (const level of [0, 3]) {
  for (const afterText of [false, true]) {
    const name = level ? `heading toggle ${level}` : 'plain toggle';
    test(`Backspace unwraps an empty ${name} ${afterText ? 'after text' : 'as the first block'}, with undo and redo`, async ({
      page,
    }) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const editor = editorFor(page);
      if (afterText) {
        await page.keyboard.insertText('Keep this paragraph');
        await page.keyboard.press('Enter');
      }
      await insertBlock(
        page,
        level ? `heading toggle ${level}` : 'toggle',
        level ? `Heading toggle ${level}` : 'Toggle',
      );
      const toggle = editor.locator('.toggle-block');
      await expect(toggle).toHaveAttribute('data-level', String(level));
      await expect(toggle).toHaveAttribute('data-open', 'false');
      await expect(toggle.locator('.toggle-summary')).toHaveText('');
      await expect(toggle.locator('.toggle-body > p')).toHaveText('');
      await expectCaretIn(toggle.locator('.toggle-summary'));
      const originalParagraphs = await editor
        .locator(':scope > p')
        .allTextContents();
      const expectedParagraphs = [...originalParagraphs];
      expectedParagraphs.splice(afterText ? 1 : 0, 0, '');

      await page.keyboard.press('Backspace');
      await expect(toggle).toHaveCount(0);
      await expect(editor.locator(':scope > p')).toHaveText(expectedParagraphs);
      await expectCaretIn(editor.locator(':scope > p').nth(afterText ? 1 : 0));

      // A single undo must restore the whole toggle, not an invalid half-node.
      await page.keyboard.press('ControlOrMeta+z');
      await expect(toggle).toHaveCount(1);
      await expect(toggle).toHaveAttribute('data-level', String(level));
      await expect(toggle.locator('.toggle-summary')).toHaveText('');
      await expect(toggle.locator('.toggle-body > p')).toHaveText('');
      await expect(editor.locator(':scope > p')).toHaveText(originalParagraphs);
      if (level) {
        await expect(toggle.locator('.toggle-summary')).toHaveAttribute(
          'aria-level',
          String(level),
        );
      }

      await page.keyboard.press('ControlOrMeta+Shift+z');
      await expect(toggle).toHaveCount(0);
      await expect(editor.locator(':scope > p')).toHaveText(expectedParagraphs);
      const replacement = editor.locator(':scope > p').nth(afterText ? 1 : 0);
      await expectCaretIn(replacement);
      await page.keyboard.insertText('Replacement text');
      await expect(replacement).toHaveText('Replacement text');
      if (afterText) {
        await expect(editor.locator(':scope > p').first()).toHaveText(
          'Keep this paragraph',
        );
      }
      await expect(page.locator('.save-status')).toHaveText('Saved');
      await page.reload();
      await expect(editor.locator('.toggle-block')).toHaveCount(0);
      await expect(
        editor.locator(':scope > p').nth(afterText ? 1 : 0),
      ).toHaveText('Replacement text');
      expect(errors).toEqual([]);
    });
  }
}

test('Backspace unwraps an empty nested toggle without changing its parent', async ({
  page,
}) => {
  const editor = editorFor(page);
  await insertBlock(page, 'toggle', 'Toggle');
  await page.keyboard.insertText('Outer summary');
  await page.keyboard.press('Enter');
  const outer = editor.locator(':scope > .toggle-block');
  const body = outer.locator(':scope > .toggle-inner > .toggle-body');
  await expect(body).toBeVisible();
  await insertBlock(page, 'heading toggle 2', 'Heading toggle 2');
  const nested = body.locator('.toggle-block');
  await expect(nested).toHaveCount(1);
  await expect(nested).toHaveAttribute('data-level', '2');
  await expectCaretIn(nested.locator('.toggle-summary'));
  const originalParagraphCount = await body.locator(':scope > p').count();

  await page.keyboard.press('Backspace');
  await expect(nested).toHaveCount(0);
  await expect(body.locator(':scope > p')).toHaveCount(
    originalParagraphCount + 1,
  );
  await expect(
    outer.locator(':scope > .toggle-inner > .toggle-summary'),
  ).toHaveText('Outer summary');
  await expectCaretIn(body.locator(':scope > p').first());

  await page.keyboard.press('ControlOrMeta+z');
  await expect(nested).toHaveCount(1);
  await expect(nested).toHaveAttribute('data-level', '2');
  await expect(nested.locator('.toggle-summary')).toHaveText('');
  await expect(nested.locator('.toggle-body > p')).toHaveText('');
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(nested).toHaveCount(0);
  await expectCaretIn(body.locator(':scope > p').first());
  await page.keyboard.insertText('Nested replacement');
  await expect(body.locator(':scope > p').first()).toHaveText(
    'Nested replacement',
  );
  await expect(
    outer.locator(':scope > .toggle-inner > .toggle-summary'),
  ).toHaveText('Outer summary');
});

test('Backspace deletes summary characters normally before unwrapping the empty toggle', async ({
  page,
}) => {
  const editor = editorFor(page);
  await insertBlock(page, 'toggle', 'Toggle');
  await page.keyboard.insertText('AB');
  const toggle = editor.locator('.toggle-block');
  const summary = toggle.locator('.toggle-summary');
  await page.keyboard.press('Backspace');
  await expect(summary).toHaveText('A');
  await expect(toggle).toHaveCount(1);
  await page.keyboard.press('Backspace');
  await expect(summary).toHaveText('');
  await expect(toggle).toHaveCount(1);
  await page.keyboard.press('Backspace');
  await expect(toggle).toHaveCount(0);
  await expectCaretIn(editor.locator(':scope > p').first());
});

for (const hiddenContent of ['text', 'nested toggle', 'image'] as const) {
  test(`Backspace preserves an empty summary with a collapsed ${hiddenContent} body`, async ({
    page,
  }) => {
    const editor = editorFor(page);
    await insertBlock(page, 'toggle', 'Toggle');
    const outer = editor.locator(':scope > .toggle-block');
    const summary = outer.locator(':scope > .toggle-inner > .toggle-summary');
    const body = outer.locator(':scope > .toggle-inner > .toggle-body');
    await page.keyboard.press('Enter');
    await expect(body).toBeVisible();
    if (hiddenContent === 'text') {
      await page.keyboard.insertText('Hidden content must survive');
    } else if (hiddenContent === 'nested toggle') {
      await insertBlock(page, 'toggle', 'Toggle');
      await expect(body.locator('.toggle-block')).toHaveCount(1);
      await expect(body).toHaveText('');
    } else {
      const imageURL = new URL('/toggle-keyboard-pixel.png', page.url()).href;
      await page.route(imageURL, (route) =>
        route.fulfill({
          contentType: 'image/png',
          body: Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=',
            'base64',
          ),
        }),
      );
      await insertBlock(page, 'image', 'Image');
      const form = page.getByRole('form', { name: 'Insert image' });
      await form.getByLabel('Image URL', { exact: true }).fill(imageURL);
      await form.getByLabel('Image description').fill('Hidden test pixel');
      await form.getByRole('button', { name: 'Insert', exact: true }).click();
      await expect(body.locator('img')).toHaveAttribute('src', imageURL);
      await expect(body).toHaveText('');
    }

    // The empty summary does not imply an empty body: non-text blocks count too.
    await outer.locator(':scope > .toggle-disclosure').click();
    await expect(body).toBeHidden();
    await expect(summary).toHaveText('');
    const contentBefore = await body.innerHTML();
    await summary.click();
    await expectCaretIn(summary);
    await page.keyboard.press('Backspace');
    await expect(outer).toHaveCount(1);
    await expect(summary).toHaveText('');
    await expect(body).toBeHidden();
    expect(await body.innerHTML()).toBe(contentBefore);

    await page.keyboard.insertText('Still editable');
    await expect(summary).toHaveText('Still editable');
    await outer.locator(':scope > .toggle-disclosure').click();
    await expect(body).toBeVisible();
    if (hiddenContent === 'text') {
      await expect(body).toHaveText('Hidden content must survive');
    } else if (hiddenContent === 'nested toggle') {
      await expect(body.locator('.toggle-block')).toHaveCount(1);
      await expect(body.locator('.toggle-summary')).toHaveText('');
      await expect(body.locator('.toggle-body > p')).toHaveText('');
    } else {
      await expect(
        body.getByRole('img', { name: 'Hidden test pixel' }),
      ).toBeVisible();
    }
  });
}
