# Usage Insights

A usage dashboard for [Orca](https://onorca.dev). It reads your Claude Code and Codex transcripts, from this machine and from any extra folders or SSH hosts you add, and shows how much you use them: tokens, estimated cost, activity over time, and where the tokens go.

Requires Orca 1.4.248 or later.

## What it shows

The sidebar panel has range filters (7d, 30d, 90d, All), a Tokens/Cost measure, a Scope switch, a provider filter, a Machine filter, a Cache toggle and a rescan button. The Machine filter appears once a second machine has usage. Turn Cache off to leave cache tokens out of the bars and the token mix.

- **Banner**: a pixel-art skyline drawn from your daily usage. Stars count your streak days.
- **Tiles**: tokens, estimated cost, today, cache reuse, sessions and turns, and streak.
- **Daily usage**: stacked bars per day for input, output, cache read and cache write.
- **Activity**: a 26-week calendar heatmap with your peak day.
- **Rhythm**: a weekday by hour chart, in local time.
- **Token mix**: a donut of the four token kinds.
- **Models, Projects, Providers**: bars ranked by tokens. With two or more machines, a **Machines** list is added.

The status bar item shows today's tokens, such as `3.4M today`. Its tooltip shows today's estimated cost. It refreshes every 60 seconds.

A token total is input + output + cache read + cache write.

## Scope, machines and sources

**Scope** sets which sessions count.

- **All local** (default): every session from every source in the Sources strip.
- **Worktrees**: only sessions whose working folder is inside an Orca worktree. The folder is matched against the worktrees Orca lists on this machine, so a worktree you delete drops out. Sessions with no recorded folder are left out. If Orca's worktree list can't be read, the panel shows all usage and a note says why.

**Machine** picks **All machines** or one machine: This machine, or an SSH host.

**Sources** is the strip under the filters. It has one pill for This machine, each extra folder and each SSH host:

| Pill | Meaning |
| --- | --- |
| Up to date | Scanned. Shows its turn count and when it last scanned. |
| Warning | Part was skipped, such as a missing folder or unreadable files. The rest still counts. |
| Error (`failed`) | An SSH host could not be read. Hover for the reason. Usage pulled earlier still counts. |
| Loading (`connecting…`) | An SSH host is still connecting or on its first pull. |

Warnings and errors are also listed in the line above the strip. With only This machine and nothing wrong, the strip shows a hint to add folders or hosts in Settings.

## Where the data comes from

The plugin only reads these files. The only thing it writes is its scan cache.

**Claude Code** reads `projects/**/*.jsonl` from each of these roots:

- `CLAUDE_CONFIG_DIR` (comma-separated), if set. It replaces the defaults below.
- Otherwise `~/.claude` and `~/.config/claude` (or `$XDG_CONFIG_HOME/claude`).

**Codex** reads `sessions/**/*.jsonl` and `archived_sessions/**/*.jsonl` under `CODEX_HOME`, or `~/.codex` if it is not set.

Extra folders from Settings are read along with these roots. SSH hosts are read from their own machines, using the same default folders on each.

`~` is `$HOME` on Linux and macOS, and `%USERPROFILE%` on Windows. Roots that do not exist are skipped. A folder reached through a symlink inside a root is not followed. A file reached twice is counted once.

**Scan cache** is `scan-cache-v1.json`, in:

- Linux: `$XDG_CACHE_HOME/orca-usage-insights`, or `~/.cache/orca-usage-insights`
- macOS: `~/Library/Caches/orca-usage-insights`
- Windows: `%LOCALAPPDATA%\orca-usage-insights`

Each SSH host keeps its own `ssh-<host>.json` there. The cache holds parsed usage numbers, session ids and folder paths, not message text. Delete these files to force a full rescan.

## Settings

Set these in **Settings → Plugins → Usage Insights**. Each takes one entry per line. Blank lines and lines starting with `#` are ignored. A change applies on the next panel load, the next status bar update (within a minute), or after Rescan.

**Extra Claude Code folders** and **Extra Codex folders** add folders to the defaults above.

- `~` is your home folder. Use `~` or an absolute path; a relative path is skipped and logged.
- A folder that contains `projects/` (Claude Code) or `sessions/` (Codex) is treated as a root, read like the defaults. Any other folder is searched for `.jsonl` files.
- A folder that does not exist shows a Warning in Sources.

```text
# Claude Code inside WSL, from Windows
\\wsl.localhost\Ubuntu\home\you\.claude
# An old backup
~/backup/.claude
```

**SSH hosts** reads transcripts from other machines, through your own `ssh` (it must be on this machine's PATH).

- One host per line: a name from `~/.ssh/config`, such as `devbox`, or `user@host`.
- Key or ssh-agent login only. The plugin never prompts, and passwords are not supported. A host that asks for one shows as failed.
- The remote must be Linux or macOS with `sh`, `find`, `tail`, `head`, `grep` and `awk`, plus the standard `od`, `tr`, `sed`, `stat`, `wc` and `cut`. Its default Claude Code and Codex folders are read (`~/.claude`, `~/.config/claude`, `~/.codex`, or its `CLAUDE_CONFIG_DIR` and `CODEX_HOME`).
- The first pull moves only the usage lines, compressed. Later scans move only lines added since the last pull. Each host is rescanned at most every 2 minutes; Rescan forces one.
- The panel waits at most 1.5 seconds for hosts. A slow host shows as Loading, and the panel updates when it finishes.
- Failures show in Sources with the reason, such as an unknown host, a refused login, or a host key that is not trusted yet (connect once with `ssh` in a terminal to accept it).

**Orca servers**: if Orca connects to a server, install this plugin on that server to see that machine's usage when it is connected. To merge the server's usage into this view, add the server as an SSH host.

## Permissions

This plugin is a `trusted-worker`. It runs its own code in a separate Node.js process with your user account's access, so Orca asks you to approve it on install. The reason it needs that access: panels cannot read files, so reading transcripts has to happen in the worker.

It also requests:

- `workspace:read`: lists your Orca worktrees, for the Worktrees scope.
- `settings:own`: reads this plugin's settings, including the folders and SSH hosts above.

## Privacy

- The plugin makes no network requests of its own. The only traffic is your own `ssh` connections to the SSH hosts you list.
- The panel runs in a sandbox with `connect-src 'none'`. It sees only the report data the worker sends it, never the transcripts.

## Cost

Costs are estimates at Anthropic's list API prices, per token kind. The price table is in `src/core/pricing.mjs` and is dated 2026-10. Cache writes use the 5-minute rate. The figures are not your bill: plan subscriptions and discounts are not reflected.

Codex models have no price table. Their tokens count, but add nothing to cost. The Est. cost tile shows a `+` when some models are unpriced.

## Install

Install from onorca.dev/plugins, then approve the plugin when Orca asks.

## Development

Requires Node 22, which CI uses. There are no dependencies.

```sh
node scripts/build.mjs                          # inline src/panel and src/core/format.mjs into panel/index.html
node --test tests/*.test.mjs                    # tests
node scripts/bench-scan.mjs                     # time scans of your real transcripts (temp dir only for writes)
node scripts/bench-worker.mjs [runs]            # time what the panel waits for: open, range switch, refresh
node scripts/media/render.mjs                    # plugin page images from made-up demo data (needs Chromium; Orca logo from your Orca install or ORCA_LOGO)
node scripts/preview.mjs [out.html] [--light] [--cost] [--ssh a,b] [--folders a,b] [--worktrees a,b]
orca plugin validate .                          # check the manifest and folder
orca plugin dev load .                          # load this folder into Orca as a development plugin
```

`preview.mjs` renders the panel with your usage, outside Orca, through the worker's own handlers. `--light` uses the light theme and `--cost` opens the Cost measure. `--ssh`, `--folders` and `--worktrees` each take a comma-separated list: SSH hosts (real `ssh` connections), extra Claude Code folders, and folders to treat as Orca worktrees.

After editing `src/panel/` or `src/core/format.mjs`, run the build. CI fails if the committed `panel/index.html` is out of date, so commit the rebuilt file with your change.

## Publishing

1. Keep the repo public and add the `orca-plugin` topic on GitHub.
2. Push a `vX.Y.Z` tag that matches `version` in `orca-plugin.json`, for example `git tag v1.0.0 && git push origin v1.0.0`.
3. The plugin is listed at onorca.dev/plugins.

## License

MIT. See [LICENSE](LICENSE).
