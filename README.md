<h1 align="center">
  <img src="images/icon.png" alt="" height="72"><br>
  Usage Insights
</h1>

<h3 align="center">See how much Claude Code and Codex you actually use, inside Orca.</h3>

<p align="center">
  <a href="#install">Install</a> •
  <a href="#what-you-get">What you get</a> •
  <a href="#more-machines-and-folders">More machines</a> •
  <a href="#privacy">Privacy</a> •
  <a href="https://www.onorca.dev/plugins/Etherll/orca-usage-insights">Plugin page</a>
</p>

<p align="center">
  <img src="images/cover.png" alt="Usage Insights in an Orca window: token totals, a split by provider and machine, and a daily trend" width="900">
</p>

## Install

Install it from the [plugin page](https://www.onorca.dev/plugins/Etherll/orca-usage-insights), or in Orca go to **Settings → Plugins → Add plugin → From a Git URL** and paste `https://github.com/Etherll/orca-usage-insights`. Orca asks you to approve it first, because it reads files on your machine (more on that [below](#privacy)).

Then open it from the bar chart icon in the right sidebar.

Needs Orca 1.4.248 or newer.

## What you get

The panel reads your Claude Code and Codex transcripts and turns them into:

* **Totals** for 7 days, 30 days, 90 days or everything: tokens, estimated cost, today, cache hit rate, sessions and your streak.
* **Daily charts** of tokens or cost, per token type and per provider.
* **A 26-week activity calendar** and a weekday by hour chart of when you work.
* **Breakdowns** by model, project and machine.
* **A pixel-art skyline** at the top, drawn from your daily usage. The stars are your streak.

One **Filters** menu narrows it down: only sessions that ran in an Orca worktree, one provider, one machine, or no cache tokens.

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

Cost is an estimate at Anthropic's list API prices, so it's what the same tokens would cost on the API, not your bill. Codex models have no prices yet, so they count toward tokens but not cost.

## More machines and folders

By default the plugin reads this machine's `~/.claude` and `~/.codex`. You can add more in **Settings → Plugins → Usage Insights**, one per line:

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

## Privacy

Your transcripts stay on your machines. The plugin doesn't make network requests, apart from the SSH connections you set up yourself. It skips the message text in your transcripts and never stores it. It keeps a small cache of the numbers (tokens, times, models, project folders) in your cache folder, so later opens are fast.

It needs Orca's "full access" because a panel can't read files on its own. The worker does the reading and sends the panel only the finished numbers. It also asks to read your workspace list (for the worktrees filter) and its own settings.

## Development

Plain Node 22 with no dependencies.

```sh
node scripts/build.mjs          # bundle src/panel into panel/index.html (commit it)
node --test tests/*.test.mjs    # tests
orca plugin dev load .          # try it in Orca
```

There's also `scripts/preview.mjs` to render the panel with your own data in a browser, `scripts/bench-worker.mjs` to time it, and `scripts/media/render.mjs`, which makes the images above from made-up demo data.

## License

MIT
