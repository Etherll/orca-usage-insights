// Per-provider wiring: transcript roots, line markers and parser factory. The scanner, its parse
// threads and the byte-level line filter all read it, so a provider is added in one place.
// Imports only the core parsers and their markers. records.mjs never imports this file.
import { CLAUDE_MARKERS, CODEX_MARKERS, createClaudeParser, createCodexParser } from './records.mjs';

export const PROVIDERS = {
  claude: { markers: CLAUDE_MARKERS, subdirs: ['projects'], createParser: createClaudeParser },
  // Codex event types sit in the first ~100 bytes of a line (measured: at most byte 94 over 3,522
  // files), so only each line's head is searched; the same words inside tool output are skipped.
  codex: { markers: CODEX_MARKERS, markerHead: 256, subdirs: ['sessions', 'archived_sessions'], createParser: createCodexParser },
};

// A line can only produce a record (or parser state) when it contains one of these. The scanner
// uses them to skip every other line without decoding it.
export const LINE_MARKERS = Object.fromEntries(Object.entries(PROVIDERS).map(([kind, provider]) => [kind, provider.markers]));

// Marker -> how many leading bytes of a line to search (none: the whole line).
export const MARKER_HEADS = Object.fromEntries(
  Object.values(PROVIDERS).flatMap((provider) => (provider.markerHead ? provider.markers.map((marker) => [marker, provider.markerHead]) : [])),
);
