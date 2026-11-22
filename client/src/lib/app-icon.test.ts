import { describe, expect, it } from 'vitest';
import type { AppInfo } from '@pimote/shared';
import { appIconLetter, appIconProxyPath, iconCandidates } from './app-icon.js';

const APP: AppInfo = {
  slug: 'notes',
  title: 'Quick Notes',
  target: 'http://127.0.0.1:4173',
  url: 'https://notes.apps.example.com',
  createdAt: '2026-06-01T10:00:00.000Z',
  updatedAt: '2026-06-01T10:00:00.000Z',
};

describe('iconCandidates', () => {
  it('tries the same-origin proxy for a configured icon URL before the origin favicon', () => {
    expect(iconCandidates({ ...APP, icon: 'https://cdn.example.com/logo.png' })).toEqual(['/app-icons/notes', 'https://notes.apps.example.com/favicon.ico']);
  });

  it('renders data URIs directly instead of the proxy', () => {
    const dataUri = 'data:image/png;base64,AAAA';
    expect(iconCandidates({ ...APP, icon: dataUri })).toEqual([dataUri, 'https://notes.apps.example.com/favicon.ico']);
  });

  it('falls back to the origin favicon alone when no icon is configured', () => {
    expect(iconCandidates(APP)).toEqual(['https://notes.apps.example.com/favicon.ico']);
  });

  it('returns no favicon candidate for an unparseable app URL', () => {
    expect(iconCandidates({ ...APP, url: 'not-a-url' })).toEqual([]);
  });

  it('builds the proxy path from the slug', () => {
    expect(appIconProxyPath('budget')).toBe('/app-icons/budget');
  });
});

describe('appIconLetter', () => {
  it('uses the first grapheme of the title, uppercased', () => {
    expect(appIconLetter('quick notes')).toBe('Q');
    expect(appIconLetter('Übersicht')).toBe('Ü');
  });

  it('falls back to a placeholder for a blank title', () => {
    expect(appIconLetter('   ')).toBe('?');
  });
});
