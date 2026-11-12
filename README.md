<h1 align="center">
  <img src="images/icon.png" alt="" height="72"><br>
  Usage Insights
</h1>

<h3 align="center">See how much Claude Code and Codex you actually use, inside Orca.</h3>

<p align="center">
  <a href="#install">Install</a> •
  <a href="#what-you-get">What you get</a> •
  <a href="#breakdown">Breakdown</a> •
  <a href="#prices">Prices</a> •
  <a href="#more-machines-and-folders">More machines</a> •
  <a href="#speed">Speed</a> •
  <a href="#privacy">Privacy</a> •
  <a href="https://www.onorca.dev/plugins/Etherll/orca-usage-insights">Plugin page</a>
</p>

<p align="center">
  <img src="images/cover.png" alt="Usage Insights in an Orca window: token totals, a split by provider and machine, and a daily trend" width="900">
</p>

## Install

Install it from the [plugin page](https://www.onorca.dev/plugins/Etherll/orca-usage-insights), or in Orca go to **Settings → Plugins → Add plugin → From a Git URL** and paste `https://github.com/Etherll/orca-usage-insights`. Orca asks you to approve it first, because it reads files on your machine (more on that [below](#privacy)).

Then open it from the bar chart icon in the right sidebar. The status bar shows today's tokens too; hover it for the cost and cache hit rate, or click it to show or hide the sidebar.

Needs Orca 1.4.248 or newer.

## What you get

The panel reads your Claude Code and Codex transcripts and turns them into:

* **Totals** for today, 7 days, 30 days, 90 days, everything or dates you pick: tokens, estimated cost, today, cache hit rate, sessions and your streak.
* **Daily charts** of tokens or cost, per token type and per provider.
* **A 26-week activity calendar** and a weekday by hour chart of when you work.
* **Rankings** by model, project and machine, and a sortable **Date × model** table with exact input, output and cache token counts.
* **A Breakdown view** that shows what your spend went on, down to the file or command ([more below](#breakdown)).
* **A pixel-art skyline** at the top, drawn from your daily usage. The stars are your streak.

It updates a few seconds after an agent finishes a turn, so the numbers keep up while you work.

**7d** is the default range. **Today** is the current local day from midnight, not the last 24 hours. **Custom** takes a start and end date (both included, in local time; pick the same date twice for one day). The calendar and streak keep their full history whatever the range.

One **Filters** menu narrows it down: only sessions that ran in an Orca worktree, one provider, one or more models, one machine, or no cache tokens. Turning cache tokens off takes them out of every total, share and chart; the cache read and write counts and the cost stay as recorded. A model selection is a fixed list, so a model that shows up later is only included under **All models**.

<table>
  <tr>
    <td><img src="images/screenshot-cost.png" alt="Daily cost, activity calendar, rhythm chart and model breakdown"></td>
    <td><img src="images/screenshot-filters.png" alt="The Filters menu open, with Orca worktrees only selected"></td>
  </tr>
  <tr>
    <td><img src="images/screenshot-activity.png" alt="Light theme: activity calendar, rhythm, breakdown, token mix and projects"></td>
    <td><img src="images/screenshot-sidebar.png" alt="The panel at sidebar width in dark and light themes"></td>
  </tr>
</table>

Cost is an estimate at list API prices, so it's what the same tokens would cost on the API, not your bill. Claude and OpenAI models are both priced, per exact model, with long-prompt tiers and 1-hour cache writes ([more below](#prices)). A model with no price counts toward tokens, and its cost shows as `+`.

## Breakdown

Switch the panel to **Breakdown** to see what the money went on. It splits the same total as the Usage view, to the cent, into:

* **Buckets**: session start (system prompt, tools, memory files), tool results, your messages, injected context, earlier replies, compaction summaries, cache rebuilds and output.
* **Where it went**: click from a project into its folders and files, or into its commands (`$ git status`, `$ npm test`), subagents and other tools.
* **Patterns worth a look**: large tool results that stayed in context, the same file read again with no edit in between, and the cache expiring after a break. Each card shows what that pattern cost.

<table>
  <tr>
    <td><img src="images/screenshot-breakdown.png" alt="Breakdown: spend split into buckets, and one project's src folder split by file"></td>
    <td><img src="images/screenshot-patterns.png" alt="Patterns worth a look: a large test output, a file read again, and the cache expiring after a break, each with its cost"></td>
  </tr>
</table>

Each pattern has an **Explain** button. It gives you a prompt to paste into Claude Code or Codex. The prompt holds the numbers and a few `node` commands that print short excerpts of the transcripts involved, so your agent can work out the cause and suggest a fix. Reading those excerpts costs your agent a few thousand tokens (the panel shows an estimate), and they go to its model provider like any other file it reads.

<p align="center">
  <img src="images/screenshot-explain.png" alt="The Explain dialog with a prompt for one pattern, ready to copy" width="720">
</p>

`≈` marks a split that is estimated (several tool results in one turn are split by size). Spend that can't be split, such as usage on SSH hosts, is listed under **Not analysed** with the reason. Breakdown follows the range, custom dates included, but not the model or cache-token filters. The first Breakdown reads the transcripts changed within the range, which takes a few seconds on a big history; after that only new lines are read.

## Prices

Prices ship with the plugin, taken from [LiteLLM](https://github.com/BerriAI/litellm)'s price list. The line at the bottom of the panel says which prices are in use.

**Sync prices** fetches the current lists from LiteLLM and [models.dev](https://models.dev) and shows what would change, and by how much for your last 30 days. Only the rows you tick are applied. Rows where the two sources agree come pre-ticked; big jumps and anything odd never are. **Undo** puts the previous prices back, and **Reset** goes back to the bundled ones.

### Your own prices

To set a price yourself, for a discount, a proxy or a model neither list has, create `price-overrides.json` in the plugin's cache folder:

* Linux: `~/.cache/orca-usage-insights/`
* macOS: `~/Library/Caches/orca-usage-insights/`
* Windows: `%LOCALAPPDATA%\orca-usage-insights\`

Prices are USD per million tokens:

```json
{
  "v": 1,
  "models": {
    "claude-opus-5-5": { "output": 18 },
    "my-proxy-model": { "provider": "anthropic", "input": 1, "output": 5, "cacheRead": 0.1, "cacheWrite": { "5m": 1.25, "1h": 2 } }
  },
  "aliases": { "my-proxy-opus": "claude-opus-5-5" }
}
```

The first entry changes one price of a known model, the second adds a new model, and the alias prices a model name as another. A new model needs its `provider` unless its name starts with `claude-`: `anthropic` splits cache writes into `5m` and `1h`, and `openai` (the default for other names) takes one `default` rate. Your file always wins over the bundled and synced prices, and Sync, Undo and Reset never change it. The panel picks up edits on the next refresh and lists any line it couldn't use.

## More machines and folders

By default the plugin reads this machine's `~/.claude`, `~/.config/claude` and `~/.codex`, plus `CLAUDE_CONFIG_DIR` and `CODEX_HOME` when they're set, and every Claude profile and Codex account home Orca manages. A new account shows up on the next scan.

Histories from all of them are combined. A transcript that several accounts share counts once, and so does a hard link or a copied Codex turn. Codex turns are matched by turn ID, so a session resumed or copied under a new session ID still counts once. Older Codex logs have no turn IDs and can't be matched across sessions. The transcripts don't say which subscription paid for a turn, so the totals cover all accounts together. The source strip under the filters shows each folder's status, files, turns and latest usage, and a transcript that several folders share is counted in each of them there.

Click a folder there to leave it out, and click it again to count it again. A folder you turn off stays off after a restart; the list is in Settings as **Turned-off transcript folders**. Turning one back on doesn't read its files again.

You can add more in **Settings → Plugins → Usage Insights**, one per line:

**Extra folders**, for a WSL install, a second config folder or an old backup:

```text
\\wsl.localhost\Ubuntu\home\you\.claude
~/backup/.claude
```

**SSH hosts**, to include usage from your other machines. Use a name from `~/.ssh/config` or `user@host`. Add `name = host` to show a short name instead of the address:

```text
devbox
aws = ec2-1-2-3-4.compute.amazonaws.com
```

It uses your own `ssh` with your keys or ssh-agent, and never asks for a password. The other machine needs to be Linux or macOS. The first pull takes a little while on a big history, then only new lines come over. Each source shows its status in the strip under the filters, with the reason if something fails.

Using an Orca server? Install the plugin there too, or add the server as an SSH host to see it here.

The first scan after this update reads every Codex transcript again, so copied turns can be matched. Claude transcripts aren't read again. An offline SSH host shows its Codex history again when it reconnects.

## Speed

Measured on a history of about 5,100 transcripts and 418,000 turns:

* **Opening the panel** takes about 0.3 s, from the cache. The very first open, with no cache, reads everything once in about 2 s.
* **After an agent turn**, only the new lines are read, and only the changed transcript is merged again (a few milliseconds).
* **Breakdown** reads every transcript the first time (a few seconds). After that it opens in about 0.2 s; switching back to a view or clicking into a project takes about 30 ms, and a view after new activity is rebuilt in about 0.1 s.
* **Memory**: the records take about 110 MB, and Breakdown about 50 MB more once opened. The first full read uses up to about 1 GB for a few seconds while it reads in parallel.

The first open after updating from 1.1.0 reads everything once, like a first install, because the cache now keeps more per turn (such as 1-hour cache writes).

## Privacy

Your transcripts stay on your machines. The plugin makes no network requests of its own, with two exceptions you start yourself: the SSH connections you add, and **Sync prices**, which downloads the public price lists from `raw.githubusercontent.com` (LiteLLM) and `models.dev` when you click it. Nothing about your usage is sent with those requests.

**What it reads:** your Claude Code and Codex transcripts, including Codex's compressed `.jsonl.zst` files.

**What it keeps** in its cache folder, so later opens are fast:

* token counts, times, model names and project folders;
* for Breakdown, a small file per transcript (plus one with where to read on from, for transcripts that can grow) with token counts per bucket, file paths (relative to the project or under `~`; any other absolute path keeps at most its first five folders, such as `/usr/lib/node_modules/typescript/lib`, with a user name under `home` or `Users` replaced by `*`), and command families. A command family is the program and, for a few tools like `git` or `npm`, the subcommand (`$ git status`). Arguments are dropped.

It never stores message text, tool output, command arguments or file contents. The Explain prompt only contains numbers, paths and read commands; it is shown for you to copy, and nothing is sent anywhere until you paste it into an agent.

It needs Orca's "full access" because a panel can't read files on its own. The worker does the reading and sends the panel only the finished numbers. It also asks to read your workspace list (for the worktrees filter), its own settings, and when agents finish (to refresh right after a turn).

## Development

Plain Node 24 with no dependencies (Node's built-in zstd needs 23.8 or newer).

```sh
node scripts/build.mjs          # bundle src/panel into panel/index.html (commit it)
node --test tests/*.test.mjs    # tests
orca plugin dev load .          # try it in Orca
```

There's also `scripts/preview.mjs` to render the panel with your own data in a browser (`--breakdown` opens the Breakdown view), `scripts/bench-worker.mjs` to time it, `scripts/prices.mjs` to regenerate the bundled prices from a LiteLLM price file, and `scripts/media/render.mjs`, which makes the images above from made-up demo data.

## License

MIT
