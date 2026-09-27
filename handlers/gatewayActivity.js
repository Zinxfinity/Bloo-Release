// ─── Gateway activity tracker ──────────────────────────────────────────────
// Tracks when the last gateway event was received, independent of guild
// activity level. A quiet server can go minutes without a message even on a
// perfectly healthy connection, so this only needs to be bumped by *some*
// frequent event (messageCreate) to prove the WebSocket is still receiving
// data, not every event type needs to call this.
//
// Read by handlers/heartbeat.js to detect a dead-but-still-"connected"
// WebSocket (no close frame, socket just stopped delivering data): the event
// loop stays alive and client.isReady() stays true, but nothing ever arrives.

let lastEventAt = Date.now();

export function bumpGatewayEvent() {
  lastEventAt = Date.now();
}

export function getLastEventAgeS() {
  return (Date.now() - lastEventAt) / 1000;
}
