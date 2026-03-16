import type { ProductDisplayInfo } from "@shopping-assistant/shared";

interface Props {
  product: ProductDisplayInfo;
}

export function ProductSection({ product }: Props) {
  const priceStr = product.price !== null
    ? `${product.currency === "USD" || !product.currency ? "$" : product.currency}${product.price}`
    : null;

  // Detect if the "name" is just a price string (fallback when title extraction failed).
  // In that case, only show price — don't duplicate it.
  const nameIsPrice = /^[£$€¥]\d/.test(product.name);
  const showName = product.name && !nameIsPrice;
  const showPrice = priceStr !== null;

  return (
    <section className="bg-surface rounded-2xl p-4 shadow-soft border border-gray-100">
      <div className="flex items-center gap-3">
        {(product.imageUrl || product.displayImageDataUrl) ? (
          <img
            src={product.imageUrl || product.displayImageDataUrl}
            alt={showName ? product.name : "Product"}
            className="w-14 h-14 rounded-xl object-cover shadow-sm"
          />
        ) : (
          <div className="w-14 h-14 rounded-xl bg-gray-100 flex items-center justify-center shadow-sm">
            <span className="material-icons text-2xl text-gray-300">image</span>
          </div>
        )}
        <div className="min-w-0">
          <p className="text-xs text-text-muted font-medium">Current Product</p>
          {showName ? (
            <p className="text-base font-bold text-text-main mt-0.5 truncate max-w-[180px]">
              {product.name}
            </p>
          ) : !showPrice ? (
            <p className="text-base font-bold text-text-main mt-0.5 truncate max-w-[180px]">
              Searching…
            </p>
          ) : null}
          {showPrice && (
            <p className={`font-semibold text-primary ${showName ? "text-sm" : "text-base mt-0.5"}`}>{priceStr}</p>
          )}
          {product.marketplace && (
            <p className="text-xs text-text-muted">on {product.marketplace}</p>
          )}
        </div>
      </div>
    </section>
  );
}
