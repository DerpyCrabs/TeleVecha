// Run against two production builds made with VITE_TELEVECHA_E2E=1.
// node scripts/benchmark-ui.mjs BASELINE_DIST EXPERIMENT_DIST OUTPUT_JSON [PAIRS=3] [FIRST_ROUND=1]
import { createServer } from 'node:http';
import { cpus, totalmem } from 'node:os';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { chromium } from '@playwright/test';

const [baselineDir, experimentDir, output, pairs = '3', firstRound = '1'] = process.argv.slice(2);
if (!baselineDir || !experimentDir || !output) throw new Error('Missing build paths or output');
if (![pairs, firstRound].every((value) => Number.isSafeInteger(Number(value)) && Number(value) > 0))
  throw new Error('Pair count and first round must be positive integers');
const results = [];
const mime = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};
async function serve(directory) {
  const root = resolve(directory);
  const server = createServer(async (request, response) => {
    const path = resolve(root, `.${new URL(request.url, 'http://localhost').pathname}`);
    if (path !== root && !path.startsWith(root + sep)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const file = path === root || path.endsWith(sep) ? resolve(root, 'index.html') : path;
      response.setHeader('Content-Type', mime[extname(file)] ?? 'application/octet-stream');
      response.end(await readFile(file));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}
const servers = { baseline: await serve(baselineDir), experiment: await serve(experimentDir) };
const browser = await chromium.launch({ headless: true });
const metadata = {
  browser: browser.version(),
  node: process.version,
  platform: process.platform,
  cpu: cpus()[0]?.model,
  totalMemoryGB: totalmem() / 1073741824,
  firstRound: Number(firstRound),
  pairs: Number(pairs),
  baselineDir,
  experimentDir,
  startedAt: new Date().toISOString(),
};

async function run(label, round) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  const metrics = async () =>
    Object.fromEntries(
      (await cdp.send('Performance.getMetrics')).metrics.map(({ name, value }) => [name, value]),
    );
  const memory = async () => {
    await cdp.send('HeapProfiler.collectGarbage');
    const m = await metrics();
    return { heapMB: m.JSHeapUsedSize / 1048576, ...(await cdp.send('Memory.getDOMCounters')) };
  };
  await page.goto(`${servers[label].url}/?scenario=long-history`);
  await page.waitForFunction(() => {
    const s = [...(window.__televechaRuntimes?.values() ?? [])][0]?.engine.snapshot();
    return s?.phase === 'ready' && s.online;
  });
  await page.evaluate(() => {
    window.__bench = {
      pts: 11,
      frame: () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
      button: (name) =>
        [...document.querySelectorAll('button')].find(
          (el) => el.getAttribute('aria-label') === name,
        ),
      chat: (name) =>
        [...document.querySelectorAll('[data-testid="chat-list"] [role="button"]')].find((el) =>
          el.textContent.includes(name),
        ),
      async measure(action, ready) {
        const scroller = document.querySelector('[data-testid="message-scroller"]');
        const old = new Map(
          [...document.querySelectorAll('article[data-message-id]')].map((el) => [
            el.dataset.messageId,
            el,
          ]),
        );
        let mutations = 0,
          added = 0,
          removed = 0;
        const observer = new MutationObserver((records) => {
          for (const record of records) {
            mutations++;
            added += record.addedNodes.length;
            removed += record.removedNodes.length;
          }
        });
        if (scroller)
          observer.observe(scroller, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
          });
        const start = performance.now();
        const domMs = await new Promise((done, reject) => {
          let timer;
          const check = () => {
            if (!ready()) return;
            watcher.disconnect();
            clearTimeout(timer);
            done(performance.now() - start);
          };
          const watcher = new MutationObserver(check);
          watcher.observe(document.body, {
            subtree: true,
            childList: true,
            characterData: true,
            attributes: true,
          });
          timer = setTimeout(() => {
            watcher.disconnect();
            reject(new Error('Benchmark action timed out'));
          }, 15000);
          action();
          check();
        });
        await this.frame();
        observer.disconnect();
        let retained = 0,
          replaced = 0,
          absent = 0;
        const currentNodes = new Map(
          [...document.querySelectorAll('article[data-message-id]')].map((el) => [
            el.dataset.messageId,
            el,
          ]),
        );
        for (const [id, el] of old) {
          const current = currentNodes.get(id);
          if (!current) absent++;
          else if (el === current) retained++;
          else replaced++;
        }
        return {
          domMs,
          settledMs: performance.now() - start,
          mutations,
          added,
          removed,
          retained,
          replaced,
          absent,
        };
      },
    };
  });
  const workloads = {};
  async function sample(name, callback, argument) {
    const before = await metrics();
    const data = await page.evaluate(callback, argument);
    const after = await metrics();
    const row = {
      ...data,
      taskMs: (after.TaskDuration - before.TaskDuration) * 1000,
      scriptMs: (after.ScriptDuration - before.ScriptDuration) * 1000,
      layoutMs: (after.LayoutDuration - before.LayoutDuration) * 1000,
    };
    (workloads[name] ??= []).push(row);
    return row;
  }
  const switchTo = async (name, text, workload = 'switch') =>
    sample(
      workload,
      async ({ name, text }) =>
        window.__bench.measure(
          () => window.__bench.chat(name).click(),
          () =>
            document.querySelector('[data-testid="message-scroller"]')?.textContent.includes(text),
        ),
      { name, text },
    );
  await page
    .getByTestId('chat-list')
    .getByRole('button', { name: /Long History/ })
    .waitFor();
  await switchTo('Long History', 'Long history message 1000', 'openLarge');
  await page.waitForTimeout(200);
  for (let count = 100; count <= 1000; count += 50) {
    await sample(
      'historyPage',
      async (count) =>
        window.__bench.measure(
          () => {
            const el = document.querySelector('[data-testid="message-scroller"]');
            el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -1 }));
            el.scrollTop = 0;
          },
          () => document.querySelectorAll('article.message').length >= count,
        ),
      count,
    );
  }
  await page.evaluate(async () => {
    const el = document.querySelector('[data-testid="message-scroller"]');
    el.scrollTop = el.scrollHeight;
    await window.__bench.frame();
  });
  await page.waitForTimeout(200);
  process.stdout.write(`${label} round ${round}: loaded 1000 messages\n`);
  const largeMemory = await memory();
  for (let i = 0; i < 20; i++) {
    await sample(
      'edit1000',
      async (i) => {
        const b = window.__bench,
          text = `Benchmark edited message ${i}`;
        return b.measure(
          () =>
            b &&
            window.__televechaFixture.emit({
              type: 'edit-message',
              pts: b.pts++,
              ptsCount: 1,
              message: {
                id: 1000,
                peerId: 'u:505',
                senderId: 'u:505',
                text,
                date: 1700001000,
                outgoing: false,
                editedAt: 1700002000 + i,
              },
            }),
          () =>
            document.querySelector('article[data-message-id="1000"]')?.textContent.includes(text),
        );
      },
      i,
    );
  }
  for (let i = 0; i < 10; i++) {
    await sample(
      'burst20',
      async (i) => {
        const b = window.__bench,
          last = 1020 + i * 20;
        return b.measure(
          () => {
            for (let id = last - 19; id <= last; id++)
              window.__televechaFixture.emit({
                type: 'new-message',
                pts: b.pts++,
                ptsCount: 1,
                message: {
                  id,
                  peerId: 'u:505',
                  senderId: 'u:505',
                  text: `Benchmark incoming ${id}`,
                  date: 1700003000 + id,
                  outgoing: false,
                },
              });
          },
          () => !!document.querySelector(`article[data-message-id="${last}"]`),
        );
      },
      i,
    );
  }
  for (let i = 0; i < 10; i++) {
    await sample(
      'inactiveUpdate',
      async (i) => {
        const b = window.__bench,
          text = `Benchmark background ${i}`;
        return b.measure(
          () =>
            window.__televechaFixture.emit({
              type: 'new-message',
              pts: b.pts++,
              ptsCount: 1,
              message: {
                id: 2000 + i,
                peerId: 'g:303',
                senderId: 'u:404',
                text,
                date: 1700005000 + i,
                outgoing: false,
              },
            }),
          () => b.chat('Fixture Group')?.textContent.includes(text),
        );
      },
      i,
    );
  }
  process.stdout.write(`${label} round ${round}: edits and bursts finished\n`);
  const largeFinalMemory = await memory();
  // Warm both chats before measuring repeated navigation and cache hits.
  await switchTo('Alice Fixture', 'Newest message from fixture', 'warmSwitch');
  await switchTo('Release Channel', 'Release notes are ready', 'warmSwitch');
  await switchTo('Alice Fixture', 'Newest message from fixture', 'warmSwitch');
  await page.waitForFunction(() => document.querySelector('button[aria-label="Search messages"]'));
  const memorySeries = [{ cycle: 0, ...(await memory()) }];
  const statsBefore = await page.evaluate(() => ({ ...window.__televechaFixture.stats }));
  for (let cycle = 1; cycle <= 20; cycle++) {
    await switchTo('Release Channel', 'Release notes are ready');
    await switchTo('Alice Fixture', 'Newest message from fixture');
    await page
      .getByRole('button', { name: 'Search messages', exact: true })
      .evaluate((el) => el.click());
    await page.getByRole('textbox', { name: 'Message search query' }).fill('fixture');
    await sample('search', async () =>
      window.__bench.measure(
        () =>
          document.querySelector('input[aria-label="Message search query"]').form.requestSubmit(),
        () => !!document.querySelector('.search-results button'),
      ),
    );
    await page
      .getByRole('button', { name: 'Close search', exact: true })
      .evaluate((el) => el.click());
    const photos = page.getByRole('button', { name: /^Photos/ });
    await photos.waitFor();
    await sample('sharedMedia', async () =>
      window.__bench.measure(
        () =>
          [...document.querySelectorAll('button')]
            .find((el) => el.textContent.trim().startsWith('Photos'))
            .click(),
        () => !!document.querySelector('[aria-label="Shared photos"] .shared-media-tile img'),
      ),
    );
    await page
      .getByRole('button', { name: 'Close shared photos', exact: true })
      .evaluate((el) => el.click());
    if ([5, 10, 20].includes(cycle)) memorySeries.push({ cycle, ...(await memory()) });
  }
  const statsAfter = await page.evaluate(() => ({ ...window.__televechaFixture.stats }));
  // Effect's 30-second TTL uses 15-second sweep buckets; sample beyond 45 seconds.
  process.stdout.write(`${label} round ${round}: navigation finished, waiting for cache expiry\n`);
  await page.waitForTimeout(35000);
  memorySeries.push({ cycle: '20 + 35s idle', ...(await memory()) });
  await page.waitForTimeout(15000);
  memorySeries.push({ cycle: '20 + 50s idle', ...(await memory()) });
  const result = {
    label,
    round,
    workloads,
    largeMemory,
    largeFinalMemory,
    memorySeries,
    statsBefore,
    statsAfter,
    errors,
  };
  results.push(result);
  await writeFile(output, JSON.stringify({ metadata, results }, null, 2) + '\n');
  process.stdout.write(
    `${label} round ${round}: edits median ${median(workloads.edit1000.map((x) => x.taskMs)).toFixed(1)}ms CPU, burst median ${median(workloads.burst20.map((x) => x.taskMs)).toFixed(1)}ms CPU, heap ${largeMemory.heapMB.toFixed(1)}MB, errors ${errors.length}\n`,
  );
  await context.close();
}
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
try {
  for (let round = Number(firstRound); round < Number(firstRound) + Number(pairs); round++) {
    for (const label of round % 2 ? ['baseline', 'experiment'] : ['experiment', 'baseline'])
      await run(label, round);
  }
} finally {
  await browser.close();
  for (const { server } of Object.values(servers)) server.close();
}
