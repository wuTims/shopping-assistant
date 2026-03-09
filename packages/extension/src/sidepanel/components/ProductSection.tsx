import type { ProductDisplayInfo } from "@shopping-assistant/shared";

interface Props {
  product: ProductDisplayInfo;
}

export function ProductSection({ product }: Props) {
  const priceStr = product.price !== null
    ? `${product.currency === "USD" || !product.currency ? "$" : product.currency}${product.price}`
    : null;

  return (
    <section className="bg-surface rounded-2xl p-4 shadow-soft border border-gray-100">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {product.imageUrl ? (
            <img
              src={product.imageUrl}
              alt={product.name}
              className="w-14 h-14 rounded-xl object-cover shadow-sm"
            />
          ) : (
            <div className="w-14 h-14 rounded-xl bg-gray-100 flex items-center justify-center shadow-sm">
              <span className="material-icons text-2xl text-gray-300">image</span>
            </div>
          )}
          <div className="min-w-0">
            <p className="text-xs text-text-muted font-medium">Current Product</p>
            <p className="text-base font-bold text-text-main mt-0.5 truncate max-w-[180px]">
              {product.name}
              {priceStr && <span className="text-primary ml-1.5">{priceStr}</span>}
            </p>
            {product.marketplace && (
              <p className="text-xs text-text-muted">on {product.marketplace}</p>
            )}
          </div>
        </div>
        <span className="bg-orange-100 text-primary text-xs font-semibold px-2.5 py-1 rounded-full shadow-sm whitespace-nowrap">
          You're Here
        </span>
      </div>
    </section>
  );
}
