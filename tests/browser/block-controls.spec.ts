import {
  test,
  expect,
  type Page,
  type APIRequestContext,
  type Locator,
} from '@playwright/test';

async function openEditor(page: Page, request: APIRequestContext) {
  const email = `controls-${crypto.randomUUID()}@example.com`;
  const password = 'browser-test-password-123';
  const response = await request.post('/api/operator', {
    headers: { authorization: 'Bearer browser-operator-test-secret' },
    data: { action: 'create', name: 'Controls', email, password },
  });
  expect(response.status(), await response.text()).toBe(200);
  await page.goto('/');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('.app-shell')).toBeVisible();
  const menu = page.getByRole('button', {
    name: 'Open navigation',
    exact: true,
  });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('button', { name: 'Create page', exact: true }).click();
  await page.getByLabel('Page title', { exact: true }).fill('Block controls');
  await page
    .getByRole('button', { name: 'Create page', exact: true })
    .last()
    .click();
  const editor = page.getByRole('textbox', { name: 'Page content' });
  await expect(editor).toBeVisible();
  await expect(page.locator('.save-status')).toHaveText('Saved');
  return { editor, email };
}

async function firstLineCenter(locator: Locator) {
  return locator.evaluate((el) => {
    const style = getComputedStyle(el);
    return (
      el.getBoundingClientRect().top +
      parseFloat(style.borderTopWidth) +
      parseFloat(style.paddingTop) +
      parseFloat(style.lineHeight) / 2
    );
  });
}

async function centerY(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return box!.y + box!.height / 2;
}

async function expectBlockText(blocks: Locator, expected: string[]) {
  // Presence labels are DOM decorations, not saved document text. Strip only
  // those widgets from a clone, preserving exact assertions for the content.
  await expect
    .poll(() =>
      blocks.evaluateAll((elements) =>
        elements.map((element) => {
          const clone = element.cloneNode(true) as HTMLElement;
          clone
            .querySelectorAll('.collaboration-carets__caret')
            .forEach((caret) => caret.remove());
          return clone.textContent;
        }),
      ),
    )
    .toEqual(expected);
}

test('toggle controls align with the first summary line at every heading level', async ({
  page,
  request,
}, testInfo) => {
  const { editor } = await openEditor(page, request);
  for (let level = 0; level <= 6; level++) {
    await editor.locator(':scope > p').last().click();
    await page.keyboard.insertText(
      level ? '/heading toggle ' + level : '/toggle',
    );
    await page.keyboard.press('Enter');
    const toggle = editor.locator(`.toggle-block[data-level="${level}"]`);
    const summary = toggle.locator(':scope > .toggle-inner > .toggle-summary');
    const disclosure = toggle.locator(':scope > .toggle-disclosure');
    const icon = disclosure.locator('.toggle-disclosure-icon');
    await page.keyboard.insertText(`Level ${level} summary`);
    await expect(summary).toHaveText(`Level ${level} summary`);
    await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    expect(
      Math.abs((await centerY(icon)) - (await firstLineCenter(summary))),
    ).toBeLessThan(1);
    if (level) {
      await expect(summary).toHaveAttribute('role', 'heading');
      await expect(summary).toHaveAttribute('aria-level', String(level));
    }
    await expect(editor).toHaveAttribute('spellcheck', 'true');
    expect(await summary.evaluate((el: HTMLElement) => el.spellcheck)).toBe(
      true,
    );
    await expect(disclosure).toHaveAttribute('spellcheck', 'false');
    await expect(icon).toHaveAttribute('aria-hidden', 'true');
    await expect(disclosure).toHaveText('');

    // Long summaries still align their controls to the first line.
    await page.keyboard.insertText(
      ' with enough words to wrap across several lines '.repeat(4),
    );
    await summary.scrollIntoViewIfNeeded();
    expect(
      Math.abs((await centerY(icon)) - (await firstLineCenter(summary))),
    ).toBeLessThan(1);
    if (testInfo.project.name !== 'mobile') {
      const box = await summary.boundingBox();
      await page.mouse.move(box!.x + 12, await firstLineCenter(summary));
      const handle = page.getByRole('button', {
        name: 'Block actions',
        exact: true,
      });
      await expect(handle).toHaveCSS('opacity', '1');
      expect(
        Math.abs((await centerY(handle)) - (await firstLineCenter(summary))),
      ).toBeLessThan(1);
    }

    const before = await disclosure.boundingBox();
    await disclosure.click();
    await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    await expect(disclosure).toHaveCSS('transform', 'none');
    await expect(icon).toHaveCSS('transform', 'matrix(0, 1, -1, 0, 0, 0)');
    const after = await disclosure.boundingBox();
    expect(after!.width).toBeCloseTo(before!.width, 1);
    expect(after!.height).toBeCloseTo(before!.height, 1);
    await disclosure.click();
    await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    await expect(icon).toHaveCSS('transform', 'none');
  }
  await page.emulateMedia({ colorScheme: 'dark' });
  await editor
    .locator('.toggle-block[data-level="4"]')
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath('heading-toggle-controls.png'),
  });
});

