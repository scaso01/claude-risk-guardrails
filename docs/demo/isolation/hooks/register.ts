import type { Register } from 'claude-code'

const DROP = new Set(['claudeMd', 'userEmail'])

export const register: Register = (on) => {
  on('prompt.context', async ($, e, next) => {
    const r = await next(e)
    return { blocks: r.blocks.filter(b => !DROP.has(b.name)), instructionFiles: [] }
  })
}
