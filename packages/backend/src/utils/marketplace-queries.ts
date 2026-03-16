const TARGET_MARKETPLACES = [
  "aliexpress.com",
  "dhgate.com",
  "temu.com",
  "1688.com",
];

export function generateMarketplaceQueries(productName: string): string[] {
  const trimmed = productName.trim();
  if (!trimmed) return [];
  const queries = TARGET_MARKETPLACES.map((domain) => `${trimmed} site:${domain}`);
  console.log(`[marketplace-queries] Generated ${queries.length} queries for "${trimmed.slice(0, 60)}"`);
  return queries;
}
