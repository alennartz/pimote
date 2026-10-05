import type { Card, RepoInfo } from '../../shared/dist/index.js';
import type { Card as SdkCard, PanelMessage } from '@pimote/sdk/panels';
import type { RepoInfo as SdkRepoInfo } from '@pimote/sdk/folders';

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
