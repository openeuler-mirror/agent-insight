const sharp = require('sharp')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const svgPath = path.join(ROOT, 'icon.svg')
const pngPath = path.join(ROOT, 'icon.png')

async function convert() {
  try {
    if (!fs.existsSync(svgPath)) {
      console.error('❌ icon.svg not found')
      process.exit(1)
    }
    await sharp(svgPath)
      .resize(256, 256)
      .png()
      .toFile(pngPath)
    console.log(`✅ Converted ${svgPath} to ${pngPath}`)
  } catch (err) {
    console.error('❌ Conversion failed:', err.message)
    process.exit(1)
  }
}

convert()