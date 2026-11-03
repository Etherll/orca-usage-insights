// Cross-source record rules. Pure: no Node built-in or Orca imports.

// Joins the record lists of several sources. A Claude message copied into a resumed session
// appears in two files, so records with the same `key` collapse to one: the earliest by
// timestamp, kept at the position of its first appearance. Records without a key are always
// kept. A timestamp tie keeps the record seen first. One pass, O(n).
export function mergeRecords(lists) {
  const out = [];
  const slot = new Map();
  for (const list of lists) {
    for (const record of list) {
      if (typeof record.key !== 'string') {
        out.push(record);
        continue;
      }
      const at = slot.get(record.key);
      if (at === undefined) {
        slot.set(record.key, out.length);
        out.push(record);
      } else if (Date.parse(record.ts) < Date.parse(out[at].ts)) {
        out[at] = record;
      }
    }
  }
  return out;
}
