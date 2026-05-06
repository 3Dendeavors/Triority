const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '..', 'assets', 'logo.png');
const RES = path.resolve(__dirname, '..', 'android', 'app', 'src', 'main', 'res');
const BG_COLOR = '#0B0B10';

const densities = [
  { name: 'mdpi',    size: 48 },
  { name: 'hdpi',    size: 72 },
  { name: 'xhdpi',   size: 96 },
  { name: 'xxhdpi',  size: 144 },
  { name: 'xxxhdpi', size: 192 },
];

// Adaptive icons render on a 108dp canvas, of which only the inner 72dp is
// guaranteed visible after the launcher applies its mask. Foreground content
// should sit roughly within that inner 66% so it isn't cropped.
const FG_INNER_FRACTION = 72 / 108;

async function ensureDir(p) {
  await fs.promises.mkdir(p, { recursive: true });
}

async function generateLegacyAndForeground() {
  for (const { name, size } of densities) {
    const dir = path.join(RES, `mipmap-${name}`);
    await ensureDir(dir);

    // Legacy square icon (the logo, full bleed, on dark background)
    const legacy = await sharp({
      create: { width: size, height: size, channels: 4, background: BG_COLOR },
    })
      .composite([{
        input: await sharp(SRC).resize(size, size, { fit: 'contain' }).png().toBuffer(),
        gravity: 'center',
      }])
      .png()
      .toBuffer();
    await fs.promises.writeFile(path.join(dir, 'ic_launcher.png'), legacy);

    // Legacy round icon — same image but with a circular mask
    const r = size / 2;
    const circleSvg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><circle cx="${r}" cy="${r}" r="${r}" fill="white"/></svg>`
    );
    const round = await sharp(legacy)
      .composite([{ input: circleSvg, blend: 'dest-in' }])
      .png()
      .toBuffer();
    await fs.promises.writeFile(path.join(dir, 'ic_launcher_round.png'), round);

    // Adaptive foreground — logo at 66% on a transparent 108dp canvas.
    // Android renders this on top of the background drawable and applies the
    // launcher's mask shape (circle, squircle, rounded square, etc).
    const fgCanvas = size; // adaptive foreground PNG is the same physical size
    const innerSize = Math.round(fgCanvas * FG_INNER_FRACTION);
    const innerLogo = await sharp(SRC).resize(innerSize, innerSize, { fit: 'contain' }).png().toBuffer();
    const foreground = await sharp({
      create: { width: fgCanvas, height: fgCanvas, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([{ input: innerLogo, gravity: 'center' }])
      .png()
      .toBuffer();
    await fs.promises.writeFile(path.join(dir, 'ic_launcher_foreground.png'), foreground);
  }
}

async function writeAdaptiveXml() {
  const anydpi = path.join(RES, 'mipmap-anydpi-v26');
  await ensureDir(anydpi);
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
</adaptive-icon>
`;
  await fs.promises.writeFile(path.join(anydpi, 'ic_launcher.xml'), xml);
  await fs.promises.writeFile(path.join(anydpi, 'ic_launcher_round.xml'), xml);
}

async function writeBackgroundColor() {
  const valuesDir = path.join(RES, 'values');
  await ensureDir(valuesDir);
  const colorsPath = path.join(valuesDir, 'colors.xml');
  let existing = '';
  try { existing = await fs.promises.readFile(colorsPath, 'utf8'); } catch {}
  if (existing.includes('ic_launcher_background')) return; // already present
  if (existing.trim()) {
    // splice the new color into the existing <resources>
    const updated = existing.replace(
      /<\/resources>\s*$/,
      `    <color name="ic_launcher_background">${BG_COLOR}</color>\n</resources>\n`
    );
    await fs.promises.writeFile(colorsPath, updated);
  } else {
    await fs.promises.writeFile(colorsPath,
      `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">${BG_COLOR}</color>
</resources>
`);
  }
}

(async () => {
  console.log('Source:', SRC);
  console.log('Output:', RES);
  await generateLegacyAndForeground();
  await writeAdaptiveXml();
  await writeBackgroundColor();
  console.log('Done.');
})().catch(err => { console.error(err); process.exit(1); });
