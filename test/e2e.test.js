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
