'use strict'
// On windows, create a .cmd file.
// Read the #! in the file to see what it uses.  The vast majority
// of the time, this will be either:
// "#!/usr/bin/env <prog> <args...>"
// or:
// "#!<prog> <args...>"
//
// Write a binroot/pkg.bin + ".cmd" file that has this line in it:
// @<prog> <args...> %~dp0<target> %*

module.exports = cmdShim
cmdShim.ifExists = cmdShimIfExists

/**
 * @typedef {import('./index').Options} Options
 */

const fs = require('mz/fs')

const mkdir = require('mkdirp-promise')
const path = require('path')
const isWindows = require('is-windows')
const shebangExpr = /^#!\s*(?:\/usr\/bin\/env)?\s*([^ \t]+)(.*)$/
const DEFAULT_OPTIONS = {
  // Create PowerShell file by default if the option hasn't been specified
  createPwshFile: true,
  createCmdFile: isWindows()
}
const extensionToProgramMap = new Map([
  ['.js', 'node'],
  ['.cmd', 'cmd'],
  ['.bat', 'cmd'],
  ['.ps1', 'pwsh'], // not 'powershell'
  ['.sh', 'sh']
])

/**
 * Try to create shims.
 *
 * @param {string} src Path to program (executable or script).
 * @param {string} to Path to shims.
 * Don't add an extension if you will create multiple types of shims.
 * @param {Options} opts Options.
 * @return {Promise<void>}
 * @throws If `src` is missing.
 */
function cmdShim (src, to, opts) {
  opts = Object.assign({}, DEFAULT_OPTIONS, opts)
  return fs
    .stat(src)
    .then(() => cmdShim_(src, to, opts))
}

/**
 * Try to create shims.
 *
 * Does nothing if `src` doesn't exist.
 *
 * @param {string} src Path to program (executable or script).
 * @param {string} to Path to shims.
 * Don't add an extension if you will create multiple types of shims.
 * @param {Options} opts Options.
 * @return {Promise<void>}
 */
function cmdShimIfExists (src, to, opts) {
  return cmdShim(src, to, opts).catch(() => {})
}

/**
 * Try to unlink, but ignore errors.
 * Any problems will surface later.
 *
 * @param {string} path File to be removed.
 * @return {Promise<void>}
 */
function rm (path) {
  return fs.unlink(path).catch(() => {})
}

function cmdShim_ (src, to, opts) {
  opts = Object.assign({}, DEFAULT_OPTIONS, opts)
  return searchScriptRuntime(src).then((srcRuntimeInfo) => {
    // Always tries to create all types of shims by calling `writeAllShims` as of now.
    // Append your code here to change the behavior in response to `srcRuntimeInfo`.

    // Create 3 shims for (Ba)sh in Cygwin / MSYS, no extension) & CMD (.cmd) & PowerShell (.ps1)
    return writeAllShims(src, to, srcRuntimeInfo, opts)
  })
}

function writeAllShims (src, to, srcRuntimeInfo, opts) {
  opts = Object.assign({}, DEFAULT_OPTIONS, opts)
  return Promise.all([
    [generateShShim, '', true],
    [generateCmdShim, '.cmd', opts.createCmdFile],
    [generatePwshShim, '.ps1', opts.createPwshFile]
  ].map(([generateShimScript, extension, shouldCreate]) => shouldCreate && writeShim(src, to + extension, srcRuntimeInfo, generateShimScript, opts)))
}

function writeShimPre (target) {
  return rm(target).then(() => mkdir(path.dirname(target)))
}

function writeShimPost (target) {
  // Only chmoding shims as of now.
  // Some other processes may be appended.
  return chmodShim(target)
}

/**
 * Look into runtime (e.g. `node` & `sh` & `pwsh`) and its arguments
 * of the target program (script or executable).
 *
 * @param {string} target Path to the executable or script.
 * @typedef {{program?: string, additionalArgs: string}} RuntimeInfo If `.program` is `null`,
 * the program may be a binary executable or something and can be called from shells by just its path.
 * (e.g. `.\foo.exe` in CMD or PowerShell)
 * @return {Promise<RuntimeInfo>} Promise of infomation of runtime of `target`.
 */
function searchScriptRuntime (target) {
  return fs
    .readFile(target, 'utf8')
    .then(data => {
      // First, check if the bin is a #! of some sort.
      const firstLine = data.trim().split(/\r*\n/)[0]
      const shebang = firstLine.match(shebangExpr)
      if (!shebang) {
        // If not, infer script type from its extension.
        // If the inferrence fails, it's something that'll be compiled, or some other
        // sort of script, and just call it directly.
        const targetExtension = path.extname(target).toLowerCase()
        return Promise.resolve({
          // undefined if extension is unknown but it's converted to null.
          program: extensionToProgramMap.get(targetExtension) || null,
          additionalArgs: ''
        })
      }
      return Promise.resolve({
        program: shebang[1],
        additionalArgs: shebang[2]
      })
    })
}

