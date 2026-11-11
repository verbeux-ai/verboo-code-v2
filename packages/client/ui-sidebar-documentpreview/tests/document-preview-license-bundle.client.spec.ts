/** Published PDF and spreadsheet chunks retain their bundled license notices. */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const packageRoot = resolve(import.meta.dirname, '..')
const bundlePath = join(packageRoot, 'lib/client.js')
const pdfChunkPath = join(packageRoot, 'lib/client.pdf.js')
const require = createRequire(import.meta.url)
const licenseNames = [
  'LICENSE',
  'cmaps/LICENSE',
  'standard_fonts/LICENSE_FOXIT',
  'standard_fonts/LICENSE_LIBERATION',
  'wasm/LICENSE_JBIG2',
  'wasm/LICENSE_OPENJPEG',
  'wasm/LICENSE_PDFJS_JBIG2',
  'wasm/LICENSE_PDFJS_OPENJPEG',
  'wasm/LICENSE_PDFJS_QCMS',
  'wasm/LICENSE_QCMS',
] as const

/** One packed manifest; npm wraps the report per package while pnpm reports it flat. */
interface PackedManifest {
  readonly filename: string
  readonly files: readonly { readonly path: string }[]
}

/**
 * Read one `pack --json` report whichever shape the active package manager used.
 * @param json - raw `pack --json` output.
 * @returns the manifest for the packed package.
 */
function unpackedManifest(json: string): PackedManifest {
  const report: unknown = JSON.parse(json)
  // An index signature accepts any key, so the flat shape is recognized by the
  // type of the value itself rather than by key presence.
  const flat = report as Partial<PackedManifest>
  if (typeof flat.filename === 'string' && flat.files !== undefined) return flat as PackedManifest
  const [only] = Object.values(report as Readonly<Record<string, PackedManifest>>)
  if (only === undefined) throw new Error('pack --json reported no package')
  return only
}

/** A cold `pnpm pack` plus every tar read must fit one subprocess budget. */
const PACK_TIMEOUT_MS = 120_000

function run(command: string, args: string[], cwd: string, timeout: number): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout })
  expect(result.error).toBeUndefined()
  expect(result.signal, result.stderr).toBeNull()
  expect(result.status, result.stderr).toBe(0)
  return result.stdout
}

function runPnpm(args: string[], cwd: string, timeout: number): string {
  const entrypoint = process.env.npm_execpath
  if (entrypoint === undefined || entrypoint === '') {
    if (process.platform === 'win32') throw new Error('npm_execpath is required to run pnpm on Windows')
    return run('pnpm', args, cwd, timeout)
  }
  return /\.[cm]?js$/iu.test(entrypoint)
    ? run(process.execPath, [entrypoint, ...args], cwd, timeout)
    : run(entrypoint, args, cwd, timeout)
}

