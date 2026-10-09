// Shared WebSocket probe client for manual-test tools: a second protocol
// client that drives wire commands and observes events independently of the
// PWA under test (two-client sync, cache-replace and delta probes).
//
// Usage:
//   const probe = new WsProbe(port, `my-probe-${id}`);
//   await probe.open();
//   const { data } = await probe.send({ type: 'list_folders' });
//   const listing = await probe.listFolders({ limit: 3 });   // accumulate
//   await probe.waitForEvent('folders_changed', (e) => …);
//   probe.close();

let nextCmdId = 0;

export class WsProbe {
  constructor(port, clientId) {
    this.url = `ws://127.0.0.1:${port}/ws?clientId=${clientId}`;
    this.pending = new Map();
    this.events = [];
    this.ws = null;
  }

  async open() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', (e) => reject(e.error ?? new Error('ws error')), { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.type === 'response' || message.success !== undefined) {
        const pending = this.pending.get(message.id);
        if (pending) {
          this.pending.delete(message.id);
          pending(message);
        }
        return;
      }
      this.events.push({ at: Date.now(), event: message });
    });
  }

  send(payload) {
    const id = `probe-${++nextCmdId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`probe timeout waiting for response to ${payload.type}`)), 30_000);
      this.pending.set(id, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
      this.ws.send(JSON.stringify({ id, ...payload }));
    });
  }

  /**
   * Accumulate a complete listing while adopting each response's pin.
   * Returns the final response with `data.folders` replaced by the deduped
   * complete row set, plus `windowPaths`: every path in served order across
   * the windows (duplicate detection), and `windowCount`.
   */
  async listFolders({ includeArchived = false, repin = false, query, limit = 3 } = {}) {
    const rows = new Map();
    const windowPaths = [];
    let offset = 0;
    let orderToken;
    let windowCount = 0;
    for (;;) {
      const response = await this.send({ type: 'list_folders', offset, limit, includeArchived, repin: offset === 0 && repin, orderToken, query });
      if (!response.success) throw new Error(`list_folders failed: ${JSON.stringify(response)}`);
      const data = response.data;
      if (typeof data.orderToken !== 'string' || typeof data.epoch !== 'number' || typeof data.total !== 'number' || typeof data.more !== 'boolean') {
        throw new Error(`invalid folder window: ${JSON.stringify(data)}`);
      }
      windowCount++;
      for (const row of data.folders) {
        rows.set(row.path, row);
        windowPaths.push(row.path);
      }
      orderToken = data.orderToken;
      offset += data.folders.length;
      if (!data.more) return { ...response, data: { ...data, folders: [...rows.values()] }, windowPaths, windowCount };
      if (data.folders.length === 0) throw new Error('folder window made no progress');
    }
  }

  /** Events received strictly after `since` (ms epoch). */
  eventsSince(since, type) {
    return this.events.filter((e) => e.at > since && (!type || e.event.type === type));
  }

  async waitForEvent(type, predicate, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // Scan the full history: the event may land while earlier awaits in the
      // caller are still settling, before waitForEvent is entered.
      const hits = this.events.filter((e) => e.event.type === type && (!predicate || predicate(e.event)));
      if (hits.length > 0) return hits[0].event;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`timed out waiting for ${type} event`);
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      // Already closed.
    }
  }
}
