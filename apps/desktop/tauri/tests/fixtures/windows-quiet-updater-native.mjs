import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { promisify } from 'node:util'

assert.equal(process.platform, 'win32')
const execute = promisify(execFile)
const oldVersion = '0.2.2-alpha.42'
const newVersion = '0.2.2-alpha.43'
const title = 'Verboo Code'
const executable = 'verboo-code-desktop.exe'
const uninstallKey = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Verboo Code'
const webviewKey = 'HKCU:\\Software\\Policies\\Microsoft\\Edge\\WebView2\\AdditionalBrowserArguments'
const appDir = join(process.env.LOCALAPPDATA, title)
const dataDir = join(process.env.APPDATA, 'ai.verbeux.verboo-code')
const appFile = join(appDir, executable)
const devtoolsPort = 19222
const testDir = await mkdtemp(join(tmpdir(), 'verboo-quiet-update-'))
const hostHome = join(dataDir, 'home')
const fixture = join(hostHome, 'update-test-profile.txt')

const powershell = command => execute('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { timeout: 30_000 })
const appProcesses = "Get-Process | Where-Object ProcessName -EQ 'verboo-code-desktop'"
const psString = value => "'" + value.replaceAll("'", "''") + "'"
const root = 'https://github.com/verbeux-ai/verboo-code-v2/releases/download/'
const fileName = version => 'Verboo-Code-v2-' + version + '-Windows-x64-Setup.exe'

function watch(command, args, options = {}) {
  const child = spawn(command, args, options)
  const finished = new Promise((done, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => done({ code, signal }))
  })
  finished.catch(() => {})
  return { child, finished }
}

async function until(label, condition, timeout = 150_000) {
  const end = Date.now() + timeout
  let observed
  while (Date.now() < end) {
    try {
      const result = await condition()
      if (result) return result
    } catch (error) {
      observed = error instanceof Error ? error.message : String(error)
    }
    await pause(400)
  }
  throw new Error(label + ' timed out' + (observed ? ': ' + observed : ''))
}

async function downloaded(version) {
  const name = fileName(version)
  const packageFile = join(testDir, name)
  const manifestFile = join(testDir, 'manifest-' + version + '.json')
  const download = (asset, destination) => execute('curl.exe', [
    '--silent', '--show-error', '--fail', '--location', '--retry', '3', '--output', destination,
    root + 'v' + version + '/' + asset,
  ], { timeout: 180_000 })
  await Promise.all([download(name, packageFile), download('manifest-Windows-x64.json', manifestFile)])
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
  const artifact = manifest.installers.find(installer => installer.name === name)
  assert.ok(artifact, 'official Windows artifact in the release manifest')
  assert.equal(await digest(packageFile), artifact.sha256, 'official installer checksum')
  return { packageFile, bytes: artifact.bytes, signature: manifest.updaters.find(updater => updater.target === 'windows-x86_64-nsis').signature }
}

async function digest(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function runInstaller(file, args) {
  const { finished } = watch(file, args, { stdio: 'ignore' })
  assert.deepEqual(await finished, { code: 0, signal: null }, 'NSIS exit status')
}

async function installedVersion() {
  const { stdout } = await powershell('(Get-ItemProperty -LiteralPath ' + psString(uninstallKey) + ' -ErrorAction Stop).DisplayVersion')
  return stdout.trim()
}

async function renderer(expression) {
  const response = await fetch('http://127.0.0.1:' + devtoolsPort + '/json/list', { signal: AbortSignal.timeout(3000) })
    .catch(error => { throw new Error('WebView2 debug endpoint: ' + (error.cause?.code ?? error.message)) })
  const targets = await response.json()
  const target = targets.find(page => page.type === 'page' && page.url.startsWith('http://127.0.0.1:'))
  if (!target) return undefined
  return await new Promise((done, reject) => {
    const socket = new WebSocket(target.webSocketDebuggerUrl)
    const timeout = setTimeout(() => { socket.close(); reject(new Error('WebView IPC timed out')) }, 3500)
    socket.addEventListener('open', () => socket.send(JSON.stringify({
      id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true },
    })))
    socket.addEventListener('error', () => {
      clearTimeout(timeout)
      reject(new Error('WebView IPC closed'))
    })
    socket.addEventListener('message', event => {
      const reply = JSON.parse(event.data)
      if (reply.id !== 1) return
      clearTimeout(timeout)
      socket.close()
      if (reply.result?.exceptionDetails) {
        const detail = reply.result.exceptionDetails
        reject(new Error(detail.exception?.value ?? detail.exception?.description ?? detail.text))
      }
      else done(reply.result?.result?.value)
    })
  })
}

