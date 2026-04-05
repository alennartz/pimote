import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FilePushSubscriptionStore, migratePushSubscriptionStore } from './push-infrastructure.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'pimote-push-store-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('migratePushSubscriptionStore()', () => {
  it('moves the legacy file to the XDG state location when the new file is missing', async () => {
    const oldPath = join(tempDir, 'config', 'push-subscriptions.json');
    const newPath = join(tempDir, 'state', 'push-subscriptions.json');
    const payload = [{ endpoint: 'https://push.example.com/1', keys: { p256dh: 'k1', auth: 'a1' } }];

    await mkdir(join(tempDir, 'config'), { recursive: true });
    await writeFile(oldPath, JSON.stringify(payload, null, 2) + '\n', 'utf-8');

    await migratePushSubscriptionStore(oldPath, newPath);

    await expect(readFile(newPath, 'utf-8')).resolves.toContain('https://push.example.com/1');
    await expect(readFile(oldPath, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does nothing when the new file already exists', async () => {
    const oldPath = join(tempDir, 'config', 'push-subscriptions.json');
    const newPath = join(tempDir, 'state', 'push-subscriptions.json');

    await mkdir(join(tempDir, 'config'), { recursive: true });
    await mkdir(join(tempDir, 'state'), { recursive: true });
    await writeFile(oldPath, JSON.stringify([{ endpoint: 'https://push.example.com/old', keys: { p256dh: 'old', auth: 'old' } }]) + '\n', 'utf-8');
    await writeFile(newPath, JSON.stringify([{ endpoint: 'https://push.example.com/new', keys: { p256dh: 'new', auth: 'new' } }]) + '\n', 'utf-8');

    await migratePushSubscriptionStore(oldPath, newPath);

    await expect(readFile(newPath, 'utf-8')).resolves.toContain('https://push.example.com/new');
    await expect(readFile(oldPath, 'utf-8')).resolves.toContain('https://push.example.com/old');
  });
});

describe('FilePushSubscriptionStore', () => {
  it('saves into a nested state directory and reloads the same subscriptions', async () => {
    const filePath = join(tempDir, 'state', 'pimote', 'push-subscriptions.json');
    const store = new FilePushSubscriptionStore(filePath);
    const subscriptions = [{ endpoint: 'https://push.example.com/1', keys: { p256dh: 'k1', auth: 'a1' } }];

    await store.save(subscriptions);

    await expect(store.load()).resolves.toEqual(subscriptions);
  });
});
