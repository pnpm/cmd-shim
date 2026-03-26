import fs from 'node:fs'
import path from 'node:path'
import tempy from 'tempy'
import { cmdShim } from '../index.js'

const testOnWindows = process.platform === 'win32' ? test : test.skip

testOnWindows('create a command shim for a .exe file', async () => {
  const tempDir = tempy.directory()
  fs.writeFileSync(path.join(tempDir, 'foo.exe'), '', 'utf8')
  await cmdShim(path.join(tempDir, 'foo'), path.join(tempDir, 'dest'))
  const stripMarker = (s) => s.replace(/# cmd-shim-target=.*\n/, '')
  expect(stripMarker(fs.readFileSync(path.join(tempDir, 'dest'), 'utf-8'))).toMatchSnapshot()
  expect(fs.readFileSync(path.join(tempDir, 'dest.cmd'), 'utf-8')).toMatchSnapshot()
  expect(fs.readFileSync(path.join(tempDir, 'dest.ps1'), 'utf-8')).toMatchSnapshot()
})
