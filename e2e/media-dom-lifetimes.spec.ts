import { expect, test } from '@playwright/test';
import { gzipSync } from 'node:zlib';

test('avatar observation survives parent updates and is released on removal', async ({ page }) => {
  await page.goto('/e2e/fixtures/index.html');
  const result = await page.evaluate(async () => {
    const path = '/src/ui/testing/mediaLifetimeFixture.ts';
    const { mountAvatarLifetimeFixture } = (await import(
      path
    )) as typeof import('../src/ui/testing/mediaLifetimeFixture');
    let observations = 0;
    let disconnections = 0;
    const NativeObserver = window.IntersectionObserver;
    window.IntersectionObserver = class extends NativeObserver {
      override observe(element: Element) {
        observations++;
        super.observe(element);
      }
      override disconnect() {
        disconnections++;
        super.disconnect();
      }
    };
    const fixture = mountAvatarLifetimeFixture(document.body);
    const first = document.querySelector('[data-avatar-identity]');
    for (let index = 0; index < 10; index++) {
      fixture.patch({ initials: String(index) });
      await new Promise(requestAnimationFrame);
    }
    const preserved = first === document.querySelector('[data-avatar-identity]');
    const beforeClose = { observations, disconnections };
    await fixture.close();
    return { preserved, beforeClose, disconnections, removed: !first?.isConnected };
  });
  expect(result).toEqual({
    preserved: true,
    beforeClose: { observations: 1, disconnections: 0 },
    disconnections: 1,
    removed: true,
  });
});

test('TGS animation owns one fetch per source across label updates', async ({ page }) => {
  const requests: string[] = [];
  const animation = gzipSync(
    JSON.stringify({ v: '5.7.4', fr: 30, ip: 0, op: 30, w: 16, h: 16, layers: [], assets: [] }),
  );
  await page.route('**/lifetime-*.tgs', async (route) => {
    requests.push(new URL(route.request().url()).pathname);
    await route.fulfill({ contentType: 'application/gzip', body: animation });
  });
  await page.goto('/e2e/fixtures/index.html');
  const result = await page.evaluate(async () => {
    const path = '/src/ui/testing/mediaLifetimeFixture.ts';
    const { mountTgsLifetimeFixture } = (await import(
      path
    )) as typeof import('../src/ui/testing/mediaLifetimeFixture');
    const fixture = mountTgsLifetimeFixture(document.body);
    const ready = async () => {
      for (let index = 0; index < 300; index++) {
        if (document.querySelector('.tgs-player svg')) return;
        await new Promise(requestAnimationFrame);
      }
      throw new Error('Animation did not render');
    };
    await ready();
    const first = document.querySelector('.tgs-player svg');
    for (let index = 0; index < 5; index++) {
      fixture.patch({ label: `Animation ${index}` });
      await new Promise(requestAnimationFrame);
    }
    const preserved = first === document.querySelector('.tgs-player svg');
    fixture.patch({ source: '/lifetime-second.tgs' });
    await ready();
    const replaced = first !== document.querySelector('.tgs-player svg') && !first?.isConnected;
    await fixture.close();
    return { preserved, replaced, remaining: document.querySelectorAll('.tgs-player').length };
  });
  expect(result).toEqual({ preserved: true, replaced: true, remaining: 0 });
  expect(requests).toEqual(['/lifetime-first.tgs', '/lifetime-second.tgs']);
});

test('image editing retains its object URL until the file changes or the editor closes', async ({
  page,
}) => {
  await page.goto('/e2e/fixtures/index.html');
  const result = await page.evaluate(async () => {
    const path = '/src/ui/testing/mediaLifetimeFixture.ts';
    const { mountImageLifetimeFixture } = (await import(
      path
    )) as typeof import('../src/ui/testing/mediaLifetimeFixture');
    const created: string[] = [];
    const revoked: string[] = [];
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (value) => {
      const url = create(value);
      created.push(url);
      return url;
    };
    URL.revokeObjectURL = (url) => {
      revoked.push(url);
      revoke(url);
    };
    const fixture = mountImageLifetimeFixture(document.body);
    const first = document.querySelector<HTMLImageElement>('.image-editor-preview img')!;
    for (let index = 0; index < 5; index++) {
      document.querySelector<HTMLButtonElement>('[aria-label="Rotate right"]')!.click();
      await new Promise(requestAnimationFrame);
    }
    const edited = {
      created: created.length,
      revoked: revoked.length,
      sameSource: first.src === created[0],
    };
    fixture.replace();
    await new Promise(requestAnimationFrame);
    const replaced = {
      created: created.length,
      revoked: revoked.length,
      sameElement: first === document.querySelector('.image-editor-preview img'),
      source: first.src === created[1],
    };
    await fixture.close();
    return { edited, replaced, allReleased: JSON.stringify(created) === JSON.stringify(revoked) };
  });
  expect(result).toEqual({
    edited: { created: 1, revoked: 0, sameSource: true },
    replaced: { created: 2, revoked: 1, sameElement: true, source: true },
    allReleased: true,
  });
});

test('unrelated video props preserve playback and stopping hover pauses once', async ({ page }) => {
  await page.route('**/lifetime-*', (route) => route.fulfill({ status: 204 }));
  await page.goto('/e2e/fixtures/index.html');
  const result = await page.evaluate(async () => {
    const path = '/src/ui/testing/mediaLifetimeFixture.ts';
    const { mountVideoLifetimeFixture } = (await import(
      path
    )) as typeof import('../src/ui/testing/mediaLifetimeFixture');
    let plays = 0;
    let pauses = 0;
    HTMLMediaElement.prototype.play = () => {
      plays++;
      return Promise.resolve();
    };
    HTMLMediaElement.prototype.pause = () => {
      pauses++;
    };
    const fixture = mountVideoLifetimeFixture(document.body);
    await new Promise(requestAnimationFrame);
    const visual = document.querySelector('.media-visual')!;
    visual.dispatchEvent(new PointerEvent('pointerenter'));
    // Playback now waits for the asynchronous source, rather than calling play()
    // on an empty video element and losing the hover request.
    for (let index = 0; index < 300 && plays === 0; index++) {
      await new Promise(requestAnimationFrame);
    }
    const before = { plays, pauses };
    for (let index = 0; index < 5; index++) {
      fixture.patch({ compact: index % 2 === 0 });
      await new Promise(requestAnimationFrame);
    }
    const after = { plays, pauses };
    visual.dispatchEvent(new PointerEvent('pointerleave'));
    await new Promise(requestAnimationFrame);
    const stopped = { plays, pauses };
    await fixture.close();
    return { before, after, stopped, closed: { plays, pauses } };
  });
  expect(result).toEqual({
    before: { plays: 1, pauses: 1 },
    after: { plays: 1, pauses: 1 },
    stopped: { plays: 1, pauses: 2 },
    closed: { plays: 1, pauses: 3 },
  });
});
