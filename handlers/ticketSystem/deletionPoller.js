import logger from '../../utils/logger.js';
import * as resilience from '../resilience.js';
import { stmts } from './schema.js';

// ─── startTicketDeletionPoller ─────────────────────────────────────────────────
// closeTicketWithNotice() (lifecycle.js) schedules channel deletion via both
// an in-memory setTimeout (handles the common case with no polling delay)
// and a persisted delete_at column (this poller's fallback). A restart
// landing inside the delay window loses the setTimeout with it, the
// channel would otherwise sit there forever, never deleted. This sweeps for
// anything still due and finishes the job.
let _timer = null;

export function startTicketDeletionPoller(client) {
  if (_timer) return;

  const tick = async () => {
    const due = stmts.getDueForDeletion.all();
    for (const ticket of due) {
      try {
        if (ticket.channel_id) {
          await client.rest.delete(`/channels/${ticket.channel_id}`).catch(() => {
            // channel may already be gone, e.g. the setTimeout in
            // closeTicketWithNotice beat this poller to it but the process
            // died before clearDeleteSchedule ran, not an error worth logging.
          });
        }
      } finally {
        stmts.clearDeleteSchedule.run(ticket.id);
      }
    }
  };

  resilience.runLight('ticketDeletionPoller.tick', tick);
  _timer = setInterval(() => resilience.runLight('ticketDeletionPoller.tick', tick), 30_000);
  _timer.unref?.();
  logger.info('[TICKET] Deletion poller started (30s interval).');
}
