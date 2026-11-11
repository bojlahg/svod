import { z } from "zod";

/**
 * Validated process env. Import this instead of touching process.env directly —
 * a missing var should fail at boot with a readable message, not at 3am inside
 * an ingest job.
 */
/**
 * A blank line in a .env file parses to "", which would defeat .default()
 * (and coerce to 0 for numbers — dangerous for settlement depths). Treat
 * empty as unset so the default applies.
 */
const defaulted = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === "" ? undefined : v), schema);

const schema = z.object({
  DATABASE_URL: z.string().min(1),

  // Blank in .env means unset (compose ships ANTHROPIC_API_KEY= empty) —
  // the app boots and serves without a model key; extraction and exams
  // refuse with a clear error only when actually used.
  ANTHROPIC_API_KEY: defaulted(z.string().min(1).optional()),
  // Any Anthropic-compatible endpoint. Lets the app run through a reseller
  // (apimart, OpenRouter, …) when a card for console.anthropic.com is not an
  // option — the request and response shapes are identical, so nothing else
  // in the codebase changes.
  ANTHROPIC_BASE_URL: z.string().url().optional(),
  MODEL_EXTRACT: z.string().default("claude-opus-5"),
  MODEL_JUDGE: z.string().default("claude-haiku-4-5"),
  // Unset means "same as the judge" — resolved at the call site. The judge id
  // is the one already proven to resolve on whatever proxy prod points at;
  // a separate default here is how translate broke while exams worked.
  MODEL_TRANSLATE: z.string().optional(),
  // Used when the provider refuses a model outright (not a request): apimart
  // cut Haiku/Sonnet 4.5 on 2026-09-23 and every ingest and exam died with it.
  // Empty string disables the fallback.
  MODEL_FALLBACK: z.string().default("claude-sonnet-5"),
  // Web push (operator notifications). Absent = the feature is quietly off.
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  // The judge is not deterministic: the same brain re-sat the same exam and
  // moved ±10 points (62→51 on one, 49→46 on another). An odd number of votes
  // with majority rule turns that noise into a stable number the owner can
  // read week over week. 3 triples the judge cost — which is Haiku, cents —
  // set 1 to trade stability back for the cheapest possible run.
  JUDGE_VOTES: z.coerce.number().int().min(1).max(5).default(3),
  INGEST_USE_BATCH: z.stringbool().default(false),
  INGEST_IMAGE_MAX_EDGE: z.coerce.number().int().min(512).max(2576).default(1568),

  EMBED_URL: z.string().url().default("http://localhost:8099"),
  EMBED_DIM: z.coerce.number().int().default(1024),
  // Interactive lane: query embedding and reranking, the two calls a caller
  // waits on. Separate in production so they never queue behind an ingest
  // batch; unset (self-host, dev) they are the same process as EMBED_URL and
  // nothing changes. Both are filled in after parse.
  EMBED_QUERY_URL: z.string().url().optional(),
  RERANK_URL: z.string().url().optional(),

  // Headless renderer for JS-shell docs sites (services/render). Unset, those
  // sites fall back to their GitHub repository or an honest refusal.
  RENDER_URL: z.string().url().optional(),

  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  STORAGE_LOCAL_DIR: z.string().default("./.storage"),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default("auto"),
  S3_ENDPOINT: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),

  // Blank in .env means unset, so the self-host bootstrapper can reject it
  // with its own message (generate with `openssl rand -hex 32`).
  BETTER_AUTH_SECRET: defaulted(z.string().min(16).optional()),
  BETTER_AUTH_URL: z.string().url().default("http://localhost:3300"),
  // Shared secret for repository push callbacks (/api/github/push). One
  // platform-wide value the owner also pastes into their repo's webhook
  // settings: a per-repo secret would need a place to live and a UI to set it,
  // and the thing being protected is "requeue a crawl the schedule would run
  // anyway", not money.
  GITHUB_WEBHOOK_SECRET: z.string().optional(),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3300"),
  // Google Search Console's HTML-tag verification. Paste the content= value
  // from the console; unset means no tag is rendered.
  GOOGLE_SITE_VERIFICATION: z.string().optional(),

  // Set once an email provider is wired up. Until then the product cannot send
  // a verification link or a password reset, so signing up with a password
  // creates an account that can never be verified and never recovered.
  EMAIL_FROM: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),

  // Crypto top-ups. Inert until both exist: an invoice we cannot verify a
  // callback for would be a balance credited by anyone who guesses a URL.
  NOWPAYMENTS_API_KEY: z.string().optional(),
  NOWPAYMENTS_IPN_SECRET: z.string().optional(),

  // mozgpay: our own crypto acceptance. Addresses are the owner's wallets —
  // the server watches them, it cannot spend from them. Each coin turns on
  // by its address existing. Optional TronGrid key raises rate limits;
  // MOZGPAY_ETH_EXPLORER overrides the Ethereum explorer the watcher reads.
  MOZGPAY_TRON_ADDRESS: z.string().optional(),
  MOZGPAY_ETH_ADDRESS: z.string().optional(),
  MOZGPAY_SOL_ADDRESS: z.string().optional(),
  MOZGPAY_BTC_ADDRESS: z.string().optional(),
  // Blockscout's public Ethereum instance: address-indexed, no key, no log
  // range limit. The RPC it replaces defaulted to a host that now answers 521,
  // and no free node tested will serve a day-wide eth_getLogs — see readEvm.
  MOZGPAY_ETH_EXPLORER: z.string().url().default("https://eth.blockscout.com"),
  TRONGRID_API_KEY: z.string().optional(),
  // Settlement depth: a transfer counts only once this many blocks (Solana:
  // slots) sit on top of the one carrying it. Tron counts from the solidified
  // tip, so 0 means inclusion in a solid block is enough. Below the threshold
  // the invoice just stays pending for the watcher's next tick.
  MOZGPAY_EVM_CONFIRMATIONS: defaulted(z.coerce.number().int().min(0).default(12)),
  MOZGPAY_BTC_CONFIRMATIONS: defaulted(z.coerce.number().int().min(0).default(3)),
  MOZGPAY_SOL_CONFIRMATIONS: defaulted(z.coerce.number().int().min(0).default(32)),
  MOZGPAY_TRON_CONFIRMATIONS: defaulted(z.coerce.number().int().min(0).default(0)),

  // Nightly note consolidation. Off until the similarity threshold separates
  // duplicates from neighbours on real material — measured on bge-m3, three
  // notes stating the same fact sat at 0.15/0.22/0.27 while the first pair of
  // genuinely different facts sat at 0.2766, so there is no threshold that
  // catches the duplicates without gluing unrelated facts together. Merging is
  // destructive; an unattended job should not run on a number nobody has
  // validated.
  CONSOLIDATE_ENABLED: z.stringbool().default(false),

  // Nightly cross-brain contradiction hunt. On by default, unlike its
  // neighbour above, for two reasons: it writes a row and changes no note, so
  // a wrong verdict is a line somebody can dismiss rather than a fact lost;
  // and it only ever looks inside a pack, so an installation that ships no
  // packs finds no candidates and pays for nothing.
  CONTRADICT_ENABLED: z.stringbool().default(true),

  // Worker serves payments, digests and paid images but consumes none of the
  // queues that spend the platform's model key (see LEARNING_QUEUES). Jobs wait
  // in pg-boss and run when this is turned off again.
  LEARNING_OFF: z.stringbool().default(false),

  // Comma-separated addresses that may open /admin. Empty means nobody can —
  // an admin surface that defaults to open is a breach waiting for its first
  // sign-up.
  ADMIN_EMAILS: z.string().default(""),

  // SVOD self-host administrator. When set, the app provisions this account on
  // startup and treats it as an admin alongside ADMIN_EMAILS. Empty means
  // unset, so legacy deploys that only use ADMIN_EMAILS keep working.
  // Trimmed with the same zod email rule the bootstrapper validates with.
  MOZG_ADMIN_EMAIL: defaulted(z.string().trim().email().optional()),
  MOZG_ADMIN_PASSWORD: defaulted(z.string().min(1).optional()),

  // Where user chat messages and ops alerts (deploy/healthwatch.sh) go. The
  // default keeps existing deploys mailing the operator as before.
  OPERATOR_EMAIL: defaulted(z.string().email().default("egorfdrv@gmail.com")),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  ${i.path.join(".")}: ${i.message}`)
    .join("\n");
  throw new Error(`Invalid environment:\n${issues}\n\nCopy .env.example to .env`);
}

const queryUrl = parsed.data.EMBED_QUERY_URL ?? parsed.data.EMBED_URL;

export const env = {
  ...parsed.data,
  EMBED_QUERY_URL: queryUrl,
  // The reranker only ever serves interactive calls, so it follows the query
  // lane rather than the ingest one.
  RERANK_URL: parsed.data.RERANK_URL ?? queryUrl,
};

/**
 * Can the product send mail? Everything that depends on reaching someone by
 * email is gated on this, so wiring a provider turns those paths on rather
 * than requiring them to be found and un-commented.
 */
export const emailReady = Boolean(env.RESEND_API_KEY && env.EMAIL_FROM);

/** S3 driver needs its whole credential set or none of it. */
if (env.STORAGE_DRIVER === "s3") {
  const missing = (
    ["S3_BUCKET", "S3_ENDPOINT", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const
  ).filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(`STORAGE_DRIVER=s3 but missing: ${missing.join(", ")}`);
  }
}
