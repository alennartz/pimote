import type {
  Card,
  FeedCursor,
  RepoInfo,
  SubagentAwaitData,
  SubagentEvent,
  SubagentEventData,
  SubagentLifecycleData,
  SubagentNodeEventData,
  SubagentNodeSnapshot,
  SubagentResurrectRequest,
  SubagentResurrectResult,
  SubagentSemanticFact,
  SubagentSnapshot,
  SubagentStopRequest,
  SubagentTeardownResult,
} from '../../shared/dist/index.js';
import type { Card as SdkCard, PanelMessage } from '@pimote/sdk/panels';
import type { RepoInfo as SdkRepoInfo } from '@pimote/sdk/folders';
import type {
  FeedCursor as SdkFeedCursor,
  SubagentAwaitData as SdkSubagentAwaitData,
  SubagentEvent as SdkSubagentEvent,
  SubagentEventData as SdkSubagentEventData,
  SubagentLifecycleData as SdkSubagentLifecycleData,
  SubagentNodeEventData as SdkSubagentNodeEventData,
  SubagentNodeSnapshot as SdkSubagentNodeSnapshot,
  SubagentResurrectRequest as SdkSubagentResurrectRequest,
  SubagentResurrectResult as SdkSubagentResurrectResult,
  SubagentSemanticFact as SdkSubagentSemanticFact,
  SubagentSnapshot as SdkSubagentSnapshot,
  SubagentStopRequest as SdkSubagentStopRequest,
  SubagentTeardownResult as SdkSubagentTeardownResult,
} from '@pimote/sdk/subagents';

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
const _subagentFeedCursor: AssertEqual<FeedCursor, SdkFeedCursor> = true;
const _subagentNode: AssertEqual<SubagentNodeSnapshot, SdkSubagentNodeSnapshot> = true;
const _subagentNodeEventData: AssertEqual<SubagentNodeEventData, SdkSubagentNodeEventData> = true;
const _subagentAwaitData: AssertEqual<SubagentAwaitData, SdkSubagentAwaitData> = true;
const _subagentLifecycleData: AssertEqual<SubagentLifecycleData, SdkSubagentLifecycleData> = true;
const _subagentEventData: AssertEqual<SubagentEventData, SdkSubagentEventData> = true;
const _subagentSemanticFact: AssertEqual<SubagentSemanticFact, SdkSubagentSemanticFact> = true;
const _subagentEvent: AssertEqual<SubagentEvent, SdkSubagentEvent> = true;
const _subagentSnapshot: AssertEqual<SubagentSnapshot, SdkSubagentSnapshot> = true;
const _subagentStop: AssertEqual<SubagentStopRequest, SdkSubagentStopRequest> = true;
const _subagentTeardown: AssertEqual<SubagentTeardownResult, SdkSubagentTeardownResult> = true;
const _subagentResurrectRequest: AssertEqual<SubagentResurrectRequest, SdkSubagentResurrectRequest> = true;
const _subagentResurrectResult: AssertEqual<SubagentResurrectResult, SdkSubagentResurrectResult> = true;