describe('published document preview licenses', () => {
  // `pnpm pack` writes a tarball of the built package; the default per-test
  // budget does not cover a cold pack plus five tar reads.
  it.skipIf(!existsSync(bundlePath))('keeps bundled licenses in the packed lazy chunks', () => {
    expect(existsSync(pdfChunkPath)).toBe(true)
    const output = mkdtempSync(join(tmpdir(), 'dsh-document-preview-pack-'))
    try {
      const packed = unpackedManifest(runPnpm([
        'pack', '--json', '--pack-destination', output,
      ], packageRoot, PACK_TIMEOUT_MS))
      expect(packed.files.map(file => file.path)).toContain('lib/client.js')
      expect(packed.files.map(file => file.path)).toContain('lib/client.pdf.js')
      expect(packed.files.map(file => file.path)).toContain('lib/client.frontmatter-fields.js')
      expect(packed.files.some(file => file.path.endsWith('pdfjs-NOTICES.txt'))).toBe(false)

      // npm reports the tarball name relative to the destination; pnpm reports
      // it absolute.
      const archive = isAbsolute(packed.filename) ? packed.filename : resolve(output, packed.filename)
      const client = run('tar', ['-xOf', archive, 'package/lib/client.js'], packageRoot, PACK_TIMEOUT_MS)
      const pdf = run('tar', ['-xOf', archive, 'package/lib/client.pdf.js'], packageRoot, PACK_TIMEOUT_MS)
      expect([...client.matchAll(/require\.async\("(\.\/client[^"/]*\.js)"\)/gu)].map(match => match[1]))
        .toEqual(['./client.frontmatter-fields.js', './client.pdf.js', './client.excel.js'])
      expect(client).not.toMatch(/\brequire\("\.\/client[^"/]*\.js"\)/u)
      expect([...pdf.matchAll(/require\("(\.\/client[^"/]*\.js)"\)/gu)].map(match => match[1]))
        .toEqual([])
      expect(client).not.toContain('//! Bundled PDF.js license notices')
      expect(client).not.toContain('/pdfjs-dist/')
      expect(pdf).toContain('//! Bundled PDF.js license notices')
      const excel = run('tar', ['-xOf', archive, 'package/lib/client.excel.js'], packageRoot, PACK_TIMEOUT_MS)
      expect(excel).not.toMatch(/\brequire\("\.\/client[^"/]*\.js"\)/u)
      expect(client).not.toContain('FortuneSheet')
      expect(excel).toContain('//! Bundled spreadsheet license notices')
      expect(excel).toContain('Copyright (c) 2022 Suzhou Ruilisi Technology Co., Ltd')
      expect(excel).toContain('Permission is hereby granted, free of charge')
      for (const dependency of ['xlsx', 'papaparse']) {
        const root = dirname(require.resolve(dependency === 'xlsx' ? dependency : `${dependency}/package.json`))
        const license = readFileSync(join(root, 'LICENSE'), 'utf8').trimEnd()
        expect(excel).toContain(license.split('\n').map(line => `// ${line}`).join('\n'))
      }
      const frontmatter = run('tar', ['-xOf', archive, 'package/lib/client.frontmatter-fields.js'], packageRoot, PACK_TIMEOUT_MS)
      expect(frontmatter).not.toMatch(/\brequire\("\.\/client[^"/]*\.js"\)/u)
      let frontmatterInitialized = false
      runInNewContext(frontmatter, { window: { __ModuleLoader__: { load: (registration: {
        factory: (resolve: (specifier: string) => unknown) => { FrontmatterFields: unknown }
      }) => {
        const loaded = registration.factory((specifier) => {
          if (specifier === 'react' || specifier === 'react/jsx-runtime') return require(specifier)
          throw new Error(`Unexpected browser dependency: ${specifier}`)
        })
        expect(typeof loaded.FrontmatterFields).toBe('function')
        frontmatterInitialized = true
      } } } })
      expect(frontmatterInitialized).toBe(true)
      let initialized = false
      runInNewContext(excel, { window: { __ModuleLoader__: { load: (registration: {
        factory: (resolve: (specifier: string) => unknown) => { ExcelBody: unknown }
      }) => {
        const loaded = registration.factory((specifier) => {
          if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return {}
          if (specifier === 'react' || specifier === 'react/jsx-runtime' || specifier === 'react-dom') return require(specifier)
          throw new Error(`Unexpected browser dependency: ${specifier}`)
        })
        expect(typeof loaded.ExcelBody).toBe('function')
        initialized = true
      } } } })
      expect(initialized).toBe(true)
      const pdfRoot = dirname(require.resolve('pdfjs-dist/package.json'))
      for (const name of licenseNames) {
        const source = readFileSync(join(pdfRoot, name), 'utf8').trimEnd()
        const commented = [`// ${name}`, '// ', ...source.split('\n').map(line => `// ${line}`)].join('\n')
        expect(pdf, `${name} must be visible in package/lib/client.pdf.js`).toContain(commented)
      }
    } finally {
      rmSync(output, { recursive: true, force: true })
    }
  }, 180_000)
})