const ready = String.raw`!!window.__VERBOO_DESKTOP__ &&
  !document.querySelector('[data-dsh-boot]') &&
  Array.from(document.querySelectorAll('button')).some(button => !button.disabled &&
    /sign in with verboo|continue with verboo/i.test(button.textContent))`

async function waitForInterface() {
  await until('Verboo sign-in interface in native WebView2', () => renderer(ready))
}

async function appPids() {
  const { stdout } = await powershell(appProcesses + ' | Select-Object -ExpandProperty Id')
  return stdout.trim().split(/\s+/).filter(Boolean).map(Number)
}

async function closeApp() {
  await powershell(appProcesses + ' | ForEach-Object { [void]$_.CloseMainWindow() }')
  await until('graceful desktop exit', async () => (await appPids()).length === 0)
}

async function observeWindows(windowLog, readyFile) {
  const watcher = watch('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', [
    "Set-Content -LiteralPath " + psString(readyFile) + " -Value started",
    'while ($true) {',
    "  Get-Process | Where-Object { $_.MainWindowTitle -like '*Verboo Code Setup*' } | ForEach-Object { Add-Content -LiteralPath " + psString(windowLog) + " -Value $_.MainWindowTitle }",
    '  Start-Sleep -Milliseconds 70',
    '}',
  ].join('\n')], { windowsHide: true, stdio: 'ignore' })
  await until('Windows setup-window observer', async () => (await readFile(readyFile, 'utf8')).trim() === 'started')
  return async () => { watcher.child.kill(); await watcher.finished }
}

async function checkStandardUserInstaller(previous, target) {
  await writeFile(join(testDir, 'standard-user.json'), JSON.stringify({
    previous: previous.packageFile, target: target.packageFile, previousVersion: oldVersion, targetVersion: newVersion,
  }))
  const worker = join(testDir, 'standard-user.ps1')
  await writeFile(worker, String.raw`
$ErrorActionPreference = 'Stop'
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Expected a non-administrator account' }
$setup = Get-Content (Join-Path $PSScriptRoot 'standard-user.json') -Raw | ConvertFrom-Json
$profileRoot = [Environment]::GetFolderPath('LocalApplicationData')
$marker = Join-Path $profileRoot 'Verboo Code update test.txt'
$registry = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Verboo Code'
Set-Content -LiteralPath $marker -Value 'test profile preserved'
$baseline = Start-Process -FilePath $setup.previous -ArgumentList '/S' -Wait -PassThru
if ($baseline.ExitCode -ne 0 -or (Get-ItemProperty -LiteralPath $registry).DisplayVersion -ne $setup.previousVersion) {
  throw 'Standard-user baseline installation failed'
}
$upgrade = Start-Process -FilePath $setup.target -ArgumentList '/S','/UPDATE','/R' -PassThru
if (-not $upgrade.WaitForExit(150000)) { throw 'The standard-user installer did not finish' }
if ($upgrade.ExitCode -ne 0 -or (Get-ItemProperty -LiteralPath $registry).DisplayVersion -ne $setup.targetVersion) {
  throw 'Silent installer failed under a standard Windows account'
}
if ((Get-Content -LiteralPath $marker -Raw).Trim() -ne 'test profile preserved') { throw 'Test profile file was lost' }
Write-Output 'PASS: the official silent installer upgraded the standard Windows account without administrator rights.'
`)
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$name = 'VerbooTest' + [guid]::NewGuid().ToString('N').Substring(0, 8)",
    "$password = ConvertTo-SecureString ([guid]::NewGuid().ToString('N') + '!A9') -AsPlainText -Force",
    "New-LocalUser -Name $name -Password $password | Out-Null",
    'try {',
    "  $sid = (Get-LocalUser -Name $name).SID.Value",
    "  if (-not (Get-LocalGroupMember -SID 'S-1-5-32-545' | Where-Object { $_.SID.Value -eq $sid })) { Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $name }",
    "  & icacls " + psString(testDir) + " /grant ('*' + $sid + ':(OI)(CI)M') | Out-Null",
    "  if ($LASTEXITCODE -ne 0) { throw 'Unable to grant the test user access to its fixture' }",
    "  $credential = [pscredential]::new(($env:COMPUTERNAME + '\\' + $name), $password)",
    "  $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"' + " + psString(worker) + " + '\"'",
    "  $worker = Start-Process -FilePath (Get-Command pwsh.exe).Source -Credential $credential -LoadUserProfile -ArgumentList $arguments -WorkingDirectory " + psString(testDir) +
      " -RedirectStandardOutput " + psString(join(testDir, 'standard.stdout')) + " -RedirectStandardError " + psString(join(testDir, 'standard.stderr')) + " -PassThru",
    "  if (-not $worker.WaitForExit(240000)) { Stop-Process -Id $worker.Id -Force; throw 'Standard-user fixture timed out' }",
    "  Get-Content -LiteralPath " + psString(join(testDir, 'standard.stdout')),
    "  if ($worker.ExitCode -ne 0) { Get-Content -LiteralPath " + psString(join(testDir, 'standard.stderr')) + "; throw 'Standard-user installer smoke failed' }",
    '} finally { Remove-LocalUser -Name $name }',
  ].join('\n')
  const { stdout } = await execute('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 275_000 })
  console.log(stdout.trim())
}

