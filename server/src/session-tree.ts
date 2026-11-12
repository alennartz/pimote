import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { PimoteTreeNode } from '../../shared/dist/index.js';

export type SessionTreeNode = ReturnType<AgentSession['sessionManager']['getTree']>[number];

const TREE_PREVIEW_MAX_CHARS = 200;

function truncatePreview(value: string): string {
  if (value.length <= TREE_PREVIEW_MAX_CHARS) return value;
  return `${value.slice(0, TREE_PREVIEW_MAX_CHARS - 3)}...`;
}

function textFromEntryContent(content: unknown, separator = '\n'): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type: 'text'; text: string } => {
      if (!block || typeof block !== 'object') return false;
      const candidate = block as { type?: unknown; text?: unknown };
      return candidate.type === 'text' && typeof candidate.text === 'string';
    })
    .map((block) => block.text)
    .join(separator);
}

function conversationTextForEntry(entry: SessionTreeNode['entry']): string | undefined {
  if (entry.type !== 'message') return undefined;
  const role = typeof entry.message.role === 'string' ? entry.message.role : undefined;
  if (role !== 'user' && role !== 'assistant') return undefined;
  return textFromEntryContent((entry.message as { content?: unknown } | undefined)?.content, '\n\n');
}

function previewForEntry(entry: SessionTreeNode['entry']): string {
  if (entry.type === 'message') {
    const messageContent = (entry.message as { content?: unknown } | undefined)?.content;
    const text = textFromEntryContent(messageContent);
    return truncatePreview(text || entry.type);
  }

  if (entry.type === 'custom_message') {
    const text = textFromEntryContent(entry.content);
    return truncatePreview(text || entry.type);
  }

  if (entry.type === 'compaction' || entry.type === 'branch_summary') {
    const summary = typeof entry.summary === 'string' ? entry.summary : '';
    return truncatePreview(summary || entry.type);
  }

  if (entry.type === 'context_edit') {
    return entry.replacement === null ? 'prompt message omitted' : 'prompt message edited';
  }

  return entry.type;
}

/** Map pi SDK tree nodes without recursive traversal. */
export function mapTreeNodes(nodes: readonly SessionTreeNode[]): PimoteTreeNode[] {
  const mapped: PimoteTreeNode[] = [];
  const pending: Array<{ node: SessionTreeNode; destination: PimoteTreeNode[] }> = [];

  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    pending.push({ node: nodes[i], destination: mapped });
  }

  while (pending.length > 0) {
    const current = pending.pop()!;
    const { node } = current;
    const timestamp = typeof node.entry.timestamp === 'string' ? node.entry.timestamp : new Date(0).toISOString();
    const conversationText = conversationTextForEntry(node.entry);
    const mappedNode: PimoteTreeNode = {
      id: node.entry.id,
      type: node.entry.type,
      role:
        node.entry.type === 'message'
          ? typeof node.entry.message.role === 'string'
            ? node.entry.message.role
            : undefined
          : 'role' in node.entry && typeof node.entry.role === 'string'
            ? node.entry.role
            : undefined,
      customType: 'customType' in node.entry && typeof node.entry.customType === 'string' ? node.entry.customType : undefined,
      preview: previewForEntry(node.entry),
      ...(conversationText !== undefined ? { conversationText } : {}),
      timestamp,
      label: node.label,
      labelTimestamp: node.labelTimestamp,
      children: [],
    };
    current.destination.push(mappedNode);

    for (let i = node.children.length - 1; i >= 0; i -= 1) {
      pending.push({ node: node.children[i], destination: mappedNode.children });
    }
  }

  return mapped;
}

/** Serialize a tree response without recursive traversal in JSON.stringify. */
export function serializeTreeResponse(id: string, tree: PimoteTreeNode[], currentLeafId: string | null): string {
  type Frame = { kind: 'array'; nodes: PimoteTreeNode[]; index: number } | { kind: 'close_node' };

  const chunks: string[] = ['{"id":', JSON.stringify(id), ',"success":true,"data":{"tree":['];
  const pending: Frame[] = [{ kind: 'array', nodes: tree, index: 0 }];

  while (pending.length > 0) {
    const frame = pending[pending.length - 1];
    if (frame.kind === 'close_node') {
      pending.pop();
      chunks.push('}');
      continue;
    }

    if (frame.index >= frame.nodes.length) {
      pending.pop();
      chunks.push(']');
      continue;
    }

    const node = frame.nodes[frame.index];
    frame.index += 1;
    if (frame.index > 1) chunks.push(',');

    chunks.push('{"id":', JSON.stringify(node.id), ',"type":', JSON.stringify(node.type));
    if (node.role !== undefined) chunks.push(',"role":', JSON.stringify(node.role));
    if (node.customType !== undefined) chunks.push(',"customType":', JSON.stringify(node.customType));
    chunks.push(',"preview":', JSON.stringify(node.preview));
    if (node.conversationText !== undefined) chunks.push(',"conversationText":', JSON.stringify(node.conversationText));
    chunks.push(',"timestamp":', JSON.stringify(node.timestamp));
    if (node.label !== undefined) chunks.push(',"label":', JSON.stringify(node.label));
    if (node.labelTimestamp !== undefined) chunks.push(',"labelTimestamp":', JSON.stringify(node.labelTimestamp));
    chunks.push(',"children":[');

    pending.push({ kind: 'close_node' });
    pending.push({ kind: 'array', nodes: node.children, index: 0 });
  }

  chunks.push(',"currentLeafId":', JSON.stringify(currentLeafId), '}}');
  return chunks.join('');
}
