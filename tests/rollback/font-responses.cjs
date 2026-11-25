// Next's supported test-only font response hook. Builds remain completely
// offline; visual font fidelity is outside this operational process drill.
const path = require('node:path');
module.exports = new Proxy({}, {
  get(_target, url) {
    if (typeof url !== 'string' || !url.startsWith('https://fonts.googleapis.com/css2?')) return undefined;
    const family = new URL(url).searchParams.get('family').split(':')[0];
    const fonts = { Geist: 'geist', 'Geist Mono': 'noto-sans-mono', Fraunces: 'fraunces', 'Barlow Condensed': 'barlow-condensed', 'Playfair Display': 'playfair-display' };
    const font = fonts[family];
    if (!font) throw new Error('Unconfigured local rehearsal font: ' + family);
    const file = path.join(__dirname, '../../node_modules/@fontsource', font, 'files', `${font}-latin-400-normal.woff2`);
    return `/* latin */\n@font-face { font-family: '${family}'; font-style: normal; font-weight: 100 900; src: url(${file}) format('woff2'); }`;
  },
});
