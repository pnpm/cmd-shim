import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, test, snapshot } from 'node:test'
import assert from 'node:assert/strict'

snapshot.setDefaultSnapshotSerializers([
  (value) => typeof value === 'string' ? `\n${value.replaceAll('\r', '')}` : JSON.stringify(value),
])
import tempy from 'tempy'
import { cmdShim } from '../index.js'

const describeOnWindows = process.platform === 'win32' ? describe : describe.skip
const describeOnPosix = process.platform === 'win32' ? describe.skip : describe

describeOnWindows('create a command shim for a .exe file', () => {
  test('shim files', async (t) => {
    const tempDir = tempy.directory()
    fs.writeFileSync(path.join(tempDir, 'foo.exe'), '', 'utf8')
    await cmdShim(path.join(tempDir, 'foo'), path.join(tempDir, 'dest'))
    const stripMarker = (s) => s.replace(/# cmd-shim-target=.*\n/, '')
    t.assert.snapshot(stripMarker(fs.readFileSync(path.join(tempDir, 'dest'), 'utf-8')))
    t.assert.snapshot(fs.readFileSync(path.join(tempDir, 'dest.cmd'), 'utf-8'))
    t.assert.snapshot(fs.readFileSync(path.join(tempDir, 'dest.ps1'), 'utf-8'))
  })
})

describeOnWindows('sh shim wrapping a .cmd target invoked from Git Bash', () => {
  // Regression for the MSYS path-translation bug: Git Bash rewrites a bare
  // `/C` argument to `C:\` before launching cmd.exe, dropping the switch
  // and leaving cmd.exe interactive. The fix escapes it as `//C` so MSYS
  // passes it through.
  test('runs the wrapped batch script and captures its output', async () => {
    const tempDir = tempy.directory()
    const target = path.join(tempDir, 'src.cmd')
    fs.writeFileSync(target, '@echo HELLO_FROM_CMD\r\n', 'utf8')
    const shim = path.join(tempDir, 'shim')
    await cmdShim(target, shim)

    // Invoke the sh shim via Git Bash. If `/C` survives MSYS translation,
    // cmd.exe runs src.cmd and prints HELLO_FROM_CMD; if it gets rewritten
    // to a drive path, cmd.exe starts interactively and dumps its banner
    // (`Microsoft Windows [Version ...]`) instead.
    const bash = process.env.PROGRAMFILES
      ? path.join(process.env.PROGRAMFILES, 'Git', 'bin', 'bash.exe')
      : 'bash'
    const r = spawnSync(bash, ['--noprofile', '--norc', shim], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    assert.equal(r.status, 0, `bash exited ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`)
    assert.match(r.stdout, /HELLO_FROM_CMD/, `expected script output, got:\n${r.stdout}`)
    assert.doesNotMatch(
      r.stdout,
      /Microsoft Windows \[Version/,
      'cmd.exe started interactively — the /C switch was dropped'
    )
  })
})

describeOnPosix('sh shim binstub uses exec', () => {
  // Regression for the binstub bug: without `exec`, the shell process
  // wraps the wrapped binary, so signals sent to the shim do not reach
  // the wrapped process and the binary's PID differs from the shim's
  // spawn PID. With `exec`, the shell process is replaced in place and
  // the wrapped binary inherits the shim's PID.
  test('wrapped binary inherits the shim\'s PID (proves exec replaced the shell)', async () => {
    const tempDir = tempy.directory()
    // process.execPath is a no-shebang native binary, so cmdShim hits the
    // non-shLongProg branch of generateShShim — the one that needs `exec`.
    const shim = path.join(tempDir, 'shim')
    await cmdShim(process.execPath, shim)

    const proc = spawn('/bin/sh', [shim, '-p', 'process.pid'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const shimPid = proc.pid
    let stdout = ''
    proc.stdout.on('data', (chunk) => { stdout += chunk })
    const exitCode = await new Promise((resolve) => proc.on('exit', resolve))

    assert.equal(exitCode, 0, `shim exited ${exitCode}; stdout=${stdout}`)
    const reportedPid = Number(stdout.trim())
    assert.equal(
      reportedPid,
      shimPid,
      `expected child to inherit shim PID via exec — got reported=${reportedPid}, shim=${shimPid}`
    )
  })
})
