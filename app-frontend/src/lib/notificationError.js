import { normalizeApiError } from './apiError'

// ---------------------------------------------------------------------------
// Why the notification centre is empty
// ---------------------------------------------------------------------------
// THE PAGE USED TO LIE. It had no error branch at all: a failed request left
// `items` as an empty array, so it fell through to the empty state and told
// the reader "No notifications yet. Approvals, access decisions and security
// events will appear here." That sentence is a claim about the account, and
// the console had not managed to ask. Somebody waiting on an approval read it
// as "nothing is waiting on me".
//
// The panel was better but still vague: "The console could not reach the
// notification service" describes exactly one of the ways this fails, and it
// guessed. A 404 is not unreachable, it is a server that does not have this
// endpoint, which is a completely different thing to do about.
//
// So the failure is classified, and each case says the one thing that is true
// and the one thing that helps. Nothing here retries or reports on its own:
// react-query already retries, and this is only the words.
export function describeNotificationError(error) {
  const err = normalizeApiError(error)

  if (err.code === 'network_error') {
    return {
      title: 'Notifications are unavailable',
      detail:
        'The console could not reach the server at all. Check your connection; it will retry on its own.',
    }
  }

  // The one worth naming precisely. A 404 here means the server answered and
  // has no such route, which is what an install running a backend older than
  // the notification centre looks like from the browser. Told plainly, this is
  // a five second diagnosis instead of a bug report.
  if (err.status === 404) {
    return {
      title: 'Notifications are not available on this server',
      detail:
        'This console expects a notification service the server does not provide. It usually means the backend is running an older build than the console.',
    }
  }

  if (err.status === 401 || err.status === 403) {
    return {
      title: 'Notifications are not available to this account',
      detail: 'Your session may have ended. Sign out and back in, and if it persists ask an administrator.',
    }
  }

  if (err.status >= 500) {
    return {
      title: 'Notifications could not be loaded',
      detail: `The server returned an error (${err.status}). It will retry on its own; if it persists this is one for whoever runs the server.`,
    }
  }

  return {
    title: 'Notifications could not be loaded',
    detail: err.message || 'The request did not complete. It will retry on its own.',
  }
}