function writeShim (src, to, srcRuntimeInfo, generateShimScript, opts) {
  const defaultArgs = opts.preserveSymlinks ? '--preserve-symlinks' : ''
  // `Array.prototype.flter` removes ''.
  // ['--foo', '--bar'].join(' ') and [].join(' ') returns '--foo --bar' and '' respectively.
  const args = [srcRuntimeInfo.additionalArgs, defaultArgs].filter(arg => arg).join(' ')
  opts = Object.assign({}, opts, {
    prog: srcRuntimeInfo.program,
    args: args
  })

  return writeShimPre(to)
    .then(() => fs.writeFile(to, generateShimScript(src, to, opts), 'utf8'))
    .then(() => writeShimPost(to))
}

function generateCmdShim (src, to, opts) {
  let shTarget = path.relative(path.dirname(to), src)
  let target = shTarget.split('/').join('\\')
  let longProg
  let prog = opts.prog
  shTarget = shTarget.split('\\').join('/')
  let args = opts.args || ''
  let {
    win32: nodePath
  } = normalizePathEnvVar(opts.nodePath)
  if (!prog) {
    prog = `"%~dp0\\${target}"`
    args = ''
    target = ''
    shTarget = ''
  } else {
    longProg = `"%~dp0\\${prog}.exe"`
    target = `"%~dp0\\${target}"`
    shTarget = `"$basedir/${shTarget}"`
  }

  // @IF EXIST "%~dp0\node.exe" (
  //   "%~dp0\node.exe" "%~dp0\.\node_modules\npm\bin\npm-cli.js" %*
  // ) ELSE (
  //   SETLOCAL
  //   SET PATHEXT=%PATHEXT:;.JS;=;%
  //   node "%~dp0\.\node_modules\npm\bin\npm-cli.js" %*
  // )
  let cmd = nodePath ? `@SET NODE_PATH=${nodePath}\r\n` : ''
  if (longProg) {
    cmd += '@IF EXIST ' + longProg + ' (\r\n' +
      '  ' + longProg + ' ' + args + ' ' + target + ' %*\r\n' +
      ') ELSE (\r\n' +
      '  @SETLOCAL\r\n' +
      '  @SET PATHEXT=%PATHEXT:;.JS;=;%\r\n' +
      '  ' + prog + ' ' + args + ' ' + target + ' %*\r\n' +
      ')'
  } else {
    cmd += `@${prog} ${args} ${target} %*\r\n`
  }

  return cmd
}

function generateShShim (src, to, opts) {
  let shTarget = path.relative(path.dirname(to), src)
  let target = shTarget.split('/').join('\\')
  let prog = opts.prog
  let shProg = prog && prog.split('\\').join('/')
  let shLongProg
  shTarget = shTarget.split('\\').join('/')
  let args = opts.args || ''
  let {
    posix: shNodePath
  } = normalizePathEnvVar(opts.nodePath)
  if (!prog) {
    prog = `"%~dp0\\${target}"`
    shProg = `"$basedir/${shTarget}"`
    args = ''
    target = ''
    shTarget = ''
  } else {
    shLongProg = '"$basedir/' + prog + '"'
    target = `"%~dp0\\${target}"`
    shTarget = `"$basedir/${shTarget}"`
  }

  // #!/bin/sh
  // basedir=`dirname "$0"`
  //
  // case `uname` in
  //     *CYGWIN*) basedir=`cygpath -w "$basedir"`;;
  // esac
  //
  // if [ -x "$basedir/node.exe" ]; then
  //   "$basedir/node.exe" "$basedir/node_modules/npm/bin/npm-cli.js" "$@"
  //   ret=$?
  // else
  //   node "$basedir/node_modules/npm/bin/npm-cli.js" "$@"
  //   ret=$?
  // fi
  // exit $ret

  let sh = '#!/bin/sh\n'
  sh = sh +
    "basedir=$(dirname \"$(echo \"$0\" | sed -e 's,\\\\,/,g')\")\n" +
    '\n' +
    'case `uname` in\n' +
    '    *CYGWIN*) basedir=`cygpath -w "$basedir"`;;\n' +
    'esac\n' +
    '\n'
  const env = opts.nodePath ? `NODE_PATH="${shNodePath}" ` : ''

  if (shLongProg) {
    sh = sh +
      'if [ -x ' + shLongProg + ' ]; then\n' +
      '  ' + env + shLongProg + ' ' + args + ' ' + shTarget + ' "$@"\n' +
      '  ret=$?\n' +
      'else \n' +
      '  ' + env + shProg + ' ' + args + ' ' + shTarget + ' "$@"\n' +
      '  ret=$?\n' +
      'fi\n' +
      'exit $ret\n'
  } else {
    sh = sh + env + shProg + ' ' + args + ' ' + shTarget + ' "$@"\n' +
      'exit $?\n'
  }

  return sh
}