let server
let release
let packageRequests = 0
let stopObserver
const debugArguments = '--remote-debugging-port=' + devtoolsPort
try {
  const identity = await powershell('$p = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()); $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)')
  console.log('Runner user token has administrator rights:', identity.stdout.trim())
  const [previous, target] = await Promise.all([downloaded(oldVersion), downloaded(newVersion)])
  release = target
  server = createServer((req, res) => {
    if (req.url === '/feed') {
      console.log('Test feed requested.')
      const url = 'http://127.0.0.1:' + server.address().port + '/setup.exe'
      const asset = { url, signature: release.signature }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ version: newVersion, platforms: {'windows-x86_64': asset, 'windows-x86_64-nsis': asset} }))
    } else if (req.url === '/setup.exe') {
      packageRequests += 1
      console.log('Signed Windows package requested.')
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': release.bytes })
      createReadStream(release.packageFile).on('error', () => res.destroy()).pipe(res)
    } else res.writeHead(404).end()
  })
  await new Promise((done, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', done)
  })
  const override = {
    version: oldVersion,
    plugins: { updater: { endpoints: ['http://127.0.0.1:' + server.address().port + '/feed'], dangerousInsecureTransportProtocol: true } },
  }
  await mkdir('apps/desktop/.desktop-build/tauri/runtime', { recursive: true })
  console.log('Compiling the exact desktop updater with an isolated test feed.')
  const cargo = watch('cargo.exe', ['build', '--release', '--locked', '--features', 'custom-protocol',
    '--manifest-path', 'apps/desktop/src-tauri/Cargo.toml', '--target', 'x86_64-pc-windows-msvc'], {
    env: { ...process.env, TAURI_CONFIG: JSON.stringify(override), CARGO_BUILD_JOBS: '2' }, stdio: 'inherit',
  })
  assert.deepEqual(await cargo.finished, { code: 0, signal: null })
  const testApp = resolve('apps/desktop/.desktop-build/tauri/target/x86_64-pc-windows-msvc/release', executable)

  process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = debugArguments
  await powershell("$ErrorActionPreference = 'Stop'; New-Item -Path " + psString(webviewKey) + " -Force | Out-Null; New-ItemProperty -Path " +
    psString(webviewKey) + " -Name '*' -Value " + psString(debugArguments) + " -PropertyType String -Force | Out-Null")

  const manualLog = join(testDir, 'manual.log')
  stopObserver = await observeWindows(manualLog, join(testDir, 'manual.ready'))
  const manual = watch(previous.packageFile, [], { stdio: 'ignore' })
  try {
    await until('manual setup window as a control', async () => (await stat(manualLog)).size > 0, 30_000)
    console.log('PASS: manually opening the official installer shows Verboo Code Setup.')
  } finally {
    manual.child.kill()
    await manual.finished
    await stopObserver()
    stopObserver = undefined
  }

  let standardUserError
  try {
    await checkStandardUserInstaller(previous, target)
  } catch (error) {
    standardUserError = error
    console.error('Standard-user check:', error.stdout?.trim(), error.stderr?.trim())
  } finally {
    await powershell(appProcesses + ' | Stop-Process -Force')
  }

  for (const scenario of ['restart-now', 'next-open-offline']) {
    if (scenario !== 'restart-now') await runInstaller(join(appDir, 'uninstall.exe'), ['/S'])
    await runInstaller(previous.packageFile, ['/S'])
    assert.equal(await installedVersion(), oldVersion)
    await copyFile(testApp, appFile)
    const previousHash = await digest(appFile)
    await mkdir(hostHome, { recursive: true })
    await writeFile(fixture, 'data-sentinel:' + scenario)
    const desktop = watch(appFile, [], { cwd: appDir, stdio: 'inherit' })
    desktop.finished.then(result => console.log(scenario + ' source process exited:', result)).catch(() => {})
    await waitForInterface()
    await until('signed package ready in the actual desktop updater', async () =>
      (await renderer('window.__VERBOO_UPDATE__?.getState()'))?.phase === 'ready', 180_000)
    console.log(scenario + ': signed update downloaded and staged.')
    const requestCount = packageRequests
    const windows = join(testDir, scenario + '.log')
    stopObserver = await observeWindows(windows, join(testDir, scenario + '.ready'))
    if (scenario === 'restart-now') {
      await renderer('window.__VERBOO_UPDATE__.install(false)').catch(error => {
        if (!/WebView IPC (closed|timed out)/.test(error.message)) throw error
      })
    } else {
      await closeApp()
      await desktop.finished
      server.closeAllConnections()
      await new Promise(done => server.close(done))
      server = undefined
      watch(appFile, [], { cwd: appDir, stdio: 'inherit' })
    }
    await until('installer registered the new version', async () => (await installedVersion()) === newVersion)
    await until('a new Verboo process from the installer', async () =>
      (await appPids()).some(pid => pid !== desktop.child.pid))
    await desktop.finished
    await waitForInterface()
    await stopObserver()
    stopObserver = undefined
    const visibleInstaller = await readFile(windows, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return ''
      throw error
    })
    assert.equal(visibleInstaller, '', 'silent upgrade must display no Setup window')
    assert.notEqual(await digest(appFile), previousHash, 'real executable replaced')
    assert.equal(await readFile(fixture, 'utf8'), 'data-sentinel:' + scenario, 'per-user data preserved')
    assert.equal(packageRequests, requestCount, 'install uses staged package without another download')
    console.log('PASS: ' + scenario + ' installed the signed version without Setup, retained the user file, and restored the Verboo interface.')
    await closeApp()
  }
  if (standardUserError) throw standardUserError
} catch (error) {
  await powershell("Get-Process | Where-Object { $_.ProcessName -in 'verboo-code-desktop','msedgewebview2' } | " +
    "Select-Object -Property Id,ProcessName,MainWindowTitle | Out-String -Width 200")
    .then(({ stdout }) => console.log('Native process state:', stdout.trim()))
    .catch(diagnostic => console.error('Cannot read native process state:', diagnostic.message))
  throw error
} finally {
  await stopObserver?.()
  if (server) {
    server.closeAllConnections()
    await new Promise(done => server.close(done))
  }
  await powershell(appProcesses + ' | Stop-Process -Force; Remove-ItemProperty -LiteralPath ' +
    psString(webviewKey) + " -Name '*' -ErrorAction SilentlyContinue").catch(error => console.error('Windows cleanup:', error.message))
  await rm(testDir, { recursive: true, force: true, maxRetries: 3 })
}
