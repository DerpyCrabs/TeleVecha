import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const session = process.argv[2];
const port = session ? 47958 : 47858;
const root = resolve(import.meta.dirname, '../..');
const projectId = 'televecha-design';
const demoId = 'televecha-message-gallery';
const temp = mkdtempSync(join(tmpdir(), 'televecha-gallery-'));
function call(tool, params) {
  const file = join(temp, 'params.json');
  writeFileSync(file, JSON.stringify(params));
  return execFileSync(
    'derpdesign',
    ['call', tool, ...(session ? ['--session', session] : []), '--file', file],
    { encoding: 'utf8' },
  );
}
try {
  const projects = JSON.parse(call('project_list', {}));
  call(projects.some((p) => p.id === projectId) ? 'project_update' : 'project_register', {
    id: projectId,
    name: 'TeleVecha · Design',
    sourceRoot: root,
    supportRoot: import.meta.dirname,
    server: {
      command: [
        join(root, 'node_modules/.bin/vp'),
        'dev',
        '--config',
        'demos/derpdesign/vite.config.mts',
        '--port',
        String(port),
      ],
      cwd: root,
      url: 'http://127.0.0.1:' + port,
      readyTimeoutMs: 120000,
    },
  });
  /** @type {Array<[string,string,number,number,'chromium'|'ladybird', {panel?:string,message?:number}]>} */
  const layouts = [
    ['arrivals', 'Message arrivals', 813, 1100, 'chromium', { panel: 'arrivals' }],
    ['expressions', 'Emoji, GIFs and stickers', 810, 800, 'chromium', { panel: 'expressions' }],
    ['notebook', 'Mission notebook', 810, 1100, 'chromium', {}],
    ['media', 'Camera tests · mobile', 811, 390, 'chromium', {}],
    ['albums', 'Contact sheets', 812, 1200, 'chromium', {}],
    ['albums-mobile', 'Contact sheets · mobile', 812, 390, 'ladybird', {}],
    ['files', 'Documents and voice', 810, 1100, 'chromium', { message: 5 }],
    ['attach', 'Attachments · mobile', 810, 390, 'ladybird', { message: 5, panel: 'attach' }],
    ['actions', 'Chat actions', 812, 1200, 'chromium', { panel: 'chat' }],
    ['main', 'Main menu', 810, 800, 'chromium', { panel: 'main' }],
    ['settings', 'Appearance', 810, 1100, 'chromium', { panel: 'settings' }],
    ['tall-photos', 'Tall photos · crop and fit', 814, 1100, 'chromium', { message: 2 }],
    ['wide-photos', 'Panoramas · mobile', 814, 390, 'chromium', { message: 6 }],
    ['photos', 'Photo sizes · mobile', 811, 390, 'chromium', { message: 2 }],
  ];
  const panes = layouts.map(([id, name, chat, width, engine, conditions], index) => ({
    id: 'gallery-' + id,
    name,
    engine,
    viewport: { width, height: 800, deviceScaleFactor: 'display' },
    position: { x: index % 2 ? 1240 : 0, y: Math.floor(index / 2) * 840 },
    route: '/?scenario=gallery-' + id + '&chat=g:' + chat,
    conditions,
  }));
  call('demo_put', {
    id: demoId,
    projectId,
    name: 'Mission notebook · messages and media',
    description: 'Conversation, media formats and grouped attachments on desktop and mobile.',
    panes,
  });
  if (session) call('selection_set', { projectId, demoId });
} finally {
  rmSync(temp, { recursive: true, force: true });
}
