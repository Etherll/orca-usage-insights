// The one place that lists and reads transcript files, for the records and digest scanners.
import { PROVIDERS } from '../core/providers.mjs';
import { markedLines } from './lines.mjs';
import { pathFor } from './paths.mjs';
import { TOO_LARGE, readLines, zstdAvailable } from './zstd.mjs';

const LF = 0x0a;
const LF_BYTES = Buffer.from('\n');
const EMPTY = Buffer.alloc(0);
const CHUNK_BYTES = 4 << 20;
const TRANSCRIPT = /\.jsonl(\.zst)?$/i;
const COMPRESSED = /\.zst$/i;

// Paths are canonical (top-level dirs and symlinked files resolved), so a file two roots reach is listed once.
// Default roots own a file an extra folder also reaches; `owners` maps each extra-folder file to its status.
export async function listTranscripts({ fs, platform = process.platform, roots, extra, run }) {
  const p = pathFor(platform);
  const out = [];
  const owners = new Map();
  const seen = new Set();
  const walks = new Map(); // identity of a top-level dir -> files under it, walked once per run
  const walkTop = async (dir) => {
    const top = await canonicalDir(fs, dir);
    if (top === null) return null;
    const id = identityOf(top, platform);
    if (!walks.has(id)) {
      const found = [];
      await walk(top, found);
      walks.set(id, found);
    }
    return walks.get(id);
  };
  const claim = (kind, paths, folder) => {
    for (const path of paths) {
      const id = identityOf(path, platform);
      if (seen.has(id)) continue;
      seen.add(id);
      if (folder) owners.set(path, folder);
      out.push({
        path,
        kind,
        ctx: { sessionId: p.basename(path).replace(TRANSCRIPT, ''), project: p.basename(p.dirname(path)) },
        compressed: COMPRESSED.test(path),
      });
    }
  };

  // Symlinked directories are not Dirent directories, so only the resolved top-level dirs can be symlinks.
  async function walk(dir, found) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        run.errors++;
        run.failed.push(dir);
      }
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = p.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, found);
      else if (TRANSCRIPT.test(entry.name)) found.push(entry.isSymbolicLink() ? await realFile(full) : full);
    }
  }

  async function realFile(file) {
    try {
      return await fs.realpath(file);
    } catch {
      return file;
    }
  }

  for (const [kind, provider] of Object.entries(PROVIDERS)) {
    for (const root of roots[kind]) {
      for (const sub of provider.subdirs) claim(kind, (await walkTop(p.join(root, sub))) ?? [], null);
    }
  }
  const folders = [];
  for (const [kind, provider] of Object.entries(PROVIDERS)) {
    for (const folder of extra[kind]) {
      const entry = { path: folder, kind, state: 'ok', files: 0, records: 0, message: null };
      folders.push(entry);
      const errorsBefore = run.errors;
      const top = await canonicalDir(fs, folder);
      if (top === null) {
        Object.assign(entry, { state: 'warning', message: 'Folder not found' });
        continue;
      }
      let st;
      try {
        st = await fs.stat(top);
      } catch (error) {
        Object.assign(entry, { state: 'warning', message: `Cannot open folder (${error?.code ?? 'error'})` });
        continue;
      }
      if (!st.isDirectory()) {
        Object.assign(entry, { state: 'warning', message: 'Not a folder' });
        continue;
      }
      const asRoot = await isDirectory(fs, p.join(top, provider.subdirs[0]));
      for (const dir of asRoot ? provider.subdirs.map((sub) => p.join(top, sub)) : [top]) {
        const found = await walkTop(dir);
        if (!found) continue;
        entry.files += found.length;
        claim(kind, found, entry);
      }
      if (run.errors > errorsBefore) Object.assign(entry, { state: 'warning', message: 'Some files could not be read' });
    }
  }
  return { found: out, owners, folders };
}