test('block actions remain reachable across the gutter and align with paragraph and heading text', async ({
  page,
  request,
}, testInfo) => {
  test.skip(
    testInfo.project.name === 'mobile',
    'Mouse traversal is a desktop interaction',
  );
  const { editor } = await openEditor(page, request);
  await editor.click();
  await page.keyboard.insertText('First paragraph');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('Second paragraph');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('/h1');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('Third block heading');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('/todo');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('Fourth block task');
  // Keep the selection elsewhere while targeting a later block with the mouse.
  await editor.locator('p').first().click();
  const handle = page.getByRole('button', {
    name: 'Block actions',
    exact: true,
  });
  for (const block of [
    editor.locator('p').filter({ hasText: 'Second paragraph' }),
    editor.locator('h1'),
    editor.locator('li p'),
  ]) {
    await block.scrollIntoViewIfNeeded();
    const bounds = await block.boundingBox();
    const center = await firstLineCenter(block);
    await page.mouse.move(bounds!.x + Math.min(bounds!.width / 2, 100), center);
    await expect(handle).toHaveCSS('opacity', '1');
    expect(Math.abs((await centerY(handle)) - center)).toBeLessThan(1);
    const target = await handle.boundingBox();
    for (let x = bounds!.x + 24; x >= target!.x + target!.width / 2; x -= 2) {
      await page.mouse.move(x, center);
      await expect(handle).toHaveCSS('opacity', '1');
      expect(Math.abs((await centerY(handle)) - center)).toBeLessThan(1);
    }
    await page.mouse.click(target!.x + target!.width / 2, center);
    await expect(
      page.getByRole('menu', { name: 'Block actions', exact: true }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(
      page.getByRole('menu', { name: 'Block actions', exact: true }),
    ).toBeHidden();
  }
  const second = editor.locator('p').filter({ hasText: 'Second paragraph' });
  await second.hover();
  await handle.click();
  await page
    .getByRole('menuitem', { name: 'Delete block', exact: true })
    .click();
  await expect(editor).not.toContainText('Second paragraph');
  await expect(editor).toContainText('First paragraph');
  await expect(editor).toContainText('Third block heading');
});

test('block actions keep their hovered target through collaborative updates', async ({
  page,
  request,
  browser,
  baseURL,
}, testInfo) => {
  test.skip(
    testInfo.project.name === 'mobile',
    'Mouse targeting is a desktop interaction',
  );
  const { editor, email } = await openEditor(page, request);
  await editor.fill('First paragraph');
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('Hovered second paragraph');
  await expect(page.locator('.save-status')).toHaveText('Saved');
  const context = await browser.newContext({ baseURL });
  try {
    const other = await context.newPage();
    await other.goto('/');
    await other.getByLabel('Email', { exact: true }).fill(email);
    await other
      .getByLabel('Password', { exact: true })
      .fill('browser-test-password-123');
    await other.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(other.locator('.app-shell')).toBeVisible();
    await other.goto(page.url());
    const otherEditor = other.getByRole('textbox', { name: 'Page content' });
    await expect(otherEditor).toContainText('Hovered second paragraph');
    await editor.locator('p').first().click();
    const target = editor
      .locator('p')
      .filter({ hasText: 'Hovered second paragraph' });
    await target.hover();
    const handle = page.getByRole('button', {
      name: 'Block actions',
      exact: true,
    });
    await expect(handle).toHaveCSS('opacity', '1');
    const otherFirst = otherEditor.locator('p').first();
    await otherFirst.click();
    await other.keyboard.press('Home');
    await other.keyboard.insertText('Remote ');
    await expectBlockText(editor.locator('p').first(), [
      'Remote First paragraph',
    ]);
    expect(
      Math.abs((await centerY(handle)) - (await firstLineCenter(target))),
    ).toBeLessThan(1);
    await handle.click();
    await page
      .getByRole('menuitem', { name: 'Delete block', exact: true })
      .click();
    await expect(editor).not.toContainText('Hovered second paragraph');
    await expectBlockText(editor.locator('p').first(), [
      'Remote First paragraph',
    ]);
  } finally {
    await context.close();
  }
});

test('remote deletion closes block actions without retargeting an identical neighbor', async ({
  page,
  request,
  browser,
  baseURL,
}, testInfo) => {
  test.skip(
    testInfo.project.name === 'mobile',
    'Mouse targeting is a desktop interaction',
  );
  const { editor, email } = await openEditor(page, request);
  await editor.fill('First paragraph');
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('Same paragraph');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('Same paragraph');
  await expect(page.locator('.save-status')).toHaveText('Saved');
  const context = await browser.newContext({ baseURL });
  try {
    const other = await context.newPage();
    await other.goto('/');
    await other.getByLabel('Email', { exact: true }).fill(email);
    await other
      .getByLabel('Password', { exact: true })
      .fill('browser-test-password-123');
    await other.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(other.locator('.app-shell')).toBeVisible();
    await other.goto(page.url());
    const otherEditor = other.getByRole('textbox', { name: 'Page content' });
    await expect(otherEditor.locator('p')).toHaveCount(3);
    await editor.locator('p').first().click();
    await editor.locator('p').nth(1).hover();
    await page
      .getByRole('button', { name: 'Block actions', exact: true })
      .click();
    const actions = page.getByRole('menu', {
      name: 'Block actions',
      exact: true,
    });
    await expect(actions).toBeVisible();
    await otherEditor.locator('p').nth(1).hover();
    await other
      .getByRole('button', { name: 'Block actions', exact: true })
      .click();
    await other
      .getByRole('menuitem', { name: 'Delete block', exact: true })
      .click();
    await expectBlockText(editor.locator('p'), [
      'First paragraph',
      'Same paragraph',
    ]);
    await expect(actions).toBeHidden();
    await expect(
      page.getByRole('button', { name: 'Block actions', exact: true }),
    ).toHaveCount(0);
    // More presence/document updates must not revive a different target until
    // this reader intentionally points at or edits a block again.
    await otherEditor.locator('p').first().click();
    await other.keyboard.press('Home');
    await other.keyboard.insertText('Remote ');
    await expectBlockText(editor.locator('p').first(), [
      'Remote First paragraph',
    ]);
    await expect(
      page.getByRole('button', { name: 'Block actions', exact: true }),
    ).toHaveCount(0);
    await editor.locator('p').last().hover();
    await page
      .getByRole('button', { name: 'Block actions', exact: true })
      .click();
    await expect(actions).toBeVisible();
  } finally {
    await context.close();
  }
});
