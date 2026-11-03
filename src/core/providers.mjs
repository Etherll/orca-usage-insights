// Per-provider wiring: transcript roots, line markers and parser factory. The scanner, its parse
// threads and the byte-level line filter all read it, so a provider is added in one place.
// Imports only the core parsers and their markers. records.mjs never imports this file.
import { CLAUDE_MARKERS, CODEX_MARKERS, createClaudeParser, createCodexParser } from './records.mjs';

export const PROVIDERS = {
  claude: { markers: CLAUDE_MARKERS, subdirs: ['projects'], createParser: createClaudeParser },
  codex: { markers: CODEX_MARKERS, subdirs: ['sessions', 'archived_sessions'], createParser: createCodexParser },
};

// A line can only produce a record (or parser state) when it contains one of these. The scanner
// uses them to skip every other line without decoding it.
export const LINE_MARKERS = Object.fromEntries(Object.entries(PROVIDERS).map(([kind, provider]) => [kind, provider.markers]));
