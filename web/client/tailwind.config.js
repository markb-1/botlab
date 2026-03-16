/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: '#1a1a1a',
          light: '#222222',
          dark: '#111111',
        },
        sidebar: {
          DEFAULT: '#0f0f0f',
          hover: '#1a1a1a',
          active: '#1a1a1a',
        },
        accent: {
          DEFAULT: '#e8622c',
          hover: '#f07040',
          muted: 'rgba(232, 98, 44, 0.15)',
        },
      },
    },
  },
  plugins: [],
}
