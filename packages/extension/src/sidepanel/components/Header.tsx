export function Header() {
  return (
    <header className="flex items-center justify-between px-5 py-3.5 bg-background border-b border-gray-200 sticky top-0 z-10">
      <div className="flex items-center gap-2">
        <span className="material-icons text-primary text-xl">shopping_bag</span>
        <h1 className="text-lg font-semibold text-text-main">Personal Shopper</h1>
      </div>
      <button
        className="w-8 h-8 flex items-center justify-center rounded-full text-text-muted hover:bg-gray-200 transition-colors"
        aria-label="Settings"
      >
        <span className="material-icons text-xl">settings</span>
      </button>
    </header>
  );
}
