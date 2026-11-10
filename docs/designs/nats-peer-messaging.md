# Design: NATS peer messaging across Pimote nodes

Status: draft

## Context

Each Pimote instance runs a local NATS server with JetStream. Pimote auto-provisions a main local account (`A-A`) for that instance's roots, directory, and intra-node conversations. When two instances trust each other, Pimote's UI provisions a separate account namespace (`A-B`) for that peer pair and links the NATS servers. This note records the current decisions and separates them from the local-to-peer bridge, delivery, and write-authority questions that remain open.

## Agreed direction

- **One local NATS server per Pimote instance.** JetStream stores local session and peer traffic. A single server is a single replica, not a highly available NATS cluster. File storage supports recovery after a server restart when its disk remains intact.
- **One leaf link per trusted Pimote pair.** The link is full duplex. One server dials the other server's leaf listener. The dial direction does not determine message direction. A second reciprocal link is not needed.
- **Two account scopes per node relationship.** Each instance has an auto-provisioned local account (`A-A`) for its own roots, directory, and intra-node conversations. Pimote's UI creates a separate peer account (`A-B`) for a trusted pair and its cross-server traffic. A–C use `A-C`; do not use one account for all peers or one account per root.
- **Pimote provisions peer accounts through static NATS config.** The UI creates the A-B account and leaf-user entries on both nodes, then reloads their NATS servers. In static-config mode, account names are local labels, not cryptographic identities. Each Pimote node uses one restricted NKey user per peer account, not one per root. The accepting server stores that user's public key; the private seed stays on its owning node. The model does not see it. The my-pi provider enforces active root-connection state before sending. The credential exchange and which node dials remain open.
- **The Pi session UUID identifies a root conversation.** Session names and folder labels are mutable discovery metadata, not identities.
- **Root connections are single-use.** Each connect creates a unique `connectionId`; the active local `ROOT_CONNECTIONS` view contains that ID. A close references it and deletes it from both local views through the peer control channel. Reconnecting the same root pair creates a new ID. A closed ID never reopens. Messages already queued with a closed ID are still delivered with a stale-connection marker; replies require a new connection ID.
- **Root messages stay asynchronous across roots.** A recipient can answer with the incoming correlation ID. The sender is not told that the recipient received or processed the message.
- **A root send is accepted at local storage.** The sender reports success after its local outbox receives a JetStream PubAck. Remote stream storage and transcript admission are separate acknowledgements; the tool does not claim either happened.
- **Outboxes do not expire by age.** WorkQueue messages remain until acknowledged or explicitly cleaned up. Streams use bounded size/count limits with `DiscardNew`; senders stop admitting message data below the hard limit to reserve room for connection-control events.
- **Peer outboxes do not expire messages by age.** Use bounded `MaxBytes`/`MaxMsgs` with `DiscardNew`, so a full queue rejects new sends rather than silently evicting unread messages. The limits are not yet sized.
- **Root discovery is shared per peer, per side.** Each side chooses which roots it exposes to that peer: selected roots, roots in selected folders, or all roots. Sharing metadata does not open a root-to-root communication connection. A separate root connection authorizes conversation traffic.
- **A root connection has two logical states.** The canonical root-pair key is present when connected and absent when disconnected. There is no online/pending state; NATS link reachability is separate. A replicated delete marker is synchronization metadata for the absent state.
- **Each Pimote keeps a local root-connection view.** The A-A account stores the local `ROOT_CONNECTIONS` view. A connection is either present or absent; it has no online or pending state. A close from either side must propagate a tombstone so both local views remove the pair after synchronization. The two KV buckets are independent copies, not a shared writable store.
- **Folder scope belongs in the local directory key.** A `DIRECTORY` KV key has the shape `<folderShareId>.<sessionUUID>`. Its backing JetStream stream is `KV_DIRECTORY`; its subject is `$KV.DIRECTORY.<folderShareId>.<sessionUUID>`. Each peer account receives a filtered, read-only JetStream source of this local directory:
  - one root: `$KV.DIRECTORY.<folderShareId>.<sessionUUID>`
  - one folder: `$KV.DIRECTORY.<folderShareId>.>`
  - all roots: `$KV.DIRECTORY.>`

  This bucket lives in the instance's A-A local account; A-A remains the write authority. The A-B peer account receives a read-only source filtered to the selected roots or folder. The folder token must be NATS-safe. Whether it is a stable local ID or a derived token remains open. It is not a global folder identity. A session moving folders, becoming unshared, or being archived produces an old-key tombstone and any new value. The peer removes its copied record after synchronization; NATS cannot erase information the peer already read or copied elsewhere.

