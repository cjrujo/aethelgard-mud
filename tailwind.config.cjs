module.exports = {
  content: ['./src/game.html', './src/*.js'],
  safelist: [
    { pattern: /^(bg|text|border)-(slate|sky|amber|emerald|rose|purple|cyan|indigo|orange|lime)-(100|200|300|400|500|600|700|800|900|950)$/ },
    'hidden', 'flex', 'grid', 'block', 'opacity-50', 'border-amber-400',
    'font-bold', 'font-semibold', 'text-left', 'text-center', 'text-white'
  ],
  theme: { extend: {} },
  plugins: []
};
