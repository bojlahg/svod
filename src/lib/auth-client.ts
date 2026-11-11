import { createAuthClient } from "better-auth/react";

/**
 * Same-origin by default. No absolute baseURL is passed on purpose: the
 * self-host image is built once (with a placeholder NEXT_PUBLIC_APP_URL),
 * then runs on localhost, a NAS address or a custom port. Relative "/api/auth"
 * posts to the browser's current origin wherever the image lands, while a
 * baked-in absolute URL would send the admin's password to mozg.sh.
 */
export const authClient = createAuthClient();

export const { signIn, signUp, signOut, useSession } = authClient;
