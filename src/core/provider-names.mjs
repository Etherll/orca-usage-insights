// Display names per provider (the `provider` column of a usage record), for the panel, the worker and
// Explain prompts. Pure, and bundled into the panel by scripts/build.mjs. A provider added to the
// scanner gets its name here.
export const PROVIDER_LABELS = Object.freeze({ claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' })

export function providerLabel(provider, fallback = provider) {
  return Object.hasOwn(PROVIDER_LABELS, provider) ? PROVIDER_LABELS[provider] : fallback
}
