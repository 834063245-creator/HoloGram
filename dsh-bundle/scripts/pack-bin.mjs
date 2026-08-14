// pack-bin.mjs — copy the built HoloGram engine + runtime deps into this
// bundle's bin/ so they ship with the published package.
//
// Sources:
//   engine/target/release/hologram-engine.exe   (the compiled engine, self-contained)
//   engine/onnxruntime.dll                      (optional, for MiniLM semantic features)
//
// You must build the engine first: cd engine && cargo build --release
import { mkdirSync, copyFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BUNDLE_ROOT = fileURLToPath(new URL('..', import.meta.url))
const REPO_ROOT = join(BUNDLE_ROOT, '..')
const BIN_DIR = join(BUNDLE_ROOT, 'bin')

const artifacts = [
  {
    label: 'engine binary',
    src: join(REPO_ROOT, 'engine', 'target', 'release', 'hologram-engine.exe'),
    dst: join(BIN_DIR, 'hologram-engine.exe'),
    required: true,
  },
  {
    label: 'onnxruntime.dll (optional, vector/semantic)',
    src: join(REPO_ROOT, 'engine', 'onnxruntime.dll'),
    dst: join(BIN_DIR, 'onnxruntime.dll'),
    required: false,
  },
]

mkdirSync(BIN_DIR, { recursive: true })
let missing = []
for (const a of artifacts) {
  if (!existsSync(a.src)) {
    if (a.required) missing.push(a.label)
    console.log(`pack-bin: skip ${a.label} (source not found: ${a.src})`)
    continue
  }
  copyFileSync(a.src, a.dst)
  console.log(`pack-bin: copied ${a.dst}`)
}
if (missing.length > 0) {
  console.error(`pack-bin: MISSING REQUIRED artifacts: ${missing.join(', ')}. Build the engine first (cd engine && cargo build --release).`)
  process.exit(1)
}
console.log('pack-bin: done. Bundle bin/ is ready to ship.')
