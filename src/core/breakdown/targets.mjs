// Labels for breakdown targets. Pure: no Node built-ins or Orca imports.
// A target names a file, folder, command family, agent, web host, MCP server or tool. It never
// holds message text, command arguments or file contents: paths are cut or made relative, and a
// command keeps only its program and, for a few tools, its subcommand.

const TEMP_PATH = /^(\/private)?\/(tmp|var\/folders)(\/|$)|(^|\/)appdata\/local\/temp(\/|$)/i;
const WRAPPER = /^(sudo|env|time|rtk|npx|bunx)\s+/;
const SUBCOMMAND_PROGRAMS = new Set([
  'git', 'gh', 'npm', 'pnpm', 'yarn', 'bun', 'cargo', 'go', 'uv', 'pip', 'docker', 'kubectl',
  'make', 'dotnet', 'deno', 'node', 'python', 'python3', 'orca',
]);
// After these flags the next word is code, not a subcommand.
const CODE_FLAGS = new Set(['-e', '-c', '-p', '--eval', '--print']);
const MAX_SEGMENTS = 5;
const TEMP_TARGET = Object.freeze({ key: 'folder:(temp files)', label: '(temp files)', kind: 'folder' });

// The target for a file or folder path. Under the cwd: relative to it. Temp folders: one shared
// target. Under home: ~/… . Anything else: its first five segments. Null when there is no path.
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

// The family of a shell command: its program and, for a few tools, its subcommand. Flags,
// arguments and paths are dropped, so a family never carries command text.
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
  if (SUBCOMMAND_PROGRAMS.has(program)) {
    for (const word of words.slice(1)) {
      if (CODE_FLAGS.has(word)) break;
      if (word.startsWith('-')) continue;
      if (/^[A-Za-z][\w-]*$/.test(word)) return `$ ${program} ${word}`;
      break;
    }
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

// A search with a path targets that path. A search without one targets the shared search tool.
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

// Program name from its first word: quotes, directories and a .exe suffix removed.
function baseName(word) {
  const unquoted = String(word ?? '').replace(/^["']+|["']+$/g, '');
  return unquoted.split(/[\\/]/).pop().replace(/\.exe$/i, '');
}

function nonBlank(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}
