// Sends a Blob to the Swift host in chunks; the host stages it and shows the share sheet (HostTools.swift).
import { nativeRequest } from './ios-midi.js'
import { SHARE_LIMIT_BYTES } from './export-limit.js'

// The host accepts plain file names only (letters, digits, . _ - and space, starting with a letter or digit).
export function safeName(name) {
  const clean = String(name).normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9._ -]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').replace(/\.{2,}/g, '.').slice(0, 128)
  return clean || 'keylight-file'
}

export async function exportBlob(blob, rawName) {
  const name = safeName(rawName)
  if (blob.size > SHARE_LIMIT_BYTES) throw new RangeError('This file is too large to share. The limit is ' + Math.round(SHARE_LIMIT_BYTES / 1048576) + ' MB.')
  const token = await nativeRequest('exportBegin', { name, mime: /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(blob.type.split(';')[0]) ? blob.type.split(';')[0] : 'application/octet-stream', size: blob.size })
  try {
    for (let offset = 0; offset < blob.size; offset += 32768) {
      const bytes = new Uint8Array(await blob.slice(offset, offset + 32768).arrayBuffer())
      let binary = ''
      for (const byte of bytes) binary += String.fromCharCode(byte)
      await nativeRequest('exportChunk', { token, data: btoa(binary) })
    }
    await nativeRequest('exportFinish', { token })
  } catch (error) {
    await nativeRequest('exportAbort', { token }).catch(() => {})
    throw error
  }
}
