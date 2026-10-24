/** Persisted reward receipts for a saved hero. A recovery token is a bearer secret,
 * not an account, proof of a human, or protection against edited offline saves. */
export const RECEIPT_LIMIT = 128;
export const RECEIPT_BATCH = 16;
const validHero = value => typeof value === 'string' && /^h-[a-f0-9]{32}$/.test(value);
const validToken = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = (code, message) => { const error = new Error(message); error.code = code; throw error; };
export const receiptSummary = record => ({ ledgerId: record.ledgerId,
  floor: record.pending.length ? Math.min(...record.pending.map(r => r.sequence)) - 1 : record.issued,
  pending: record.pending.length });

export class ReceiptStore {
  constructor(storage, uuid = () => crypto.randomUUID()) { this.storage = storage; this.uuid = uuid; }
  requireStorage() {
    if (!this.storage || typeof this.storage.transaction !== 'function') fail('storage_unavailable', 'Persistent reward storage is unavailable.');
  }
  async open(identity) {
    this.requireStorage();
    if (!identity || !validHero(identity.heroId) || !validToken(identity.token)) fail('identity', 'A saved hero and a secure recovery token are required.');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity.token));
    // Tokens never appear in storage keys, diagnostics, broadcasts, or receipts.
    const key = 'reward-owner:' + [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('');
    const record = await this.storage.transaction(async txn => {
      let value = await txn.get(key);
      if (value && value.heroId !== identity.heroId) fail('identity_mismatch', 'This recovery token belongs to a different saved hero.');
      if (!value) {
        value = { schema: 11, heroId: identity.heroId, ledgerId: `l-${this.uuid()}`, issued: 0, pending: [] };
        await txn.put(key, value);
      }
      return value;
    });
    return { key, record };
  }
  async get(key) {
    this.requireStorage();
    const record = await this.storage.get(key);
    if (!record) fail('identity', 'The saved hero recovery record is missing.');
    return record;
  }
  async settle(entries) {
    this.requireStorage();
    // Persist every participant's outcome atomically before announcing completion.
    return this.storage.transaction(async txn => {
      const results = [];
      for (const entry of entries) {
        const record = await txn.get(entry.ownerKey);
        if (!record || record.heroId !== entry.heroId) fail('identity_mismatch', 'The battle owner does not match its recovery record.');
        let receipt = record.pending.find(r => r.battleId === entry.battleId);
        if (!receipt) {
          if (record.pending.length >= RECEIPT_LIMIT) fail('receipts_full', 'Collect pending battle rewards before joining another expedition.');
          const sequence = ++record.issued;
          const { ownerKey, heroId, ...outcome } = entry;
          receipt = { ...outcome, sequence, ledgerId: record.ledgerId, rewardId: `${record.ledgerId}:${sequence}` };
          record.pending.push(receipt);
          await txn.put(entry.ownerKey, record);
        }
        results.push({ ownerKey: entry.ownerKey, heroId: entry.heroId, receipt, summary: receiptSummary(record) });
      }
      return results;
    });
  }
  async ack(key, heroId, packet) {
    this.requireStorage();
    return this.storage.transaction(async txn => {
      const record = await txn.get(key);
      if (!record || record.heroId !== heroId || record.ledgerId !== packet.ledgerId) fail('receipt_owner', 'This receipt belongs to a different hero or realm.');
      if (!Number.isSafeInteger(packet.sequence) || packet.sequence < 1 || packet.sequence > record.issued || packet.rewardId !== `${record.ledgerId}:${packet.sequence}`) fail('receipt', 'Invalid reward receipt acknowledgement.');
      const remaining = record.pending.filter(r => r.sequence !== packet.sequence);
      if (remaining.length !== record.pending.length) {
        record.pending = remaining;
        await txn.put(key, record);
      }
      return receiptSummary(record);
    });
  }
}
