import type { On } from 'claude-code'
import { shellWritePaths } from './sensitive-file-guard'
import { SignOff, signOffText } from './signoff'

// An edit to `config.py.bak` changes nothing that runs. A leftover copy is decided by the file
// name's suffix, never by "backup" appearing inside a word, so `memory_backup.py` is fine.

const BACKUP = /(\.(bak|orig|old|backup|sav|prev)(\.\d+)?$|\.(bak|orig|backup)[-_.]?\d{6,}.*$|~$|(^|[\\/])copy of [^\\/]+$| - copy( \(\d+\))?\.[^.\\/]+$)/i

export const isBackupCopy = (path: string) => BACKUP.test(path)

/** The live file a backup copy was most likely made from. */
export function liveFile(path: string): string {
  return path
    .replace(/\.(bak|orig|backup)[-_.]?\d{6,}.*$/i, '')
    .replace(/\.(bak|orig|old|backup|sav|prev)(\.\d+)?$/i, '')
    .replace(/~$/, '')
    .replace(/([\\/])copy of ([^\\/]+)$/i, '$1$2')
    .replace(/ - copy( \(\d+\))?(\.[^.\\/]+)$/i, '$2')
}

export function backupFileGuard(on: On, signOff: SignOff) {
  on('tool.call', { tool: ['Edit', 'Write', 'NotebookEdit', 'Bash', 'PowerShell'] }, async ($, e: any, next) => {
    const fp = typeof e.command === 'string'
      ? shellWritePaths(e.command).find(isBackupCopy) ?? ''
      : String(e.file_path ?? e.notebook_path ?? '')
    if (!fp || !isBackupCopy(fp)) return next(e)
    const key = `backup\u0000${fp.replace(/\\/g, '/').toLowerCase()}`
    if (signOff.consume(key, await $.clock.now())) return next(e)
    const live = liveFile(fp)
    return { deny: `[backup-file-guard] Refused: ${fp} is a backup copy, so editing it changes nothing that runs. ` +
      `Edit the live file${live !== fp ? ` (${live})` : ''} instead. If this copy really is the target: ${signOffText(signOff.codeFor(key))}` }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: '[backup-file-guard] Refused: the path could not be checked.' }))
}
