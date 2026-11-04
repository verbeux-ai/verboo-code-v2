/** Publish visibility only after GitHub confirms every uploaded file's digest. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'

const [directory, metadata] = process.argv.slice(2).map(path => resolve(path))
const release = JSON.parse(await readFile(metadata, 'utf8'))
if (release.draft !== true || release.target_commitish !== process.env.GITHUB_SHA || !/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA ?? '')) {
  throw new Error('draft release source identity mismatch')
}
const files = await readdir(directory)
if (!Array.isArray(release.assets) || release.assets.length !== files.length) throw new Error('incomplete uploaded artifact set')
for (const name of files) {
  const assets = release.assets.filter(asset => asset.name === name)
  const path = join(directory, name)
  const stat = await lstat(path)
  if (assets.length !== 1 || assets[0].state !== 'uploaded' || assets[0].size !== stat.size || !stat.isFile()) throw new Error('uploaded artifact size or identity mismatch')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  if (assets[0].digest !== `sha256:${hash.digest('hex')}`) throw new Error('uploaded artifact digest mismatch')
}
console.log(JSON.stringify({ verified: true, source: process.env.GITHUB_SHA, uploaded: files.length }))
