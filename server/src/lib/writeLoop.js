// Shared by the two flows that write tags to a whole album's worth of files —
// services/libraryBulkFix.js and services/tagEdit.js. Extracted here rather than
// exported from libraryBulkFix because tagEdit needs both of these and nothing
// else from it: importing that module would pull libraryDiscography and then
// musicbrainz into a service that makes no upstream call at all, which also means
// MB_CONTACT_EMAIL would become a requirement of every tagEdit test.

// node-taglib-sharp is synchronous, and both readTags and writeTags are
// whole-file operations. Before this yield, a bulk write ran the same calls in a
// 500-iteration loop on the main thread — freezing the server, the healthcheck
// and every other request for the length of a bulk repair of a lossless album.
//
// A worker would be the thorough fix; a yield per file is the cheap one that
// makes the freeze interruptible, which is the part that actually mattered. The
// tag IO still costs what it costs, but it no longer costs it all at once.
export function yieldToEventLoop() {
  return new Promise((resolve) => { setImmediate(resolve); });
}

// Turns a filesystem failure into something safe to send to the browser.
// An errno message carries the absolute path it failed on, and these responses
// are rendered in a page — the same reason paths.js logs the path and returns a
// generic string. The code is enough for the UI to say something useful.
export function describeFailure(err) {
  // Written by the caller for the browser, so it passes through verbatim.
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
      // A BadRequestError from the containment check already carries a message
      // written for the browser; anything else stays deliberately vague.
      return err?.status === 400
        ? { code: 'rejected', message: err.message }
        : { code: 'failed', message: 'The file could not be written — see the server logs.' };
  }
}
