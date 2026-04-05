import { readFile, writeFile, mkdir, rename, copyFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import webpush from 'web-push';
import type { PushSubscriptionRecord, SubscriptionStore, PushSender } from './push-notification.js';

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw err;
  }
}

export async function migratePushSubscriptionStore(oldPath: string, newPath: string): Promise<void> {
  if (oldPath === newPath) return;
  if (await exists(newPath)) return;
  if (!(await exists(oldPath))) return;

  await mkdir(dirname(newPath), { recursive: true });

  try {
    await rename(oldPath, newPath);
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && (err as NodeJS.ErrnoException).code === 'EXDEV') {
      await copyFile(oldPath, newPath);
      await unlink(oldPath);
      return;
    }
    throw new Error('Failed to migrate push subscriptions', { cause: err });
  }
}

export class FilePushSubscriptionStore implements SubscriptionStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<PushSubscriptionRecord[]> {
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      return JSON.parse(raw) as PushSubscriptionRecord[];
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw new Error('Failed to load push subscriptions', { cause: err });
    }
  }

  async save(subscriptions: PushSubscriptionRecord[]): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      const tmpPath = this.filePath + '.tmp';
      await writeFile(tmpPath, JSON.stringify(subscriptions, null, 2) + '\n', 'utf-8');
      await rename(tmpPath, this.filePath);
    } catch {
      throw new Error('Failed to save push subscriptions');
    }
  }
}

export class WebPushSender implements PushSender {
  constructor(vapidPublicKey: string, vapidPrivateKey: string, vapidEmail: string) {
    webpush.setVapidDetails('mailto:' + vapidEmail, vapidPublicKey, vapidPrivateKey);
  }

  async sendNotification(subscription: PushSubscriptionRecord, payload: string): Promise<{ statusCode: number }> {
    const response = await webpush.sendNotification(subscription, payload);
    return { statusCode: response.statusCode };
  }
}
