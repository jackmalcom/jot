import { setTimeout } from 'node:timers/promises';
import { test, expect, type APIRequestContext } from '@playwright/test';

export const password = 'browser-test-password-123';

export async function operator(
  request: APIRequestContext,
  data: Record<string, string>,
) {
  const options = {
    headers: { authorization: 'Bearer browser-operator-test-secret' },
    data,
  };
  // Pace every call, including the first in a new worker or project, to stay
  // below the shared 30-attempt/minute limit without retrying server errors.
  await setTimeout(2100);
  let response = await request.post('/api/operator', options);
  if (response.status() !== 429) return response;

  // All browser projects share the operator's 30-attempt/minute limit.
  // Allow one reset window only when throttled; other failures are not retried.
  const resetWindow = 65000;
  test.setTimeout(test.info().timeout + resetWindow);
  const deadline = performance.now() + resetWindow;
  while (response.status() === 429) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    await setTimeout(Math.min(1000, remaining));
    const timeout = Math.floor(deadline - performance.now());
    if (timeout <= 0) break;
    response = await request.post('/api/operator', { ...options, timeout });
  }
  return response;
}

export async function provision(request: APIRequestContext, name: string) {
  const prefix = name.toLowerCase().replaceAll(' ', '-');
  const email = `${prefix}-${crypto.randomUUID()}@example.com`;
  const response = await operator(request, {
    action: 'create',
    name,
    email,
    password,
  });
  expect(response.status(), await response.text()).toBe(200);
  return email;
}
