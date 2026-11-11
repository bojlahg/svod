/**
 * Print the self-host session secret as a single line, nothing else.
 *
 * Used by release/compose.yaml BEFORE migrations: the shell does
 * `export BETTER_AUTH_SECRET=$(node dist/selfhost-secret.mjs)` when the
 * environment has no usable secret, then runs dist/selfhost-start.mjs and
 * Next. Setting process.env inside Node would not reach the next `&&`
 * process, hence a separate step.
 *
 * Deliberately imports only ../src/lib/session-secret (fs/path/crypto):
 * no @/lib/env, no @/lib/auth — those read the secret at import time.
 */
import { resolveSessionSecret } from "../src/lib/session-secret";

const secret = resolveSessionSecret(process.env);
process.stdout.write(`${secret}\n`);