- **Root messages stay literal.** Incoming cross-root text does not invoke Pi slash commands, skills, prompt templates, or input handlers. The recipient can still read a named skill from the message context.
- **NATS transport state is not agent presence.** A leaf link or account record does not claim that a Pi process is online. A logical root connection can remain configured while the peer's server is unreachable.

## NATS layers

| Layer                 | Scope                               | Responsibility                                                                                                                                     |
| --------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Leaf link             | One trusted Pimote pair             | Carries subject interest and traffic in both directions. Its account binding and credentials define which peer namespace and subjects can cross.   |
| Local account         | One Pimote instance                 | A-A holds local root-directory state and intra-node root messaging. Pimote provisions it automatically.                                            |
| Pair account          | One trusted Pimote pair             | Carries only A–B peer subjects. A–C uses another account. It is not a root session and does not provide the root connection graph.                 |
| Root directory        | One node's registered root sessions | Stores local root metadata. Selected records are copied to peers by folder/root filter.                                                            |
| Root connection       | One unique connection ID            | A single-use edge between two root identities. Its presence in each local `ROOT_CONNECTIONS` KV authorizes root messaging.                         |
| Peer outbox stream    | One peer pair and sender direction  | Carries ordered connection control events and root messages for that sender. The peer stores a local copy.                                         |
| JetStream stream      | One account and JetStream domain    | Owns a durable message or directory log. A stream has one leader in its home cluster/domain. A mirror is read-only; a source is a separate stream. |
| Peer ingress consumer | One inbound peer stream             | Applies connection-control events and routes root messages in stream order. A separate source consumer handles stream replication.                 |

A NATS cluster replicates a stream only among servers in that cluster. A gateway super-cluster routes subjects between clusters but does not replicate stream state or provide a per-peer isolation boundary. Leaf links and gateways are transport topologies; JetStream sources/mirrors are separate, asynchronous data-copy mechanisms.

## my-pi messaging integration

The shared my-pi `send`/`respond` tool surface is retained. It uses the existing local provider for parent/subagent routes and a peer-account NATS provider for root-to-root routes. Child contexts keep local parent-tree communication; direct cross-tree NATS messaging is not in this version.

**CLI is the preferred target.** A root Pi session should use the same tools from CLI after peer trust is provisioned, without a Pimote browser client. This requires the my-pi extension to access the local NATS server and the applicable A-B pair account through its per-peer credential. Pimote stops its local NATS server with Pimote, so peer messaging is unavailable while that server is stopped. The user is willing to revisit CLI support if credential handling or lifecycle makes it impractical.

## Candidate message envelope and subjects

Exact subject syntax is not locked. The current example uses one account per peer pair and a subject scoped to the target and source root sessions:

```text
pimote.v1.connection.<connectionId>.inbox.<targetSessionUUID>.<sourceSessionUUID>
pimote.v1.connection.<connectionId>.control
```

The message envelope carries the stable identity that the subject alone does not provide:

```ts
interface RootMessage {
  protocolVersion: 1;
  messageId: string;
  connectionId: string;
  kind: 'request' | 'response';
  from: { nodeId: string; sessionId: string };
  to: { nodeId: string; sessionId: string };
  correlationId?: string;
  createdAt: string;
  text: string;
}

interface RootConnectionEvent {
  eventId: string;
  operation: 'create' | 'remove';
  connectionId: string;
  endpoints: [{ nodeId: string; sessionId: string }, { nodeId: string; sessionId: string }];
}
```

A response is a new message to the source root's inbox. It includes the request's `correlationId` and the same `connectionId`. A message arriving after that ID was deleted is presented to the LLM with a local `STALE: connection closed` annotation. `respond` rejects the old ID; the root must create a new connection and send a new message. Root-session UUIDs identify conversations; session names and folder labels are mutable metadata.

## Symmetric offline queue requirement

Both nodes need a local place to queue messages while the peer link is unavailable. Each sender owns one ordered stream per peer direction:

