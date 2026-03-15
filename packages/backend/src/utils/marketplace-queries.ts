const TARGET_MARKETPLACES = [
  "dhgate.com",
  "temu.com",
  "1688.com",
];

export function generateMarketplaceQueries(productName: string): string[] {
  const trimmed = productName.trim();
  if (!trimmed) return [];
  return TARGET_MARKETPLACES.map((domain) => `${trimmed} site:${domain}`);
}
