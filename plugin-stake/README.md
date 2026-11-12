# mozg-stake

The hands for [Stake Engine](https://mozg.sh/b/mozg/stake-engine) — the most
searched brain in the catalogue.

That brain knows the RGS wallet endpoints, what the math bundle must contain,
and what approval rejects. This plugin is what carries it out: upload the
bundle, check compliance, publish the release, read the approval thread.

## Install the binary first

**This plugin is wiring, not an installer.** It runs `stakecli`, and unlike a
package fetched at launch, that binary has to be on the machine already:

    https://github.com/mnemoo/cli

Follow the install steps there for your platform — there are `.deb`, `.rpm`,
`.tar.gz` and `.zip` builds. Then check it is on your `PATH`:

```bash
stakecli --version
```

If that prints nothing, this plugin's server will fail to start, and it will
say so rather than failing quietly.

## Then

```bash
/plugin marketplace add bojlahg/svod
/plugin install svod-stake@svod
```

## What it is, honestly

`stakecli` is **community-built and not affiliated with Stake Engine.** Its own
README says so. Until Stake ships a proper token flow it authenticates with a
session cookie, which is worth knowing before you point it at an account.

mozg does not publish, host, or vouch for the binary. This plugin declares how
to talk to it once you have decided to install it, and the brain it pairs with
says the same thing before you get here.

## What the agent gets

Upload planning and execution, publish with an explicit confirm step, local
math-bundle compliance checks, MLR reweighting for LUT CSVs, the approval
conversation with reply drafting, and a background daemon so uploads survive
the client exiting.

The brain is the half that knows *which* of those you need and what the
bundle has to look like before you run any of it.
