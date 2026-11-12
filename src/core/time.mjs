// Timestamps to epoch ms and to local wall-clock ms. Pure: no Node built-in or Orca imports.

const HOUR_MS = 3_600_000;

// Same answer as new Date(ts).getTime(); the transcript shape is read digit by digit from the last hour parsed.
const TAIL_DIGITS = [14, 15, 17, 18, 20, 21, 22];
const HEAD_DIGITS = [0, 1, 2, 3, 5, 6, 8, 9, 11, 12];
export function timestampParser() {
  let head = '';
  let base = NaN;
  const digit = (s, i) => s.charCodeAt(i) - 48;
  return (ts) => {
    if (typeof ts !== 'string') return new Date(ts).getTime();
    const s = ts;
    if (s.length !== 24 || s.charCodeAt(23) !== 90 || s.charCodeAt(13) !== 58 || s.charCodeAt(16) !== 58 || s.charCodeAt(19) !== 46) return Date.parse(s);
    for (const i of TAIL_DIGITS) if (digit(s, i) >>> 0 > 9) return Date.parse(s);
    if (head === '' || !s.startsWith(head)) {
      // 'YYYY-MM-DDTHH', hour 00-23, checked here so the hour start below is a whole valid time.
      if (s.charCodeAt(4) !== 45 || s.charCodeAt(7) !== 45 || s.charCodeAt(10) !== 84) return Date.parse(s);
      for (const i of HEAD_DIGITS) if (digit(s, i) >>> 0 > 9) return Date.parse(s);
      if (digit(s, 11) * 10 + digit(s, 12) > 23) return Date.parse(s);
      const next = s.slice(0, 13);
      const start = Date.parse(`${next}:00:00.000Z`);
      if (Number.isNaN(start)) return Date.parse(s);
      head = next;
      base = start;
    }
    const minute = digit(s, 14) * 10 + digit(s, 15);
    const second = digit(s, 17) * 10 + digit(s, 18);
    if (minute > 59 || second > 59) return Date.parse(s);
    return base + minute * 60_000 + second * 1000 + digit(s, 20) * 100 + digit(s, 21) * 10 + digit(s, 22);
  };
}

// Local time read as UTC. The offset is looked up once per hour (per record in an hour with a DST change).
export function localClock() {
  const offsets = new Map();
  return (ms) => {
    const hour = Math.floor(ms / HOUR_MS);
    let off = offsets.get(hour);
    if (off === undefined) {
      const start = new Date(hour * HOUR_MS).getTimezoneOffset();
      const end = new Date(hour * HOUR_MS + HOUR_MS - 1).getTimezoneOffset();
      off = start === end && Number.isInteger(start) ? start : NaN;
      offsets.set(hour, off);
    }
    if (Number.isNaN(off)) {
      const date = new Date(ms);
      return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds());
    }
    return ms - off * 60_000;
  };
}
