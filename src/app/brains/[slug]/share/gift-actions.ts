"use server";

/**
 * SVOD stage 2: gift links are retired. Granting is per-base roles in
 * /admin/users (operator). Any forged POST lands here and changes nothing.
 */
export async function createGiftLink() {
  return;
}

export async function revokeGiftLink() {
  return;
}
