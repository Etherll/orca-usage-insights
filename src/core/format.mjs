// Number formatting shared by the panel and the status bar. Pure: no Node built-in or Orca imports.
// scripts/build.mjs bundles this file first, so the panel can use compact() without an import.

// Compact magnitude: 950 -> '950', 114500 -> '114.5k', 999999 -> '1M', 999950000 -> '1B'.
export function compact(n) {
  const v = Number(n) || 0;
  const units = [[1e9, 'B'], [1e6, 'M'], [1e3, 'k']];
  for (let i = 0; i < units.length; i++) {
    const [size, suffix] = units[i];
    if (Math.abs(v) >= size * 0.99995) {
      const text = trim(v / size);
      // 999.96k rounds to "1000k": promote to the next unit instead.
      if (Math.abs(Number(text)) >= 1000 && i > 0) return trim(v / units[i - 1][0]) + units[i - 1][1];
      return text + suffix;
    }
  }
  return String(Math.round(v));
}

function trim(x) {
  return x.toFixed(1).replace(/\.0$/, '');
}
