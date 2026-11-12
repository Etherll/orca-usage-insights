import test from 'node:test';
import assert from 'node:assert/strict';
import {
  agentTarget, attachmentTarget, commandFamily, commandTarget, injectedTarget, mcpTarget, messagesTarget,
  pathTarget, searchTarget, summaryTarget, toolTarget, webSearchTarget, webTarget,
} from '../src/core/breakdown/targets.mjs';

const CWD = '/home/dev/app';
const HOME = '/home/dev';
const TEMP = { key: 'folder:(temp files)', label: '(temp files)', kind: 'folder' };
const KINDS = ['file', 'folder', 'command', 'agent', 'web', 'mcp', 'tool', 'messages', 'injected', 'summary'];

test('paths under the cwd are relative to it', () => {
  assert.deepEqual(pathTarget('/home/dev/app/src/app.mjs', CWD, HOME), {
    key: 'file:src/app.mjs', label: 'src/app.mjs', kind: 'file',
  });
  assert.equal(pathTarget('C:\\work\\app\\src\\a.mjs', 'C:\\work\\app', HOME).key, 'file:src/a.mjs');
  assert.equal(pathTarget('/home/dev/app/scratchpad/a.txt', CWD, HOME).key, 'file:scratchpad/a.txt');
});

test('paths under the home folder read as ~/, and a sibling folder does not', () => {
  assert.equal(pathTarget('/home/dev/.config/tool/settings.json', CWD, HOME).key, 'file:~/.config/tool/settings.json');
  assert.equal(pathTarget('/home/dev/application/x.mjs', CWD, HOME).key, 'file:~/application/x.mjs');
  assert.equal(pathTarget('/home/devx/a.txt', CWD, HOME).key, 'file:/home/*/a.txt');
});

test('temp folders and scratchpads share one folder target', () => {
  const paths = [
    '/tmp/x/a.txt',
    '/private/tmp/a',
    '/var/folders/ab/T/x',
    'C:\\Users\\dev\\AppData\\Local\\Temp\\x.txt',
    '/work/x/scratchpad/a.txt',
  ];
  for (const path of paths) assert.deepEqual(pathTarget(path, CWD, HOME), TEMP, path);
});

test('other absolute paths keep their first five segments', () => {
  assert.equal(pathTarget('/opt/data/a/b/c/d/e.txt', CWD, HOME).key, 'file:/opt/data/a/b/c');
});

test('a path target is null when there is no usable path', () => {
  for (const path of ['', undefined, 42]) assert.equal(pathTarget(path, CWD, HOME), null);
});

test('command families keep the program and a subcommand, never arguments', () => {
  const cases = [
    ['cd app; FOO=1 BAR="x y" pnpm test -- --run', '$ pnpm test'],
    ['sudo -n time bun test a.mjs', '$ bun test'],
    ['rtk npx -y vitest run', '$ vitest'],
    ['git status --short', '$ git status'],
    ['git commit -m "secret text"', '$ git commit'],
    ['node -e "console.log(1)"', '$ node'],
    ['/usr/bin/git.exe status', '$ git status'],
    ['uv run pytest -q', '$ pytest'],
    ['cd "my dir" && make build', '$ make build'],
    ['cd app && cargo build --release', '$ cargo build'],
    ['"/usr/bin/node" script.js', '$ node'],
    ['curl -H "Authorization: x" https://example.org', '$ curl'],
    ['node deploy_token_rotate', '$ node'],
    ['node --inspect rotate_keys', '$ node'],
    ['python3 rotate_keys', '$ python3'],
    ['python -m pytest -q', '$ python -m pytest'],
    ['bun migrate_customers', '$ bun'],
    ['bun run build', '$ bun run'],
    ['deno task dev', '$ deno task'],
  ];
  for (const [cmd, family] of cases) assert.equal(commandFamily(cmd), family, cmd);
});

test('empty and assignment-only commands read as none', () => {
  for (const cmd of ['', '   ', 'FOO=bar', undefined]) assert.equal(commandFamily(cmd), '$ (none)');
});

test('command, agent and tool targets carry their labels', () => {
  assert.deepEqual(commandTarget('git status'), { key: 'command:$ git status', label: '$ git status', kind: 'command' });
  assert.deepEqual(agentTarget('general-purpose'), {
    key: 'agent:general-purpose', label: 'agent: general-purpose', kind: 'agent',
  });
  assert.deepEqual(agentTarget(undefined), { key: 'agent:(unnamed)', label: 'agent: (unnamed)', kind: 'agent' });
  assert.deepEqual(toolTarget('wait_agent'), { key: 'tool:wait_agent', label: 'wait_agent', kind: 'tool' });
  assert.equal(toolTarget('').key, 'tool:(unknown)');
  assert.deepEqual(mcpTarget('github'), { key: 'mcp:github', label: 'github', kind: 'mcp' });
});

test('web targets keep the host only', () => {
  assert.deepEqual(webTarget('https://docs.example.org/a/b?q=secret#frag'), {
    key: 'web:docs.example.org', label: 'docs.example.org', kind: 'web',
  });
  assert.equal(webTarget('not a url').key, 'web:(unknown)');
  assert.deepEqual(webSearchTarget(), { key: 'web:(web search)', label: '(web search)', kind: 'web' });
});

test('search without a path targets the shared search tool', () => {
  assert.deepEqual(searchTarget(undefined, CWD, HOME), { key: 'tool:(search)', label: '(search)', kind: 'tool' });
  assert.equal(searchTarget('/home/dev/app/src', CWD, HOME).key, 'file:src');
});

test('bucket and attachment targets carry their labels', () => {
  assert.deepEqual(messagesTarget(), { key: 'messages', label: 'messages', kind: 'messages' });
  assert.deepEqual(injectedTarget(), { key: 'injected', label: 'injected', kind: 'injected' });
  assert.deepEqual(summaryTarget(), { key: 'summary', label: 'compaction summary', kind: 'summary' });
  assert.deepEqual(attachmentTarget('hook_additional_context'), {
    key: 'injected:attachment:hook_additional_context',
    label: 'attachment: hook_additional_context',
    kind: 'injected',
  });
});

test('every target has exactly key, label and a contract kind', () => {
  const targets = [
    pathTarget('/opt/a.txt', CWD, HOME), pathTarget('/tmp/a', CWD, HOME), commandTarget('ls'),
    agentTarget('explorer'), toolTarget('Edit'), webTarget('https://example.org'), webSearchTarget(),
    mcpTarget('github'), searchTarget(undefined, CWD, HOME), messagesTarget(), injectedTarget(),
    attachmentTarget(undefined), summaryTarget(),
  ];
  for (const target of targets) {
    assert.deepEqual(Object.keys(target).sort(), ['key', 'kind', 'label']);
    assert.equal(typeof target.key, 'string');
    assert.equal(typeof target.label, 'string');
    assert.ok(KINDS.includes(target.kind), target.kind);
  }
});

test('an absolute path outside the project and home keeps five folders, without another user name', () => {
  assert.equal(pathTarget('/usr/lib/node_modules/typescript/lib/tsc.js', CWD, HOME).label, '/usr/lib/node_modules/typescript/lib');
  assert.equal(pathTarget('/home/alice/notes/plan.md', CWD, HOME).label, '/home/*/notes/plan.md');
  assert.equal(pathTarget('/mnt/win/Users/alice/.codex/x.jsonl', CWD, HOME).label, '/mnt/win/Users/*/.codex');
  assert.equal(pathTarget('C:\\Users\\alice\\proj\\a.mjs', CWD, HOME).label, 'C:/Users/*/proj/a.mjs');
});
