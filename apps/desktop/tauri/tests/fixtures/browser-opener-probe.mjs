/** Observe native browser handoffs without opening a user's browser during Host tests. */
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'

const spawn = childProcess.spawn
childProcess.spawn = function (command, args, options) {
  if (command === process.execPath && args?.includes('--eval')
    && args.some(arg => typeof arg === 'string' && arg.includes('await open(process.argv[1])'))) {
    process.stderr.write('VERBOO_TEST_BROWSER_HANDOFF\n')
    return spawn(command, ['--eval', ''], options)
  }
  return spawn(command, args, options)
}
syncBuiltinESMExports()