```text
A_TO_B on A  -- JetStream source/mirror -->  B_FROM_A on B
B_TO_A on B  -- JetStream source/mirror -->  A_FROM_B on A
```

Connection create/remove events and root messages share that sender's stream. The destination uses one durable peer consumer to process them in stream order: control events update its A-A `ROOT_CONNECTIONS` KV; message envelopes route to the target Pi session. If the target's local KV lacks the message's `connectionId`, the consumer still delivers it with the stale marker. Each sender-owned stream lives in that sender's JetStream domain under the A–B pair account. The my-pi peer provider publishes through its A-B account client after checking the root connection. Credential delivery to that provider remains open. The source consumer uses flow-controlled acknowledgement so the sender's WorkQueue item remains until the destination stream stores its copy. The peer consumer acknowledges a control event after updating local KV and a message after transcript admission. This gives three distinct facts:

1. The sender's JetStream accepted the message locally.
2. The destination's JetStream stored a copy.
3. The destination root's bridge recorded the envelope in its transcript.

None means the model processed the message. The NATS 2.14+ flow-controlled durable source consumer supports WorkQueue and Interest origins. Stream size/age limits can still expire messages and require explicit policy.

This is the current preferred shape because it lets either side queue outbound messages while the peer link is down. Direct publication to the recipient's remote JetStream domain is a simpler online-only alternative; it cannot accept a publish while that remote domain is unreachable. The application must preserve control-event capacity when it applies the outbox size limit.

## Open design decisions

1. **Leaf-user credential lifecycle:** Define how the two Pimote instances exchange each NKey leaf user's private seed, how the local runtime stores it, and how the UI rotates or revokes the user on both servers.
2. **Static pair-account configuration:** Define the exact local A-B account labels and leaf authorization entries on each server. The static account name is a local config label; the leaf's local account binding and remote user credential establish the peer path.
3. **Directory tombstone transport:** Define how root and folder tombstones reach the peer when a source filter changes. Removing a folder from the filter alone leaves earlier copies behind; the peer must apply explicit tombstones to its local directory view.
4. **Connection event convergence:** Each A-A account stores local `ROOT_CONNECTIONS` entries keyed by unique `connectionId`. A peer outbox carries control events and root messages in per-sender order. A local close removes its key immediately and adds a close event to the same sender stream after that sender's earlier messages. The peer ingress consumer applies events in stream order and removes its copy. Messages already queued in the opposite direction can arrive afterward; the receiver delivers them with a stale marker and rejects replies using the closed ID. A connection ID is never reused, so a later connection between the same roots gets a new ID.
5. **Peer stream details:** Finalize control/message subject patterns, stream names, connection-event payloads, source-consumer settings, peer-ingress acknowledgement timing, and per-target message filters.
6. **Outbox capacity and cleanup:** Choose `MaxBytes`/`MaxMsgs` values and the data high-water mark that reserves control-event capacity. `MaxAge` is not used; accepted messages remain until acknowledged or explicitly cleaned up. Define the local retry path if the hard limit blocks a control event, plus deduplication, reply expiry, and archive cleanup.
7. **Connection availability:** A leaf link needs one reachable listener and one dialer. NATS leaf links do not punch through two-sided NAT. Choose how to support peers where neither side accepts inbound connections.
8. **Super-cluster alternative:** Gateways can route interest through a cluster mesh, but do not provide peer-pair isolation. If considered, account sharing and gateway reach must preserve the A–B versus A–C boundary.

## NATS references

- [Leaf nodes and account binding](https://docs.nats.io/learn/topologies/leaf-nodes)
- [Leaf remote account and credentials](https://docs.nats.io/reference/config/leafnodes/remotes)
- [Accounts and multitenancy](https://docs.nats.io/learn/security/accounts-and-multitenancy)
- [Cross-account exports and imports](https://docs.nats.io/learn/security/cross-account)
- [KV stream subjects and revisions](https://docs.nats.io/learn/key-value/under-the-hood)
- [JetStream source and mirror semantics](https://docs.nats.io/nats-concepts/jetstream/source_and_mirror)
- [Cross-account JetStream subjects and flow-control acknowledgements](https://docs.nats.io/reference/jetstream/cross-account-subjects)
- [JetStream replication inside a cluster](https://docs.nats.io/learn/topologies/jetstream-in-a-cluster)
