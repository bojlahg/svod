"use server";

/**
 * SVOD stage 2: brain purchases retired. No invoices, no purchases written —
 * forged POSTs change nothing. Access is per-base roles in /admin/users.
 */
export async function buyWithCrypto(
  _prev: unknown,
  _formData: FormData,
): Promise<{ payUrl?: string; error?: string }> {
  void _prev;
  void _formData;
  return { error: "Retired: bases are private and not for sale." };
}

export async function buyBrain(
  _prev: unknown,
  _formData: FormData,
): Promise<{ ok?: true; topUp?: true; error?: string }> {
  void _prev;
  void _formData;
  return { error: "Retired: bases are private and not for sale." };
}
