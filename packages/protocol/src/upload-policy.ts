import Type from 'typebox'
import { RemoteTabError } from './errors.js'

export const UploadConstraintsSchema = Type.Object({
  maxFileBytes: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  maxBatchBytes: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  maxFiles: Type.Integer({ minimum: 1, maximum: 64 }),
  allowedExtensions: Type.Array(Type.String({ pattern: '^\\.[a-z0-9][a-z0-9._+-]{0,31}$' }), { maxItems: 64, uniqueItems: true }),
}, { additionalProperties: false })
export type UploadConstraints = Type.Static<typeof UploadConstraintsSchema>

/** Filename policy only; this does not identify or trust the contents of a file. */
export function assertUploadAllowed(files: readonly { displayName: string; size: number }[], limits: UploadConstraints): void {
  if (files.length === 0 || files.length > limits.maxFiles) throw new RemoteTabError('FILE_LIMIT_EXCEEDED', 'Selected file count exceeds the upload limit')
  let total = 0
  for (const file of files) {
    if (file.size > limits.maxFileBytes) throw new RemoteTabError('FILE_LIMIT_EXCEEDED', 'File exceeds the upload size limit')
    total += file.size
    if (!Number.isSafeInteger(total) || total > limits.maxBatchBytes) throw new RemoteTabError('FILE_LIMIT_EXCEEDED', 'Files exceed the batch size limit')
    if (limits.allowedExtensions.length > 0 && !limits.allowedExtensions.some(extension => file.displayName.toLowerCase().endsWith(extension))) {
      throw new RemoteTabError('FILE_LIMIT_EXCEEDED', 'File extension is not allowed')
    }
  }
}
