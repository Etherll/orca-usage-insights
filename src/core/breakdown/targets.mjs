// Labels for breakdown targets. Pure: no Node built-ins or Orca imports. A target never holds message
// text, command arguments or file contents: paths are cut or made relative, commands keep their family.

const TEMP_PATH = /^(\/private)?\/(tmp|var\/folders)(\/|$)|(^|\/)appdata\/local\/temp(\/|$)/i;
const WRAPPER = /^(sudo|env|time|rtk|npx|bunx)\s+/;
const SUBCOMMAND_PROGRAMS = new Set([
  'git', 'gh', 'npm', 'pnpm', 'yarn', 'cargo', 'go', 'uv', 'pip', 'docker', 'kubectl',
  'make', 'dotnet', 'orca',
]);
// Only these programs' first plain word counts as a subcommand; Python's is the module after -m.
const KNOWN_SUBCOMMANDS = {
  bun: new Set(['add', 'build', 'create', 'install', 'link', 'pm', 'remove', 'run', 'test', 'update', 'upgrade', 'x']),
  deno: new Set(['add', 'bench', 'check', 'compile', 'fmt', 'info', 'init', 'install', 'lint', 'publish', 'remove', 'run', 'serve', 'task', 'test', 'upgrade']),
};
const PYTHONS = new Set(['python', 'python3']);
const CODE_FLAGS = new Set(['-e', '-c', '-p', '--eval', '--print']);
const MAX_SEGMENTS = 5;
const TEMP_TARGET = Object.freeze({ key: 'folder:(temp files)', label: '(temp files)', kind: 'folder' });

export function pathTarget(path, cwd, home) {
  if (typeof path !== 'string' || path === '') return null;
  const p = slashes(path);
  const absolute = p.startsWith('/') || /^[A-Za-z]:\//.test(p);
  const dir = trimSlashes(slashes(cwd));
  if (absolute && dir && p.startsWith(`${dir}/`)) return fileTarget(p.slice(dir.length + 1));
  if (TEMP_PATH.test(p) || p.split('/').includes('scratchpad')) return { ...TEMP_TARGET };
  const base = trimSlashes(slashes(home));
  if (absolute && base && (p === base || p.startsWith(`${base}/`))) return fileTarget(`~${p.slice(base.length)}`);
  const head = p.split('/').filter(Boolean).slice(0, MAX_SEGMENTS).join('/');
  return fileTarget(p.startsWith('/') ? `/${head}` : head);
}

export function commandFamily(cmd) {
  let rest = typeof cmd === 'string' ? cmd.trim() : '';
  let before;
  do {
    before = rest;
    rest = rest
      .replace(/^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/, '')
      .replace(/^[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s*/, '')
      .replace(/^uv\s+run\s+/, '')
      .replace(WRAPPER, '')
      .replace(/^-\S*\s*/, '');
  } while (rest !== before);
  const words = rest.split(/\s+/);
  const program = baseName(words[0]);
  if (!program) return '$ (none)';
  const known = KNOWN_SUBCOMMANDS[program];
  if (SUBCOMMAND_PROGRAMS.has(program) || known) {
    for (const word of words.slice(1)) {
      if (CODE_FLAGS.has(word)) break;
      if (word.startsWith('-')) continue;
      if (/^[A-Za-z][\w-]*$/.test(word) && (!known || known.has(word))) return `$ ${program} ${word}`;
      break;
    }
  } else if (PYTHONS.has(program)) {
    const m = words.indexOf('-m');
    if (m > 0 && /^[A-Za-z_][\w.]*$/.test(words[m + 1] ?? '')) return `$ ${program} -m ${words[m + 1]}`;
  }
  return `$ ${program}`;
}

export function commandTarget(cmd) {
  const family = commandFamily(cmd);
  return { key: `command:${family}`, label: family, kind: 'command' };
}

export function agentTarget(type) {
  const name = nonBlank(type) ?? '(unnamed)';
  return { key: `agent:${name}`, label: `agent: ${name}`, kind: 'agent' };
}

export function toolTarget(name) {
  const tool = nonBlank(name) ?? '(unknown)';
  return { key: `tool:${tool}`, label: tool, kind: 'tool' };
}

// Hostname only: the path, query and fragment of a URL can carry private text.
export function webTarget(url) {
  let host = '';
  try {
    host = new URL(String(url ?? '')).hostname;
  } catch {
    host = '';
  }
  const label = host || '(unknown)';
  return { key: `web:${label}`, label, kind: 'web' };
}

export function webSearchTarget() {
  return { key: 'web:(web search)', label: '(web search)', kind: 'web' };
}

export function mcpTarget(server) {
  const name = nonBlank(server) ?? '(unknown)';
  return { key: `mcp:${name}`, label: name, kind: 'mcp' };
}

export function searchTarget(path, cwd, home) {
  return pathTarget(path, cwd, home) ?? toolTarget('(search)');
}

export function messagesTarget() {
  return { key: 'messages', label: 'messages', kind: 'messages' };
}

export function injectedTarget() {
  return { key: 'injected', label: 'injected', kind: 'injected' };
}

export function attachmentTarget(type) {
  const name = nonBlank(type) ?? 'unknown';
  return { key: `injected:attachment:${name}`, label: `attachment: ${name}`, kind: 'injected' };
}

export function summaryTarget() {
  return { key: 'summary', label: 'compaction summary', kind: 'summary' };
}

function fileTarget(label) {
  return { key: `file:${label}`, label, kind: 'file' };
}

function slashes(value) {
  return typeof value === 'string' ? value.replace(/\\/g, '/') : '';
}

function trimSlashes(value) {
  return value.replace(/\/+$/, '');
}

function baseName(word) {
  const unquoted = String(word ?? '').replace(/^["']+|["']+$/g, '');
  return unquoted.split(/[\\/]/).pop().replace(/\.exe$/i, '');
}

function nonBlank(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}
