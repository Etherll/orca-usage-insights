// A small pool of worker threads that turn a transcript's bytes into parser state, so a first
// scan of thousands of files uses several cores. Threads start on first use and are unref'd:
// an idle pool never keeps the process alive. Any thread failure rejects that job, and the
// scanner parses the file inline instead.
import { Worker } from 'node:worker_threads';

// idleMs: threads idle this long exit, so their memory goes back after a scan.
export function createParsePool(size, { idleMs = 5_000 } = {}) {
  const idle = [];
  const retiring = new Set();
  let idleTimer = null;
  const all = new Set();
  const queue = [];
  let broken = false;
  let worked = false; // a thread has finished a job: threads can run here, so a crash is that job's
  let nextId = 0;
  const pending = new Map();

  function spawn() {
    // Small young generation: parse threads make many short-lived strings and default semi-spaces cost tens of MB.
    const worker = new Worker(new URL('./parse-thread.mjs', import.meta.url), { resourceLimits: { maxYoungGenerationSizeMb: 4 } });
    worker.unref();
    worker.on('message', ({ id, ok, state, offset, error }) => {
      const job = pending.get(id);
      pending.delete(id);
      worked = true;
      worker.unref();
      idle.push(worker);
      pump();
      scheduleRetire();
      if (!job) return;
      if (ok) job.resolve({ state, offset });
      else job.reject(new Error(error));
    });
    worker.on('error', (error) => fail(worker, error));
    worker.on('exit', (code) => {
      if (retiring.delete(worker)) return;
      if (code !== 0) fail(worker, new Error(`parse thread exited ${code}`));
    });
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
    // With no thread left, give up only if no thread ever finished a job (threads can't run here).
    if (all.size === 0 && !worked) broken = true;
    else pump();
  }

  function scheduleRetire() {
    clearTimeout(idleTimer);
    if (queue.length > 0 || pending.size > 0) return;
    idleTimer = setTimeout(() => {
      if (queue.length > 0 || pending.size > 0) return;
      for (const worker of idle.splice(0)) {
        all.delete(worker);
        retiring.add(worker);
        worker.terminate().catch(() => {});
      }
    }, idleMs);
    idleTimer.unref?.();
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
      worker.postMessage({ id, ...job.spec });
    }
  }

  return {
    parse(spec) {
      if (broken) return Promise.reject(new Error('parse pool unavailable'));
      return new Promise((resolve, reject) => {
        queue.push({ spec, resolve, reject });
        pump();
      });
    },
    async close() {
      broken = true;
      clearTimeout(idleTimer);
      for (const job of queue.splice(0)) job.reject(new Error('parse pool closed'));
      await Promise.all([...all].map((w) => w.terminate()));
      all.clear();
      idle.length = 0;
    },
  };
}
