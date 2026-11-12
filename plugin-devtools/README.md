# mozg-devtools

The hands for [PixiJS 8 for Casino Games](https://mozg.sh/b/mozg/pixijs-casino).

That brain is full of numbers: draw-call budgets, texture memory ceilings, what
a mobile frame can afford. Every one of them is a claim about a running game,
and a claim nobody measured is a guess with a decimal point on it. This is what
measures.

## Install

```bash
/plugin marketplace add bojlahg/svod
/plugin install svod-devtools@svod
```

Needs Node. The server is fetched from npm on first run, so there is nothing
else to install.

## What it runs

Google's [`chrome-devtools-mcp`](https://www.npmjs.com/package/chrome-devtools-mcp),
launched as:

```
npx -y chrome-devtools-mcp@latest --channel=stable --isolated=true
```

`--isolated=true` on purpose: it drives a throwaway browser profile instead of
your real one, so profiling a game never touches your logins, cookies or tabs.
Drop the flag in your own config if you specifically need a signed-in session.

mozg neither publishes nor maintains that server — this plugin is the wiring
and the flags, so the brain has something to point at.

## What the agent gets

Performance traces with insight analysis, a Lighthouse audit, console messages,
network requests, screenshots and snapshots, plus the input tools to drive the
game to the moment worth measuring.

Useful pairing: ask the brain for the budget, then take the trace and see
whether the game is inside it. The brain has the number; only the trace knows
whether you are over.
