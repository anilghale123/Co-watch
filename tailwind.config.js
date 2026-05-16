// tailwind.config.js
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/app/**/*.{js,jsx}',
    './src/components/**/*.{js,jsx}',
    './src/features/**/*.{js,jsx}',
  ],
  theme: {
    extend: {
      colors: {
        ink: '#0b0b12',
        panel: '#14141f',
        edge: '#26263a',
        accent: '#ff5d8f',
        accent2: '#7c5cff',
      },
      keyframes: {
        'fade-in': { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
        pulse2: { '0%,100%': { opacity: '1' }, '50%': { opacity: '0.4' } },
      },
      animation: {
        'fade-in': 'fade-in 160ms ease-out',
        pulse2: 'pulse2 1.4s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
