"use server";

/**
 * SVOD stage 2: catalogue library actions retired. The shelf is owned +
 * explicitly granted bases (brain_members). These stubs keep forged POSTs
 * from writing library rows.
 */
export async function addBrain(
  _prev: unknown,
  _formData: FormData,
): Promise<{ ok?: true; already?: boolean; error?: string }> {
  void _prev;
  void _formData;
  return { error: "Retired: the catalogue is closed. Ask your administrator for access." };
}

export async function dropBrain(_formData: FormData): Promise<void> {
  void _formData;
  return;
}
