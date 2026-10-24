import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SPILL_INLINE_BYTES, spillRows } from './spill.js';

const fs = vi.hoisted(() => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  readdir: vi.fn(),
  unlink: vi.fn(),
}));

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  ...fs,
}));
vi.mock('../paths.js', () => ({ PIMOTE_TOOL_SPILL_DIR: '/virtual/spills' }));

beforeEach(() => {
  vi.resetAllMocks();
  fs.mkdir.mockResolvedValue(undefined);
  fs.writeFile.mockResolvedValue(undefined);
  fs.readdir.mockResolvedValue([]);
  fs.unlink.mockResolvedValue(undefined);
});

function wideRows() {
  return Array.from({ length: 30 }, (_, index) => ({ name: `row-${index}`, text: 'é'.repeat(500) }));
}

describe('spillRows', () => {
  it('returns small results without saving a file', async () => {
    const rows = [{ name: 'one' }];
    expect(await spillRows('find', rows)).toEqual({ rows });
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it('reports the saved file byte size, line count, and search hint', async () => {
    const rows = wideRows();
    const result = await spillRows('find', rows);
    const [file, contents] = fs.writeFile.mock.calls[0] as [string, string];

    expect(result.spill).toMatchObject({ file, bytes: Buffer.byteLength(contents), rows: rows.length - result.rows.length });
    expect(
      contents
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line)),
    ).toEqual(rows.slice(result.rows.length));
    expect(result.spill?.hint).toContain(`${result.spill?.bytes} bytes`);
    expect(result.spill?.hint).toContain(`${result.spill?.rows} lines`);
    expect(result.spill?.hint).toContain('jq');
    expect(result.spill?.hint).not.toContain('larger limit');
  });

  it('keeps the inline prefix when directory creation fails', async () => {
    fs.mkdir.mockRejectedValue(new Error('permission denied'));
    const rows = wideRows();
    const result = await spillRows('find', rows);

    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows.length).toBeLessThan(rows.length);
    expect(Buffer.byteLength(result.rows.map((row) => JSON.stringify(row)).join('\n'))).toBeLessThanOrEqual(SPILL_INLINE_BYTES);
    expect(result.spill).toBeUndefined();
    expect(result.warning).toContain('Full output is unavailable');
    expect(result.warning).toContain('permission denied');
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it('keeps the inline prefix and removes a partial file when writing fails', async () => {
    fs.writeFile.mockRejectedValue(new Error('disk full'));
    const result = await spillRows('find', wideRows());

    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.spill).toBeUndefined();
    expect(result.warning).toContain('disk full');
    expect(fs.unlink).toHaveBeenCalledWith(fs.writeFile.mock.calls[0][0]);
  });

  it('bounds the warning when saving and partial-file cleanup both fail', async () => {
    fs.writeFile.mockRejectedValue(new Error('é'.repeat(10_000)));
    fs.unlink.mockRejectedValue(new Error('cleanup failed'));
    const result = await spillRows('find', wideRows());

    expect(Buffer.byteLength(result.warning ?? '')).toBeLessThan(1_024);
    expect(result.warning).toContain('error truncated');
    expect(result.spill).toBeUndefined();
  });

  it('does not turn cancellation into a spill warning', async () => {
    const controller = new AbortController();
    fs.writeFile.mockImplementation(async () => {
      controller.abort();
      throw new Error('write stopped');
    });

    await expect(spillRows('find', wideRows(), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('keeps an oversized first row without claiming a hard inline bound', async () => {
    const rows = [{ name: 'large', text: 'x'.repeat(SPILL_INLINE_BYTES + 1) }];
    expect(await spillRows('find', rows)).toEqual({ rows });
    expect(fs.writeFile).not.toHaveBeenCalled();
  });
});
