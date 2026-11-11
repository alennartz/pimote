import type { Card, RepoInfo, SubagentEvent, SubagentSnapshot } from '../../shared/dist/index.js';
import type { Card as SdkCard, PanelMessage } from '@pimote/sdk/panels';
import type { RepoInfo as SdkRepoInfo } from '@pimote/sdk/folders';
import type { SubagentEvent as SdkSubagentEvent, SubagentSnapshot as SdkSubagentSnapshot } from '@pimote/sdk/subagents';

type AssertEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

/** Exact key-set equality — mutual assignability alone cannot see optional-field renames/additions. */
type AssertSameKeys<A, B> = [keyof A] extends [keyof B] ? ([keyof B] extends [keyof A] ? true : never) : never;

/** Prior server-side bus-message shape; retained only for this assertion. */
type PanelBusMessage = { type: 'cards'; namespace: string; cards: Card[] } | { type: 'clear'; namespace: string };

const _repoInfo: AssertEqual<RepoInfo, SdkRepoInfo> = true;
const _repoInfoKeys: AssertSameKeys<RepoInfo, SdkRepoInfo> = true;
const _card: AssertEqual<Card, SdkCard> = true;
const _cardKeys: AssertSameKeys<Card, SdkCard> = true;
const _panelMsg: AssertEqual<PanelMessage, PanelBusMessage> = true;
const _subagentEvent: AssertEqual<SubagentEvent, SdkSubagentEvent> = true;
const _subagentSnapshot: AssertEqual<SubagentSnapshot, SdkSubagentSnapshot> = true;
