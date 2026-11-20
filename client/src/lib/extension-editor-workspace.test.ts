import { describe, expect, it, vi } from 'vitest';
import { ExtensionEditorWorkspaceHost, type EditorRequest, type EditorWorkspaceKey, type EditorWireAnswer } from './extension-editor-workspace.js';

function request(sessionId: string, requestId: string, prefill = 'seed'): EditorRequest {
  return {
    key: { sessionId, requestId },
    title: `${sessionId} editor`,
    message: 'Edit the extension text',
    prefill,
  };
}

function key(sessionId: string, requestId: string): EditorWorkspaceKey {
  return { sessionId, requestId };
}

describe('ExtensionEditorWorkspaceHost', () => {
  it('keeps one workspace per session/request pair and preserves replayed editor state', () => {
    const sendResponse = vi.fn<(key: EditorWorkspaceKey, answer: EditorWireAnswer) => Promise<boolean>>(async () => true);
    const host = new ExtensionEditorWorkspaceHost({ sendResponse });
    const original = request('session-a', 'request-1', 'original');

    host.ingestRequest(original);
    host.setValue(original.key, 'edited');
    host.ingestRequest({ ...original, title: 'Updated title', prefill: 'different replay prefill' });

    expect(host.workspaces).toHaveLength(1);
    expect(host.workspaces[0]).toMatchObject({
      key: original.key,
      value: 'edited',
      baseline: 'original',
      dirty: true,
      request: { title: 'Updated title' },
    });
    expect(host.workspaces[0]?.sequence).toBe(0);
  });

  it('parks a workspace when changing sessions without sending a response', () => {
    const sendResponse = vi.fn<(key: EditorWorkspaceKey, answer: EditorWireAnswer) => Promise<boolean>>(async () => true);
    const host = new ExtensionEditorWorkspaceHost({ sendResponse });
    const first = request('session-a', 'request-1');
    const second = request('session-b', 'request-1');

    host.ingestRequest(first);
    host.ingestRequest(second);
    host.setViewedSession('session-a');
    expect(host.active?.key).toEqual(first.key);

    host.setViewedSession('session-b');
    expect(host.active?.key).toEqual(second.key);
    expect(host.workspaces.map((workspace) => workspace.key)).toEqual([first.key, second.key]);
    expect(sendResponse).not.toHaveBeenCalled();

    host.setViewedSession('session-a');
    expect(host.active?.key).toEqual(first.key);
    expect(host.active?.value).toBe('seed');
  });

  it('hides all workspaces on the dashboard without resolving them', () => {
    const sendResponse = vi.fn<(key: EditorWorkspaceKey, answer: EditorWireAnswer) => Promise<boolean>>(async () => true);
    const host = new ExtensionEditorWorkspaceHost({ sendResponse });
    const editor = request('session-a', 'request-1');

    host.ingestRequest(editor);
    host.setViewedSession('session-a');
    host.setViewedSession(null);

    expect(host.active).toBeNull();
    expect(host.workspaces).toHaveLength(1);
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('requires discard confirmation before cancelling dirty text', async () => {
    const sendResponse = vi.fn<(key: EditorWorkspaceKey, answer: EditorWireAnswer) => Promise<boolean>>(async () => true);
    const host = new ExtensionEditorWorkspaceHost({ sendResponse });
    const editor = request('session-a', 'request-1', 'original');

    host.ingestRequest(editor);
    host.setValue(editor.key, 'edited');

    await expect(host.answer(editor.key, 'cancel')).resolves.toEqual({ kind: 'needs-discard-confirmation' });
    expect(sendResponse).not.toHaveBeenCalled();

    await expect(host.answer(editor.key, 'discard')).resolves.toEqual({ kind: 'submitted' });
    expect(sendResponse).toHaveBeenCalledWith(editor.key, { cancelled: true });
    expect(host.workspaces).toHaveLength(0);
  });

  it('saves empty editor text as a value', async () => {
    const sendResponse = vi.fn<(key: EditorWorkspaceKey, answer: EditorWireAnswer) => Promise<boolean>>(async () => true);
    const host = new ExtensionEditorWorkspaceHost({ sendResponse });
    const editor = request('session-a', 'request-1', 'seed');

    host.ingestRequest(editor);
    host.setValue(editor.key, '');

    await expect(host.answer(editor.key, 'save')).resolves.toEqual({ kind: 'submitted' });
    expect(sendResponse).toHaveBeenCalledWith(editor.key, { value: '' });
  });

  it('retains a workspace after a failed response for retry', async () => {
    const sendResponse = vi.fn<(key: EditorWorkspaceKey, answer: EditorWireAnswer) => Promise<boolean>>(async () => false);
    const host = new ExtensionEditorWorkspaceHost({ sendResponse });
    const editor = request('session-a', 'request-1');

    host.ingestRequest(editor);
    await expect(host.answer(editor.key, 'save')).resolves.toEqual({ kind: 'retryable' });

    expect(host.workspaces).toHaveLength(1);
    expect(host.workspaces[0]?.status).toBe('pending');
  });

  it('does not let an old response retire a replayed workspace', async () => {
    let finishFirstSend!: (accepted: boolean) => void;
    const firstSend = new Promise<boolean>((resolve) => {
      finishFirstSend = resolve;
    });
    const sendResponse = vi.fn<(key: EditorWorkspaceKey, answer: EditorWireAnswer) => Promise<boolean>>().mockReturnValueOnce(firstSend).mockResolvedValue(true);
    const host = new ExtensionEditorWorkspaceHost({ sendResponse });
    const editor = request('session-a', 'request-1', 'original');

    host.ingestRequest(editor);
    host.setValue(editor.key, 'before reconnect');
    const firstAnswer = host.answer(editor.key, 'save');

    host.restoreStarted(editor.key.sessionId);
    host.ingestRequest(editor);
    host.setValue(editor.key, 'after reconnect');
    finishFirstSend(true);

    await expect(firstAnswer).resolves.toEqual({ kind: 'stale' });
    expect(host.workspaces).toHaveLength(1);
    expect(host.workspaces[0]).toMatchObject({ value: 'after reconnect', status: 'pending' });
  });

  it('waits for the restore barrier before pruning absent requests', () => {
    const sendResponse = vi.fn<(key: EditorWorkspaceKey, answer: EditorWireAnswer) => Promise<boolean>>(async () => true);
    const host = new ExtensionEditorWorkspaceHost({ sendResponse });
    const retained = request('session-a', 'retained');
    const pruned = request('session-a', 'pruned');

    host.ingestRequest(retained);
    host.ingestRequest(pruned);
    host.restoreStarted('session-a');
    host.restoreCompleted('session-a');
    expect(host.workspaces).toHaveLength(2);

    host.ingestRequest(retained);
    expect(host.workspaces).toHaveLength(2);
    host.restoreBarrier('session-a');

    expect(host.workspaces.map((workspace) => workspace.key)).toEqual([retained.key]);
  });

  it('retires old identity on session replacement without migrating its workspace', () => {
    const sendResponse = vi.fn<(key: EditorWorkspaceKey, answer: EditorWireAnswer) => Promise<boolean>>(async () => true);
    const host = new ExtensionEditorWorkspaceHost({ sendResponse });
    const oldRequest = request('old-session', 'request-1');
    const newRequest = request('new-session', 'request-1');

    host.ingestRequest(oldRequest);
    host.sessionReplaced('old-session', 'new-session');
    host.ingestRequest(newRequest);

    expect(host.workspaces.map((workspace) => workspace.key)).toEqual([newRequest.key]);
  });

  it('retires every workspace when its session closes', () => {
    const sendResponse = vi.fn<(key: EditorWorkspaceKey, answer: EditorWireAnswer) => Promise<boolean>>(async () => true);
    const host = new ExtensionEditorWorkspaceHost({ sendResponse });
    host.ingestRequest(request('session-a', 'one'));
    host.ingestRequest(request('session-a', 'two'));
    host.ingestRequest(request('session-b', 'one'));

    host.sessionClosed('session-a');

    expect(host.workspaces.map((workspace) => workspace.key)).toEqual([key('session-b', 'one')]);
  });
});
