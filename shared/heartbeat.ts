import type { On } from 'claude-code'

/** Writes `<dir>/<pack>.txt` at each session start, so a watcher outside the session can tell the pack loaded. */
export function heartbeat(on: On, dir: string, pack: string) {
  if (!dir) return
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
    const folder = dir.replace(/^~(?=[\/]|$)/, home).replace(/[\/]+$/, '')
    await $.fs.write(`${folder}/${pack}.txt`, new Date(await $.clock.now()).toISOString())
    return r
  })
}
