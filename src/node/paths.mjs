// Transcript roots and cache dir per OS. Uses node:path for the target platform, so win32
// rules resolve on any OS. `home` is the fallback home (os.homedir()) when env names none.
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function pathFor(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

// Windows paths compare without case; everywhere else they are exact.
export function pathIdentity(file, platform) {
  return platform === 'win32' ? file.toLowerCase() : file;
}

// A source is turned off when its own path is in the turned-off list. Transcript roots and the OpenCode
// folder use this one rule, so a path the panel writes to settings always matches the source it came from.
export function isTurnedOff(path, disabled, platform) {
  const id = pathIdentity(path, platform);
  return (disabled ?? []).some((entry) => typeof entry === 'string' && pathIdentity(entry, platform) === id);
}

export function homeDir({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  return (platform === 'win32' ? nonEmpty(env.USERPROFILE) : undefined) ?? nonEmpty(env.HOME) ?? home;
}

// Only Orca's known account containers are enumerated; credentials and other home files
// are never opened. Keep candidates (including absent defaults) for scanner diagnostics.
export async function rootSpecs({
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
  readdir = fsp.readdir,
} = {}) {
  const p = pathFor(platform);
  const base = homeDir({ platform, env, home });
  const specs = [
    { path: p.join(base, '.claude'), kind: 'claude', source: 'default' },
    { path: p.join(nonEmpty(env.XDG_CONFIG_HOME) ?? p.join(base, '.config'), 'claude'), kind: 'claude', source: 'default' },
    { path: p.join(base, '.codex'), kind: 'codex', source: 'default' },
    ...splitList(env.CLAUDE_CONFIG_DIR).map((path) => ({ path, kind: 'claude', source: 'environment' })),
    ...(nonEmpty(env.CODEX_HOME) ? [{ path: nonEmpty(env.CODEX_HOME), kind: 'codex', source: 'environment' }] : []),
  ];
  const userData = nonEmpty(env.ORCA_USER_DATA_PATH) ?? (platform === 'darwin'
    ? p.join(base, 'Library', 'Application Support', 'orca')
    : platform === 'win32'
      ? p.join(nonEmpty(env.APPDATA) ?? p.join(base, 'AppData', 'Roaming'), 'orca')
      : p.join(nonEmpty(env.XDG_CONFIG_HOME) ?? p.join(base, '.config'), 'orca'));
  for (const [kind, container] of [['claude', 'claude-profiles'], ['codex', 'codex-accounts']]) {
    const dir = p.join(userData, container);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') {
        specs.push({ path: dir, kind, source: 'orca', message: `Cannot discover accounts (${error?.code ?? 'error'})` });
      }
      continue;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory() || entry.isSymbolicLink()) specs.push({ path: p.join(dir, entry.name, 'home'), kind, source: 'orca' });
    }
  }
  const seen = new Set();
  return specs.filter((spec) => {
    const key = `${spec.kind}:${platform === 'win32' ? spec.path.toLowerCase() : spec.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Environment roots supplement the defaults. Resolve aliases for callers needing just roots.
export async function resolveRoots(options = {}) {
  const { platform = process.platform, realpath = fsp.realpath } = options;
  const specs = await rootSpecs(options);
  return {
    claude: await existingRoots(specs.filter((s) => s.kind === 'claude').map((s) => s.path), platform, realpath),
    codex: await existingRoots(specs.filter((s) => s.kind === 'codex').map((s) => s.path), platform, realpath),
  };
}

export function cacheDir({
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
  tmpdir = os.tmpdir(),
} = {}) {
  const p = pathFor(platform);
  const base = homeDir({ platform, env, home });
  const fromHome = (...parts) => (base ? p.join(base, ...parts) : undefined);
  let root;
  if (platform === 'win32') root = nonEmpty(env.LOCALAPPDATA);
  else if (platform === 'darwin') root = fromHome('Library', 'Caches');
  else root = nonEmpty(env.XDG_CACHE_HOME) ?? fromHome('.cache');
  return p.join(root ?? tmpdir, 'orca-usage-insights');
}

async function existingRoots(candidates, platform, realpath) {
  const seen = new Set();
  const out = [];
  for (const candidate of candidates) {
    let real;
    try {
      real = await realpath(candidate);
    } catch (error) {
      // A missing root has nothing to scan. Any other failure (EACCES, EIO) keeps the root as
      // given, so the scanner still tries it and counts a read error if it cannot read it.
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') continue;
      real = candidate;
    }
    const key = platform === 'win32' ? real.toLowerCase() : real;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(real);
  }
  return out;
}

function splitList(value) {
  if (typeof value !== 'string') return [];
  return value.split(',').map((part) => part.trim()).filter(Boolean);
}

function nonEmpty(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}
