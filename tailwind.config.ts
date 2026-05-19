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
          50: "#effefa",
          100: "#ccfbf1",
          500: "#14b8a6",
          600: "#0d9488",
          700: "#0f766e"
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
