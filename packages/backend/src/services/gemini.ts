// Gemini Flash client for identification, grounded search, and ranking
// TODO: Implement with @google/generative-ai SDK

export async function identifyProduct(imageUrl: string, title: string | null) {
  throw new Error("Not implemented: identifyProduct");
}

export async function groundedSearch(queries: string[]) {
  throw new Error("Not implemented: groundedSearch");
}

export async function rankResults(
  originalImageUrl: string,
  resultImageUrls: string[],
) {
  throw new Error("Not implemented: rankResults");
}
