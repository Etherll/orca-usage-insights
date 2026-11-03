import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cacheDir, homeDir, resolveRoots } from '../src/node/paths.mjs';

const identity = async (value) => value;

test('home is USERPROFILE then HOME on win32, HOME elsewhere, then the fallback', () => {
  assert.equal(homeDir({ platform: 'win32', env: { USERPROFILE: 'C:\\Users\\me', HOME: 'C:\\h' }, home: 'X' }), 'C:\\Users\\me');
  assert.equal(homeDir({ platform: 'win32', env: { HOME: 'C:\\h' }, home: 'X' }), 'C:\\h');
  assert.equal(homeDir({ platform: 'darwin', env: { USERPROFILE: 'C:\\Users\\me' }, home: '/Users/me' }), '/Users/me');
  assert.equal(homeDir({ platform: 'linux', env: { HOME: '/home/me' }, home: '/x' }), '/home/me');
  assert.equal(homeDir({ platform: 'linux', env: {}, home: '/fallback' }), '/fallback');
});

test('win32 roots use backslash paths for the default Claude and Codex locations', async () => {
  const roots = await resolveRoots({ platform: 'win32', env: { USERPROFILE: 'C:\\Users\\me' }, realpath: identity });
  assert.deepEqual(roots, {
    claude: ['C:\\Users\\me\\.claude', 'C:\\Users\\me\\.config\\claude'],
    codex: ['C:\\Users\\me\\.codex'],
  });
});

test('darwin and linux roots use HOME, and XDG_CONFIG_HOME moves the claude config root', async () => {
  assert.deepEqual(
    await resolveRoots({ platform: 'darwin', env: { HOME: '/Users/me' }, realpath: identity }),
    { claude: ['/Users/me/.claude', '/Users/me/.config/claude'], codex: ['/Users/me/.codex'] },
  );
  assert.deepEqual(
    await resolveRoots({ platform: 'linux', env: { HOME: '/home/me', XDG_CONFIG_HOME: '/srv/cfg' }, realpath: identity }),
    { claude: ['/home/me/.claude', '/srv/cfg/claude'], codex: ['/home/me/.codex'] },
  );
});

test('CLAUDE_CONFIG_DIR replaces the default Claude roots, split on commas and trimmed', async () => {
  const roots = await resolveRoots({
    platform: 'linux',
    env: { HOME: '/home/me', CLAUDE_CONFIG_DIR: ' /a/one , ,/b/two ', CODEX_HOME: ' /c/codex ' },
    realpath: identity,
  });
  assert.deepEqual(roots, { claude: ['/a/one', '/b/two'], codex: ['/c/codex'] });

  const blank = await resolveRoots({ platform: 'linux', env: { HOME: '/home/me', CLAUDE_CONFIG_DIR: ' , ' }, realpath: identity });
  assert.deepEqual(blank.claude, ['/home/me/.claude', '/home/me/.config/claude']);
});

test('roots that cannot be resolved are dropped', async () => {
  const realpath = async (value) => {
    if (value.includes('missing')) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return value;
  };
  const roots = await resolveRoots({
    platform: 'linux',
    env: { CLAUDE_CONFIG_DIR: '/x/missing,/x/here', CODEX_HOME: '/x/missing-codex' },
    realpath,
  });
  assert.deepEqual(roots, { claude: ['/x/here'], codex: [] });
});

test('roots are deduped by realpath, case-insensitively only on win32', async () => {
  const win = await resolveRoots({
    platform: 'win32',
    env: { CLAUDE_CONFIG_DIR: 'C:\\Users\\Me\\.claude, c:\\users\\me\\.claude' },
    realpath: identity,
  });
  assert.deepEqual(win.claude, ['C:\\Users\\Me\\.claude']);

  const posix = await resolveRoots({ platform: 'linux', env: { CLAUDE_CONFIG_DIR: '/x/A, /x/a' }, realpath: identity });
  assert.deepEqual(posix.claude, ['/x/A', '/x/a']);
});

test('a symlinked root resolves to its target and is counted once', async (t) => {
  const base = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'usage-paths-')));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const real = path.join(base, 'real');
  const link = path.join(base, 'link');
  await fsp.mkdir(real);
  try {
    await fsp.symlink(real, link, 'dir');
  } catch (error) {
    t.skip(`symlinks unavailable: ${error.code}`);
    return;
  }
  const roots = await resolveRoots({
    platform: process.platform,
    env: { CLAUDE_CONFIG_DIR: `${real},${link}` },
    home: base,
  });
  assert.deepEqual(roots.claude, [await fsp.realpath(real)]);
});

test('cache dir follows each OS convention and falls back to tmpdir', () => {
  assert.equal(
    cacheDir({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, home: 'C:\\Users\\me', tmpdir: 'C:\\Temp' }),
    'C:\\Users\\me\\AppData\\Local\\orca-usage-insights',
  );
  assert.equal(
    cacheDir({ platform: 'win32', env: {}, home: 'C:\\Users\\me', tmpdir: 'C:\\Temp' }),
    'C:\\Temp\\orca-usage-insights',
  );
  assert.equal(
    cacheDir({ platform: 'darwin', env: { HOME: '/Users/me' }, home: '/x', tmpdir: '/tmp' }),
    '/Users/me/Library/Caches/orca-usage-insights',
  );
  assert.equal(
    cacheDir({ platform: 'linux', env: { XDG_CACHE_HOME: '/srv/cache' }, home: '/home/me', tmpdir: '/tmp' }),
    '/srv/cache/orca-usage-insights',
  );
  assert.equal(
    cacheDir({ platform: 'linux', env: {}, home: '/home/me', tmpdir: '/tmp' }),
    '/home/me/.cache/orca-usage-insights',
  );
  assert.equal(
    cacheDir({ platform: 'linux', env: {}, home: '', tmpdir: '/var/tmp' }),
    '/var/tmp/orca-usage-insights',
  );
});

test('scanner modules import only node:path, node:os, node:fs/promises and local files', async () => {
  const allowed = new Set(['node:path', 'node:os', 'node:fs/promises']);
  for (const name of ['paths.mjs', 'scan.mjs']) {
    const source = await fsp.readFile(new URL(`../src/node/${name}`, import.meta.url), 'utf8');
    const specifiers = [...source.matchAll(/^\s*import[^'"]*['"]([^'"]+)['"]/gm)].map((match) => match[1]);
    for (const specifier of specifiers) {
      const ok = specifier.startsWith('node:') ? allowed.has(specifier) : specifier.startsWith('.');
      assert.ok(ok, `${name} imports ${specifier}`);
    }
    assert.doesNotMatch(source, /['"`][/~]/, `${name} has a hardcoded path literal`);
  }
});
