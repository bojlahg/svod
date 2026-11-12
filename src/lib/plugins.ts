/**
 * The plugins mozg publishes, and the only install commands the product will
 * ever print.
 *
 * This list exists because of a mistake worth not repeating. A brain used to
 * carry a free-text install line written by its owner, and the first one
 * written was `uvx spine-mcp` — a package that does not exist. Told to a
 * stranger's agent that would have failed, or, far worse, installed whatever
 * unrelated thing had taken that name. A public brain is a channel anybody can
 * publish into, so "the owner typed a shell command and we showed it to an
 * agent" was never a safe shape.
 *
 * So a brain no longer says how to install anything. It names a plugin, and
 * the command is generated here from a list of things mozg actually ships.
 * An unknown name renders nothing at all — the failure mode is silence, which
 * is the correct one when the alternative is a command that lies.
 *
 * A tool mozg does not publish gets a documentation link instead. A link is
 * read by a person before anything happens; a command is run.
 */

/** The marketplace these are installed from — `<plugin>@<marketplace>`. */
export const MARKETPLACE = "svod";

/** Where a first-time reader adds the marketplace before installing anything. */
export const MARKETPLACE_SOURCE = "bojlahg/svod";

/**
 * Everything mozg publishes. Keys are the plugin names in marketplace.json —
 * if the two disagree the command is wrong, so they are checked against each
 * other in the tests rather than trusted to stay in step by hand.
 */
export const PLUGINS: Record<string, string> = {
  svod: "The brains themselves: search them, and write back what you work out.",
  // The hands for the Spine brain. Listed here is what turns the brain's
  // declared tool into a real install line — see brains.tools and 0087.
  "svod-spine":
    "Rig a cut-up character into an animated Spine skeleton, pack atlases, export runtime json.",
  // Google's chrome-devtools-mcp, wired with an isolated profile.
  "svod-devtools":
    "Measure a running game: performance traces, FPS, draw calls, console and network.",
  // Wiring only — stakecli is a binary the reader installs themselves, so the
  // brain carries a docs link beside this command rather than instead of it.
  "svod-stake":
    "Upload math and front-end bundles to Stake Engine, check compliance, publish a release.",
};

/** Names stored before the product was called svod. They still install. */
const LEGACY_PLUGINS: Record<string, string> = {
  mozg: "svod",
  "mozg-spine": "svod-spine",
  "mozg-devtools": "svod-devtools",
  "mozg-stake": "svod-stake",
};

export function canonicalPlugin(name: string): string {
  return LEGACY_PLUGINS[name] ?? name;
}

/**
 * The companion plugins — everything except the brains themselves.
 *
 * Their own list because /connect answers two different questions with them:
 * "how do I connect" is the mozg plugin, and "what else is there" is these.
 * Derived rather than written out again, so adding a plugin cannot leave the
 * page describing the catalogue it had last month.
 */
export function companionPlugins(): { name: string; what: string }[] {
  return Object.entries(PLUGINS)
    .filter(([name]) => name !== "svod")
    .map(([name, what]) => ({ name, what }));
}

export function isPublishedPlugin(name: string): boolean {
  return Object.hasOwn(PLUGINS, canonicalPlugin(name));
}

/**
 * How a reader installs one of ours. Null for anything not on the list — the
 * caller renders nothing rather than guessing at a command.
 */
export function installCommand(name: string): string | null {
  const key = canonicalPlugin(name);
  return Object.hasOwn(PLUGINS, key) ? `/plugin install ${key}@${MARKETPLACE}` : null;
}
