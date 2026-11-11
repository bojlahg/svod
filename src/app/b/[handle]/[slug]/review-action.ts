"use server";

/**
 * SVOD stage 2: public reviews retired with the catalogue.
 */
export async function submitReview(
  _prev: unknown,
  _formData: FormData,
): Promise<{ ok?: true; error?: string }> {
  void _prev;
  void _formData;
  return { error: "Retired." };
}
