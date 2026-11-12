// The one place that lists and reads transcript files. The records scanner (scan.mjs) and the
// digest scanner (digest-scan.mjs) use it and keep only their own consumer and cache.
// A consumer is { push(text), state() } and receives the marked lines of a file in order.
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

// Lists the transcripts under the default roots and the extra folders. Every file path is
// canonical: top-level dirs are resolved once, and so are symlinked files, so a physical file is
// listed once even when two roots reach it through a symlink. Default roots come first and own a
// file that an extra folder also reaches. `owners` maps each file an extra folder owns to that
// folder's status entry. Read failures go to run.errors and run.failed.
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

  // Symlinked directories are not Dirent directories, so they are never followed. Only the
  // top-level dirs (resolved by canonicalDir) can be symlinks.
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
        // The folder's own status carries this warning; it is not counted as a file error.
        Object.assign(entry, { state: 'warning', message: `Cannot open folder (${error?.code ?? 'error'})` });
        continue;
      }
      if (!st.isDirectory()) {
        Object.assign(entry, { state: 'warning', message: 'Not a folder' });
        continue;
      }
      // A folder that holds the provider's main subdir (projects, sessions) is read like a default
      // root. Any other folder is read whole.
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

// Reads one transcript into the consumer it is given. Stats first (or takes the caller's stat): an
// unchanged key costs nothing more. A plain file that only grew is tailed from prior.offset. Anything else is read whole: on a
// parse thread when there is a pool and the file is at most maxWholeBytes, else inline.
// Returns what the caller stores: `consumer` when parsed here, `state` when a thread parsed it.
// A failure while reading returns key null (the next scan reads the file whole) with error: true.
// Failures before reading starts (stat, open) throw. A compressed file that decompresses past the cap
// is skipped as too large with its key; pass that key back as `oversizedKey` and the file is not
// decompressed again until it changes.
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
    // Size grew with no older mtime, and the byte before the stored offset ends a line: only the
    // bytes past the offset are new. Compressed files are never tailed.
    if (prior && prior.key !== null && prior.consumer && !file.compressed && canTail(prior.key, st) && (await endsLine(fh, prior.offset))) {
      consumer = prior.consumer;
      const offset = await readChunks(fh, consumer, markers, prior.offset, st.size, null, prior.onAdvance);
      return { status: 'read', key, offset, whole: false, consumer, state: null };
    }

    whole = true;
    // A parse thread opens and reads the file itself, in chunks: nothing is copied between threads.
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
        // The pool could not take it: parse inline below.
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

// Reads a whole file of `size` bytes into the consumer and returns the offset read up to. Plain
// files go in 4 MiB chunks cut at LF; compressed ones are decompressed in chunks. Used on the
// calling thread and on parse threads.
// scratch: { buf } a parse thread reuses for every file it reads. Freeing and allocating a large
// read buffer per file leaves glibc holding hundreds of MB it never returns to the OS (measured).
export async function readWhole(fh, size, compressed, markers, consumer, scratch = null) {
  if (!compressed) return readChunks(fh, consumer, markers, 0, size, scratch);
  await readLines(fh, size, (lines) => feed(consumer, lines, markers), scratch ?? {});
  return size;
}

// A buffer of at least `size` bytes: the scratch one, grown when needed, or a new one.
function bufferFor(size, scratch) {
  if (!scratch) return Buffer.allocUnsafeSlow(size);
  if (!scratch.buf || scratch.buf.length < size) scratch.buf = Buffer.allocUnsafeSlow(Math.max(size, (scratch.buf?.length ?? 0) * 2));
  return scratch.buf;
}

// Whole lines into a consumer: raw bytes when it picks its own lines (pushBytes) or takes every
// line (pushBuffer), else the text of the marked lines.
function feed(consumer, lines, markers) {
  if (consumer.pushBytes) return consumer.pushBytes(lines);
  if (!markers && consumer.pushBuffer) return consumer.pushBuffer(lines);
  const text = linesText(lines, lines.length, markers);
  if (text) consumer.push(text);
}

// Text of the marked lines in a whole file's bytes. A last line with no LF still counts.
export function fileText(buf, markers) {
  const ended = buf.length === 0 || buf[buf.length - 1] === LF ? buf : Buffer.concat([buf, LF_BYTES]);
  return linesText(ended, ended.length, markers);
}

// Marked lines of buf[0, end), or every line when there are no markers.
export function linesText(buf, end, markers) {
  return markers ? markedLines(buf, end, markers) : buf.toString('utf8', 0, end);
}

// Reads [from, end) in chunks. Each chunk is cut at its last LF, so the consumer only sees whole
// lines and the returned offset advances in the same step as the push. onAdvance(offset), when
// given, hears each new offset right after its push, so a caller that saves the consumer's state
// mid-read can save the offset that state belongs to.
// One buffer for the whole file: the bytes after the last LF move to its start before the next
// read, and it doubles when one line is longer than it.
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

// True when offset is 0 or the byte before it is LF. The scanner only stores offsets that follow
// an LF, so any other byte means the file was replaced under the stored offset.
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

// Key used to decide that two paths name the same file or directory.
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
