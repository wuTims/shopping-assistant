import type { RankedResult } from "@shopping-assistant/shared";

interface Props {
  ranked: RankedResult;
  compact?: boolean;
}

export function ResultCard({ ranked, compact }: Props) {
  const { result } = ranked;
  const priceStr = result.price !== null
    ? new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: result.currency || "USD",
      }).format(result.price)
    : null;

  // Cheaper: savingsPercent < 0 (result costs less than original)
  const savingsStr = ranked.savingsPercent !== null && ranked.savingsPercent < 0
    ? `${Math.abs(ranked.savingsPercent).toFixed(0)}% less`
    : null;

  // More expensive: show markup percentage
  const markupStr = ranked.savingsPercent !== null && ranked.savingsPercent > 10
    ? `${ranked.savingsPercent.toFixed(0)}% more`
    : null;

  const handleClick = () => {
    try {
      const url = new URL(result.productUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") return;
      window.open(url.href, "_blank", "noopener");
    } catch {
      // Malformed URL — ignore click
    }
  };

  const confidenceIndicator =
    ranked.confidence === "medium" ? (
      <span className="text-xs text-accent-yellow font-medium">Similar</span>
    ) : ranked.confidence === "low" ? (
      <span className="text-xs text-text-muted font-medium">May differ</span>
    ) : null;

  if (compact) {
    return (
      <button
        onClick={handleClick}
        className="w-full flex items-center gap-2.5 py-2 px-1 hover:bg-gray-50 rounded-lg transition-colors text-left group"
      >
        {result.imageUrl && (
          <img
            src={result.imageUrl}
            alt={result.title}
            className="w-8 h-8 rounded-lg object-cover mix-blend-multiply opacity-90 group-hover:opacity-100 shrink-0"
          />
        )}
        <span className="text-xs text-text-muted font-medium shrink-0 w-20 truncate">{result.marketplace}</span>
        <span className="text-xs text-text-main truncate flex-1">{result.title}</span>
        <span className={`text-sm font-bold shrink-0 ${priceStr ? "text-text-main" : "text-text-muted"}`}>{priceStr ?? "See price"}</span>
        {savingsStr && (
          <span className="text-xs text-accent-green font-medium shrink-0">-{Math.abs(ranked.savingsPercent!).toFixed(0)}%</span>
        )}
        {markupStr && (
          <span className="text-xs text-text-muted font-medium shrink-0">+{ranked.savingsPercent?.toFixed(0)}%</span>
        )}
      </button>
    );
  }

  return (
    <button
      onClick={handleClick}
      className="w-full flex items-center justify-between group py-1 text-left"
    >
      <div className="flex items-center gap-3 min-w-0">
        {result.imageUrl && (
          <img
            src={result.imageUrl}
            alt={result.title}
            className="w-12 h-12 rounded-xl object-cover mix-blend-multiply opacity-90 group-hover:opacity-100 transition-opacity shrink-0"
          />
        )}
        <div className="min-w-0">
          <h4 className="font-medium text-text-main text-sm truncate max-w-[160px]">{result.title}</h4>
          <p className="text-text-muted text-xs">{result.marketplace}</p>
          {confidenceIndicator}
        </div>
      </div>
      <div className="text-right shrink-0 ml-2">
        <p className={`font-bold text-base ${priceStr ? "text-text-main" : "text-text-muted text-sm"}`}>{priceStr ?? "See price"}</p>
        {savingsStr && (
          <p className="text-accent-green text-xs font-medium">{savingsStr}</p>
        )}
        {markupStr && (
          <p className="text-text-muted text-xs font-medium">{markupStr}</p>
        )}
      </div>
    </button>
  );
}
