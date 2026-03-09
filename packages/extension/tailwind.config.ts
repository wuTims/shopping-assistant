import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{ts,tsx,html}"],
  theme: {
    extend: {
      colors: {
        primary: "#d95a00",
        "primary-dark": "#b34800",
        background: "#fdfaf5",
        surface: "#ffffff",
        "text-main": "#1a202c",
        "text-muted": "#4a5568",
        "accent-green": "#10b981",
        "accent-red": "#ef4444",
        "accent-yellow": "#f59e0b",
      },
      fontFamily: {
        display: ["Inter", "sans-serif"],
      },
      boxShadow: {
        soft: "0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -1px rgba(0, 0, 0, 0.03)",
      },
    },
  },
  plugins: [],
} satisfies Config;
