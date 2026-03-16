import type { SearchResponse } from "@shopping-assistant/shared";

interface Props {
  productPrice: number | null;
  currency?: string | null;
  response: SearchResponse;
  collapsed?: boolean;
  onToggle?: () => void;
}

export function PriceBar({ productPrice, currency, response, collapsed, onToggle }: Props) {
  const currencySymbol = currency === "USD" || !currency ? "$" : currency === "EUR" ? "€" : currency === "GBP" ? "£" : `${currency} `;

  // Use the top 5 priced results for the scale and comparison message.
  const topPrices = response.results
    .filter((r) => r.result.price !== null)
    .slice(0, 5)
    .map((r) => r.result.price!);

  if (topPrices.length === 0 || productPrice === null) return null;

  const scalePrices = [...topPrices, productPrice];
  const low = Math.min(...scalePrices);
  const high = Math.max(...scalePrices);
  const range = high - low;
  if (range === 0) return null;

  const position = ((productPrice - low) / range) * 100;

  // Best price among top 5 alternatives
  const topWithPrices = response.results
    .filter((r) => r.result.price !== null)
    .slice(0, 5);
  const bestTopPrice = Math.min(...topPrices);
  const bestResult = topWithPrices.find((r) => r.result.price === bestTopPrice);

  // Average from top 5 for the comparison message
  const topAvg = topPrices.reduce((a, b) => a + b, 0) / topPrices.length;
  const aboveAvg = Math.round(((productPrice - topAvg) / topAvg) * 100);

  const label = position > 66 ? "HIGH" : position > 33 ? "FAIR" : "LOW";
  const labelColor = position > 66 ? "text-accent-red" : position > 33 ? "text-accent-yellow" : "text-accent-green";
  const dotBorder = position > 66 ? "border-accent-red" : position > 33 ? "border-accent-yellow" : "border-accent-green";

  if (collapsed) {
    return (
      <button onClick={onToggle} className="w-full bg-surface rounded-2xl px-4 py-2.5 shadow-soft border border-gray-100 flex items-center gap-2 text-left">
        <span className="material-icons text-sm text-accent-red">warning_amber</span>
        <span className="text-sm text-text-muted">Price is <span className={`font-bold ${labelColor}`}>{label}</span></span>
        <span className="material-icons text-xs text-text-muted ml-auto">expand_more</span>
      </button>
    );
  }

  return (
    <section className="bg-surface rounded-2xl p-4 shadow-soft border border-gray-100">
      {onToggle ? (
        <button onClick={onToggle} className="w-full flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span className="material-icons text-sm text-accent-red">warning_amber</span>
            <span className="text-sm text-text-muted">This price is</span>
            <span className={`text-sm font-bold ${labelColor}`}>{label}</span>
          </div>
          <span className="material-icons text-xs text-text-muted">expand_less</span>
        </button>
      ) : (
        <div className="flex items-center gap-2 mb-3">
          <span className="material-icons text-sm text-accent-red">warning_amber</span>
          <span className="text-sm text-text-muted">This price is</span>
          <span className={`text-sm font-bold ${labelColor}`}>{label}</span>
        </div>
      )}

      {/* Gradient bar — scale based on top 3 alternatives */}
      <div className="relative h-2 rounded-full w-full mb-2 bg-gradient-to-r from-accent-green via-accent-yellow to-accent-red">
        <div
          className={`absolute top-1/2 -translate-y-1/2 w-4 h-4 bg-white rounded-full border-4 ${dotBorder} shadow-sm z-10`}
          style={{ left: `${Math.min(Math.max(position, 5), 95)}%` }}
        />
      </div>
      <div className="flex justify-between text-xs text-text-muted mb-4">
        <span>{currencySymbol}{low.toFixed(2)}</span>
        <span>{currencySymbol}{high.toFixed(2)}</span>
      </div>

      {/* AI insight */}
      {bestResult && (
        <div className="bg-orange-50 border border-orange-100 rounded-xl p-3 flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-accent-green flex items-center justify-center text-white shrink-0 shadow-sm">
            <span className="material-icons text-sm">smart_toy</span>
          </div>
          <p className="text-sm text-text-main leading-snug">
            {aboveAvg > 0 ? (
              <>
                <span className="font-bold text-primary">{aboveAvg}%</span> above top alternatives.
                Best on {bestResult.result.marketplace}.
              </>
            ) : (
              <>This price is competitive vs. top alternatives.</>
            )}
          </p>
        </div>
      )}
    </section>
  );
}
