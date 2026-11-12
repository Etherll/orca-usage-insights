// Prompt-size bands. A price tier starts at one of these sizes, so a request's band is enough to
// pick its tier later, when prices may have changed.
export const PROMPT_BANDS = Object.freeze([0, 100000, 128000, 200000, 256000, 272000, 400000, 1000000]);

// The largest band at or below the prompt size.
export function bandOf(promptTokens) {
  const size = Number(promptTokens) || 0;
  for (let i = PROMPT_BANDS.length - 1; i > 0; i--) if (PROMPT_BANDS[i] <= size) return PROMPT_BANDS[i];
  return 0;
}