function generatePwshShim (src, to, opts) {
  let shTarget = path.relative(path.dirname(to), src)
  let target = shTarget.split('/').join('\\')
  let prog = opts.prog
  let shProg = prog && prog.split('\\').join('/')
  let shLongProg
  let pwshProg = shProg && `"${shProg}$exe"`
  let pwshLongProg
  shTarget = shTarget.split('\\').join('/')
  let args = opts.args || ''
  let {
    win32: nodePath,
    posix: shNodePath
  } = normalizePathEnvVar(opts.nodePath)
  if (!prog) {
    prog = `"%~dp0\\${target}"`
    shProg = `"$basedir/${shTarget}"`
    pwshProg = shProg
    args = ''
    target = ''
    shTarget = ''
  } else {
    shLongProg = '"$basedir/' + prog + '"'
    pwshLongProg = `"$basedir/${prog}$exe"`
    target = `"%~dp0\\${target}"`
    shTarget = `"$basedir/${shTarget}"`
  }

  // #!/usr/bin/env pwsh
  // $basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent
  //
  // $ret=0
  // $exe = ""
  // if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {
  //   # Fix case when both the Windows and Linux builds of Node
  //   # are installed in the same directory
  //   $exe = ".exe"
  // }
  // if (Test-Path "$basedir/node") {
  //   & "$basedir/node$exe" "$basedir/node_modules/npm/bin/npm-cli.js" $args
  //   $ret=$LASTEXITCODE
  // } else {
  //   & "node$exe" "$basedir/node_modules/npm/bin/npm-cli.js" $args
  //   $ret=$LASTEXITCODE
  // }
  // exit $ret
  let pwsh = '#!/usr/bin/env pwsh\n' +
    '$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent\n' +
    '\n' +
    '$exe=""\n' +
    (opts.nodePath ? '$env_node_path=$env:NODE_PATH\n' +
      `$env:NODE_PATH="${nodePath}"\n` : '') +
    'if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {\n' +
    '  # Fix case when both the Windows and Linux builds of Node\n' +
    '  # are installed in the same directory\n' +
    '  $exe=".exe"\n' +
    '}'
  if (opts.nodePath) {
    pwsh = pwsh +
      ' else {\n' +
      `  $env:NODE_PATH="${shNodePath}"\n` +
      '}'
  }
  pwsh += '\n'
  if (shLongProg) {
    pwsh = pwsh +
      '$ret=0\n' +
      `if (Test-Path ${pwshLongProg}) {\n` +
      `  & ${pwshLongProg} ${args} ${shTarget} $args\n` +
      '  $ret=$LASTEXITCODE\n' +
      '} else {\n' +
      `  & ${pwshProg} ${args} ${shTarget} $args\n` +
      '  $ret=$LASTEXITCODE\n' +
      '}\n' +
      (opts.nodePath ? '$env:NODE_PATH=$env_node_path\n' : '') +
      'exit $ret\n'
  } else {
    pwsh = pwsh +
      `& ${pwshProg} ${args} ${shTarget} $args\n` +
      (opts.nodePath ? '$env:NODE_PATH=$env_node_path\n' : '') +
      'exit $LASTEXITCODE\n'
  }

  return pwsh
}

function chmodShim (to) {
  return fs.chmod(to, 0o755)
}

/**
 * @param {string|string[]} nodePath
 * @returns {{win32:string,posix:string}}
 */
function normalizePathEnvVar (nodePath) {
  if (!nodePath) {
    return {
      win32: '',
      posix: ''
    }
  }
  let split = (typeof nodePath === 'string' ? nodePath.split(path.delimiter) : Array.from(nodePath))
  let result = {}
  for (let i = 0; i < split.length; i++) {
    const win32 = split[i].split('/').join('\\')
    const posix = isWindows() ? split[i].split('\\').join('/').replace(/^([^:\\/]*):/, (_, $1) => `/mnt/${$1.toLowerCase()}`) : split[i]

    result.win32 = result.win32 ? `${result.win32};${win32}` : win32
    result.posix = result.posix ? `${result.posix}:${posix}` : posix

    result[i] = {win32, posix}
  }
  return result
}
