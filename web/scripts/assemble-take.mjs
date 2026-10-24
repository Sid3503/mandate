// Assembles a screencast take into an exact 60fps H.264 file.
// Expands the real timeline into one hardlink per output frame, so holds are
// held and nothing drifts (the concat demuxer rounds image durations).
import { execFileSync } from 'node:child_process'
import { copyFileSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'

const dir = path.resolve(process.argv[2] ?? 'pitch/video/take')
const out = path.resolve(process.argv[3] ?? 'pitch/video/take.mp4')
const seq = path.join(dir, 'seq')

const files = readdirSync(dir).filter((f) => /^f\d+\.jpg$/.test(f)).sort()
const ts = JSON.parse(readFileSync(path.join(dir, 'frames.json'), 'utf8'))
if (files.length !== ts.length) throw new Error(`frames ${files.length} != timestamps ${ts.length}`)

rmSync(seq, { recursive: true, force: true })
mkdirSync(seq, { recursive: true })

const t0 = ts[0]
const span = ts[ts.length - 1] - t0
const total = Math.round(span * 60) + 1
let src = 0
for (let k = 0; k < total; k += 1) {
  const t = t0 + k / 60
  while (src + 1 < ts.length && ts[src + 1] <= t) src += 1
  const target = path.join(seq, `f${String(k + 1).padStart(5, '0')}.jpg`)
  try {
    linkSync(path.join(dir, files[src]), target)
  } catch {
    copyFileSync(path.join(dir, files[src]), target)
  }
}

execFileSync(
  'ffmpeg',
  [
    '-v', 'error', '-y',
    '-framerate', '60', '-i', path.join(seq, 'f%05d.jpg'),
    '-vf', 'format=yuv420p',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
    '-movflags', '+faststart',
    out,
  ],
  { stdio: 'inherit' },
)

rmSync(seq, { recursive: true, force: true })
const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', out]).toString().trim()
console.log(JSON.stringify({ out, source: files.length, output: total, seconds: Number(probe) }))
