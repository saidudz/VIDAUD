const FOLDER_INVALID_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g
const FOLDER_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
const MAX_FOLDER_LENGTH = 120

/**
 * Build a Windows-safe folder name from a playlist title, keeping as much of the
 * original name as possible (including Arabic/French/Spanish/Unicode letters).
 * Invalid characters are replaced by spaces; reserved device names are prefixed.
 */
export function sanitizeFolderName(input: string, fallback = 'Playlist'): string {
  let name = (input || '').trim()
  name = name.replace(FOLDER_INVALID_CHARS, ' ').replace(/\s+/g, ' ').replace(/[. ]+$/g, '')
  if (name.length === 0) name = fallback
  if (FOLDER_RESERVED.test(name)) name = `_${name}`
  if (name.length > MAX_FOLDER_LENGTH) {
    name = name.slice(0, MAX_FOLDER_LENGTH).trim()
  }
  if (name.length === 0) name = fallback
  return name
}
