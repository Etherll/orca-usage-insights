// Transcript roots and cache dir per OS. Uses node:path for the target platform, so win32
// rules resolve on any OS. `home` is the fallback home (os.homedir()) when env names none.
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function pathFor(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

export function homeDir({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  return (platform === 'win32' ? nonEmpty(env.USERPROFILE) : undefined) ?? nonEmpty(env.HOME) ?? home;
}

// Returns realpaths of the roots that exist. Missing roots (ENOENT, ENOTDIR) have nothing to scan,
// so they are dropped rather than counted as errors.
export async function resolveRoots({
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
  realpath = fsp.realpath,
} = {}) {
  const p = pathFor(platform);
  const base = homeDir({ platform, env, home });
  const configured = splitList(env.CLAUDE_CONFIG_DIR);
  const claude = configured.length > 0
    ? configured
    : [
        p.join(base, '.claude'),
        p.join(nonEmpty(env.XDG_CONFIG_HOME) ?? p.join(base, '.config'), 'claude'),
      ];
  const codex = [nonEmpty(env.CODEX_HOME) ?? p.join(base, '.codex')];
  return {
    claude: await existingRoots(claude, platform, realpath),
    codex: await existingRoots(codex, platform, realpath),
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