// An unchanged key costs only the stat. A plain file that only grew is tailed from prior.offset; anything
// else is read whole, on a parse thread when there is a pool and size <= maxWholeBytes.
// A read failure returns key null with error: true; stat or open failures throw. A .zst over the cap
// returns its key: pass it back as `oversizedKey` and it is not decompressed again until it changes.
export async function readTranscript({
  fs,
  file,
  stat = null,
  prior = null,
  pool = null,
  mode = 'records',
  markers = null,
  open,
  maxWholeBytes = 64 << 20,
  oversizedKey = null,
}) {
  let st = stat;
  try {
    st ??= await fs.stat(file.path);
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'gone', missing: true };
    throw error;
  }
  if (!st.isFile()) return { status: 'gone', missing: false };
  const key = `${st.mtimeMs}:${st.size}`;
  if (prior && prior.key === key) return { status: 'unchanged' };
  if (file.compressed) {
    if (!zstdAvailable()) return { status: 'skipped', reason: 'zstd' };
    if (st.size > maxWholeBytes || key === oversizedKey) return { status: 'skipped', reason: 'too-large', key };
  }

  const fh = await fs.open(file.path, 'r');
  let consumer = null;
  let whole = false;
  try {
    if (prior && prior.key !== null && prior.consumer && !file.compressed && canTail(prior.key, st) && (await endsLine(fh, prior.offset))) {
      consumer = prior.consumer;
      const offset = await readChunks(fh, consumer, markers, prior.offset, st.size, null, prior.onAdvance);
      return { status: 'read', key, offset, whole: false, consumer, state: null };
    }

    whole = true;
    if (pool && st.size > 0) {
      try {
        const { state, offset } = await pool.parse({
          mode,
          kind: file.kind,
          ctx: file.ctx,
          compressed: file.compressed,
          markers: markers?.map(String) ?? null,
          path: file.path,
          size: st.size,
        });
        return { status: 'read', key, offset, whole, consumer: null, state };
      } catch (error) {
        if (error?.message === TOO_LARGE) return { status: 'skipped', reason: 'too-large', key };
      }
    }

    consumer = open(file, null);
    const offset = await readWhole(fh, st.size, file.compressed, markers, consumer);
    return { status: 'read', key, offset, whole, consumer, state: null };
  } catch (error) {
    if (file.compressed && error?.message === TOO_LARGE) return { status: 'skipped', reason: 'too-large', key };
    // Lines already pushed stay in the consumer; a whole re-read on the next scan keeps them exact.
    return { status: 'read', key: null, offset: 0, whole, consumer, state: null, error: true };
  } finally {
    await fh.close().catch(() => {});
  }
}

// scratch.buf is reused per parse thread: allocating a large buffer per file leaves glibc holding
// memory it never returns to the OS.
export async function readWhole(fh, size, compressed, markers, consumer, scratch = null) {
  if (!compressed) return readChunks(fh, consumer, markers, 0, size, scratch);
  await readLines(fh, size, (lines) => feed(consumer, lines, markers), scratch ?? {});
  return size;
}

function bufferFor(size, scratch) {
  if (!scratch) return Buffer.allocUnsafeSlow(size);
  if (!scratch.buf || scratch.buf.length < size) scratch.buf = Buffer.allocUnsafeSlow(Math.max(size, (scratch.buf?.length ?? 0) * 2));
  return scratch.buf;
}

function feed(consumer, lines, markers) {
  if (consumer.pushBytes) return consumer.pushBytes(lines);
  if (!markers && consumer.pushBuffer) return consumer.pushBuffer(lines);
  const text = linesText(lines, lines.length, markers);
  if (text) consumer.push(text);
}

export function fileText(buf, markers) {
  const ended = buf.length === 0 || buf[buf.length - 1] === LF ? buf : Buffer.concat([buf, LF_BYTES]);
  return linesText(ended, ended.length, markers);
}

export function linesText(buf, end, markers) {
  return markers ? markedLines(buf, end, markers) : buf.toString('utf8', 0, end);
}

// Each chunk is cut at its last LF. onAdvance(offset) hears each offset right after its push, so a
// mid-read save stores the offset the consumer's state belongs to.
async function readChunks(fh, consumer, markers, from, end, scratch = null, onAdvance = null) {
  let pos = from;
  let offset = from;
  let buf = bufferFor(Math.min(CHUNK_BYTES, Math.max(1, end - from)), scratch);
  let have = 0;
  while (pos < end) {
    if (have === buf.length) {
      const grown = Buffer.allocUnsafeSlow(buf.length * 2);
      buf.copy(grown, 0, 0, have);
      buf = grown;
      if (scratch) scratch.buf = grown;
    }
    const want = Math.min(buf.length - have, end - pos);
    const { bytesRead } = await fh.read(buf, have, want, pos);
    if (bytesRead === 0) break;
    pos += bytesRead;
    const length = have + bytesRead;
    const cut = buf.lastIndexOf(LF, length - 1);
    if (cut < 0) {
      have = length;
      continue;
    }
    feed(consumer, buf.subarray(0, cut + 1), markers);
    offset += cut + 1;
    onAdvance?.(offset);
    buf.copyWithin(0, cut + 1, length);
    have = length - cut - 1;
  }
  return offset;
}

// The scanner stores only offsets that follow an LF, so any other byte means the file was replaced.
async function endsLine(fh, offset) {
  if (offset === 0) return true;
  const probe = Buffer.alloc(1);
  const { bytesRead } = await fh.read(probe, 0, 1, offset - 1);
  return bytesRead === 1 && probe[0] === LF;
}

function canTail(prevKey, st) {
  const i = prevKey.lastIndexOf(':');
  const prevMtime = Number(prevKey.slice(0, i));
  const prevSize = Number(prevKey.slice(i + 1));
  return i > 0 && Number.isFinite(prevMtime) && Number.isFinite(prevSize) && st.size > prevSize && st.mtimeMs >= prevMtime;
}

async function canonicalDir(fs, dir) {
  try {
    return await fs.realpath(dir);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    return dir;
  }
}

function identityOf(file, platform) {
  return platform === 'win32' ? file.toLowerCase() : file;
}

async function isDirectory(fs, file) {
  try {
    return (await fs.stat(file)).isDirectory();
  } catch {
    return false;
  }
}
