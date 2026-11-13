export const PROMPT_BANDS = Object.freeze([0, 100000, 128000, 200000, 256000, 272000, 400000, 512000, 1000000]);

// A tier `above: N` prices prompts over N tokens, so a prompt of exactly N stays in the band below.
export function bandOf(promptTokens) {
  const size = Number(promptTokens) || 0;
  for (let i = PROMPT_BANDS.length - 1; i > 0; i--) if (PROMPT_BANDS[i] < size) return PROMPT_BANDS[i];
  return 0;
}
