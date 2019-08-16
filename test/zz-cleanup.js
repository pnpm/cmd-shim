'use strict'
const tape = require('tape')
const promisifyTape = require('tape-promise').default
const test = promisifyTape(tape)

const cmdShim = require('../')

test('cleanup', function (t) {
  cmdShim.__TEST__.setFs(require('fs'))
  t.end()
})
