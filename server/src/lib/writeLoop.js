// Helpers for bulk tag-write loops (libraryBulkFix, tagEdit).

// node-taglib-sharp is synchronous; yield per file so bulk writes don't freeze the server.
export function yieldToEventLoop() {
  return new Promise((resolve) => { setImmediate(resolve); });
}

// Browser-safe failure: errno messages leak absolute paths.
export function describeFailure(err) {
  if (err?.code === 'STALE_PREVIEW') return { code: 'stale', message: err.message };
  switch (err?.code) {
    case 'ENOENT':
      return { code: 'missing', message: 'The file is no longer there.' };
    case 'EACCES':
    case 'EPERM':
    case 'EROFS':
      return { code: 'unwritable', message: 'The file could not be written to.' };
    case 'EIO':
    case 'ESTALE':
    case 'ENOTCONN':
      return { code: 'unreadable', message: 'The storage holding this file stopped responding.' };
    default:
      // 400s carry browser-safe messages; anything else stays vague.
      return err?.status === 400
        ? { code: 'rejected', message: err.message }
        : { code: 'failed', message: 'The file could not be written — see the server logs.' };
  }
}
