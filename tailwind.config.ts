import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}"
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#f1f8f4",
          100: "#e2f1e8",
          200: "#bfe8cf",
          300: "#7ee0a7",
          400: "#58cc8d",
          500: "#35b779",
          600: "#1e7c54",
          700: "#0c3b2e",
          800: "#082f25",
          900: "#06251d",
          950: "#031812"
        },
        ink: "#17202a"
      },
      boxShadow: {
        soft: "0 8px 24px rgba(15, 23, 42, 0.07)"
      }
    }
  },
  plugins: []
};

export default config;
