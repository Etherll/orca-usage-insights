// A small pool of worker threads that turn a transcript's bytes into parser state, so a first
// scan of thousands of files uses several cores. Threads start on first use and are unref'd:
// an idle pool never keeps the process alive. Any thread failure rejects that job, and the
// scanner parses the file inline instead.
import { Worker } from 'node:worker_threads';

export function createParsePool(size) {
  const idle = [];
  const all = new Set();
  const queue = [];
  let broken = false;
  let nextId = 0;
  const pending = new Map();

  function spawn() {
    const worker = new Worker(new URL('./parse-thread.mjs', import.meta.url));
    worker.unref();
    worker.on('message', ({ id, ok, state, error }) => {
      const job = pending.get(id);
      pending.delete(id);
      worker.unref();
      idle.push(worker);
      pump();
      if (!job) return;
      if (ok) job.resolve({ state });
      else job.reject(new Error(error));
    });
    worker.on('error', (error) => fail(worker, error));
    worker.on('exit', (code) => code !== 0 && fail(worker, new Error(`parse thread exited ${code}`)));
    all.add(worker);
    return worker;
  }

  function fail(worker, error) {
    all.delete(worker);
    const i = idle.indexOf(worker);
    if (i >= 0) idle.splice(i, 1);
    for (const [id, job] of pending) {
      if (job.worker === worker) {
        pending.delete(id);
        job.reject(error);
      }
    }
    if (all.size === 0) broken = true;
  }

  function pump() {
    while (queue.length) {
      let worker = idle.pop();
      if (!worker && all.size < size) {
        try {
          worker = spawn();
        } catch (error) {
          broken = true;
          for (const job of queue.splice(0)) job.reject(error);
          return;
        }
      }
      if (!worker) return;
      const job = queue.shift();
      const id = nextId++;
      job.worker = worker;
      pending.set(id, job);
      worker.ref();
      // Copy into a transferable buffer of exactly this size, then hand it over without a copy.
      const bytes = new Uint8Array(job.buf.byteLength);
      bytes.set(job.buf);
      worker.postMessage({ id, kind: job.kind, ctx: job.ctx, bytes }, [bytes.buffer]);
    }
  }

  return {
    parse(buf, kind, ctx) {
      if (broken) return Promise.reject(new Error('parse pool unavailable'));
      return new Promise((resolve, reject) => {
        queue.push({ buf, kind, ctx, resolve, reject });
        pump();
      });
    },
    async close() {
      broken = true;
      for (const job of queue.splice(0)) job.reject(new Error('parse pool closed'));
      await Promise.all([...all].map((w) => w.terminate()));
      all.clear();
      idle.length = 0;
    },
  };
}
