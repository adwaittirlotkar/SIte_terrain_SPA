/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        base: "#0B0F14",
        panel: "#111826",
        panelAlt: "#0E141F",
        line: "#1E2733",
        border: "#233040",
        ink: "#E6EDF3",
        muted: "#7C8B99",
        amber: "#E8A33D",
        teal: "#4FD1C5",
        warn: "#E8623D",
      },
      fontFamily: {
        display: ["Space Grotesk", "sans-serif"],
        body: ["IBM Plex Sans", "sans-serif"],
        mono: ["IBM Plex Mono", "monospace"],
      },
    },
  },
  plugins: [],
};
