import { describe, it, expect } from 'vitest';
import { QueueOwnership, attributeDrained } from './queue-ownership.js';

describe('QueueOwnership', () => {
  it('tags a submitted message with its client once pi reports it queued', () => {
    const ledger = new QueueOwnership();
    ledger.intend('steering', 'client-a', 'first');
    ledger.syncFromPi('steering', ['first']);
    expect(ledger.snapshot().steering).toEqual([{ clientId: 'client-a', text: 'first' }]);
  });

  it('keeps tags aligned when pi consumes an earlier message', () => {
    const ledger = new QueueOwnership();
    ledger.intend('followUp', 'client-a', 'one');
    ledger.syncFromPi('followUp', ['one']);
    ledger.intend('followUp', 'client-b', 'two');
    ledger.syncFromPi('followUp', ['one', 'two']);
    ledger.syncFromPi('followUp', ['two']);
    expect(ledger.snapshot().followUp).toEqual([{ clientId: 'client-b', text: 'two' }]);
  });

  it('removes the first duplicate text, as pi does', () => {
    const ledger = new QueueOwnership();
    ledger.intend('steering', 'client-a', 'same');
    ledger.syncFromPi('steering', ['same']);
    ledger.intend('steering', 'client-b', 'other');
    ledger.syncFromPi('steering', ['same', 'other']);
    ledger.intend('steering', 'client-b', 'same');
    ledger.syncFromPi('steering', ['same', 'other', 'same']);
    // pi consumes the first "same", which belongs to client-a.
    ledger.syncFromPi('steering', ['other', 'same']);
    expect(ledger.snapshot().steering).toEqual([
      { clientId: 'client-b', text: 'other' },
      { clientId: 'client-b', text: 'same' },
    ]);
  });

  it('leaves messages the server did not submit untagged', () => {
    const ledger = new QueueOwnership();
    ledger.syncFromPi('steering', ['from-voice']);
    expect(ledger.snapshot().steering).toEqual([{ clientId: undefined, text: 'from-voice' }]);
  });

  it('drops intents that pi never queues once the session settles', () => {
    const ledger = new QueueOwnership();
    ledger.intend('steering', 'client-a', 'handled-by-extension');
    ledger.clearIntents();
    ledger.syncFromPi('steering', ['handled-by-extension']);
    expect(ledger.snapshot().steering).toEqual([{ clientId: undefined, text: 'handled-by-extension' }]);
  });

  it('returns copies from snapshot', () => {
    const ledger = new QueueOwnership();
    ledger.intend('steering', 'client-a', 'x');
    ledger.syncFromPi('steering', ['x']);
    const snapshot = ledger.snapshot();
    snapshot.steering.pop();
    expect(ledger.snapshot().steering).toHaveLength(1);
  });
});

describe('attributeDrained', () => {
  it('groups drained texts by submitting client and keeps pi order', () => {
    const ledger = new QueueOwnership();
    ledger.intend('steering', 'client-a', 'a1');
    ledger.syncFromPi('steering', ['a1']);
    ledger.intend('steering', 'client-b', 'b1');
    ledger.syncFromPi('steering', ['a1', 'b1']);
    ledger.intend('steering', 'client-a', 'a2');
    ledger.syncFromPi('steering', ['a1', 'b1', 'a2']);
    ledger.intend('followUp', 'client-b', 'b-later');
    ledger.syncFromPi('followUp', ['b-later']);

    const groups = attributeDrained(ledger.snapshot(), { steering: ['a1', 'b1', 'a2'], followUp: ['b-later'] }, 'client-a');
    expect(groups.get('client-a')).toEqual({ steering: ['a1', 'a2'], followUp: [] });
    expect(groups.get('client-b')).toEqual({ steering: ['b1'], followUp: ['b-later'] });
  });

  it('sends untagged texts to the fallback client', () => {
    const ledger = new QueueOwnership();
    ledger.syncFromPi('steering', ['voice']);
    const groups = attributeDrained(ledger.snapshot(), { steering: ['voice'], followUp: [] }, 'client-a');
    expect(groups.get('client-a')).toEqual({ steering: ['voice'], followUp: [] });
  });

  it('sends everything to the fallback client when the ledger disagrees with pi', () => {
    const ledger = new QueueOwnership();
    ledger.intend('steering', 'client-b', 'known');
    ledger.syncFromPi('steering', ['known']);
    const groups = attributeDrained(ledger.snapshot(), { steering: ['known', 'unknown'], followUp: [] }, 'client-a');
    expect([...groups.keys()]).toEqual(['client-a']);
    expect(groups.get('client-a')).toEqual({ steering: ['known', 'unknown'], followUp: [] });
  });

  it('returns no groups when pi drained nothing', () => {
    const groups = attributeDrained(new QueueOwnership().snapshot(), { steering: [], followUp: [] }, 'client-a');
    expect(groups.size).toBe(0);
  });
});
