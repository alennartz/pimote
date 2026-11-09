# Design: NATS peer messaging across Pimote nodes

Status: draft

## Context

Each Pimote instance runs a local NATS server with JetStream. Pimote provisions a main local account for that instance's roots, directory, and intra-node conversations. When two instances trust each other, Pimote provisions a separate account namespace for that peer pair and links the NATS servers. This note records the current decisions and separates them from the local-to-peer bridge, delivery, and write-authority questions that remain open.

## Agreed direction

- **One local NATS server per Pimote instance.** JetStream stores local session and peer traffic. A single server is a single replica, not a highly available NATS cluster. File storage supports recovery after a server restart when its disk remains intact.
- **One leaf link per trusted Pimote pair.** The link is full duplex. One server dials the other server's leaf listener. The dial direction does not determine message direction. A second reciprocal link is not needed.
- **Two account scopes per node relationship.** Each instance has a Pimote-provisioned local account (`A-A`) for its own roots, directory, and local conversations. Each trusted pair has a separate peer account (`A-B`) for that pair's shared subjects and cross-server traffic. A–C use `A-C`; do not use one account for all peers or one account per root.
- **The peer account has a Pimote UI lifecycle.** The UI provisions the pair account and leaf credentials. The account identity, signing-key custody, user-permission shape, rotation, and revocation procedure remain open.
- **The Pi session UUID identifies a root conversation.** Session names and folder labels are mutable discovery metadata, not identities.
- **Root messages stay asynchronous across roots.** A recipient can answer with the incoming correlation ID. The sender is not told that the recipient received or processed the message.
- **Root discovery is shared per peer, per side.** Each side chooses which roots it exposes to that peer: selected roots, roots in selected folders, or all roots. Sharing metadata does not open a root-to-root communication connection. A separate root connection authorizes conversation traffic.
- **Folder scope belongs in the local directory key.** A `DIRECTORY` KV key has the shape `<folderShareId>.<sessionUUID>`. Its backing JetStream stream is `KV_DIRECTORY`; its subject is `$KV.DIRECTORY.<folderShareId>.<sessionUUID>`. A peer can receive a filtered, read-only view:
  - one root: `$KV.DIRECTORY.<folderShareId>.<sessionUUID>`
  - one folder: `$KV.DIRECTORY.<folderShareId>.>`
  - all roots: `$KV.DIRECTORY.>`

  This bucket lives in the instance's local account. The peer account receives only the allowed subject filter as a read-only view. The folder token must be NATS-safe. Whether it is a stable local ID or a derived token remains open. It is not a global folder identity. If a session changes folders or becomes unshared, the sender must propagate an old-key tombstone and any new value.

- **Root messages stay literal.** Incoming cross-root text does not invoke Pi slash commands, skills, prompt templates, or input handlers. The recipient can still read a named skill from the message context.
- **NATS transport state is not agent presence.** A leaf link or account record does not claim that a Pi process is online. A logical root connection can remain configured while the peer's server is unreachable.

## NATS layers

| Layer            | Scope                               | Responsibility                                                                                                                                     |
| ---------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Leaf link        | One trusted Pimote pair             | Carries subject interest and traffic in both directions. Its account binding and credentials define which peer namespace and subjects can cross.   |
| Local account    | One Pimote instance                 | Holds local root-directory state and intra-node root messaging. Pimote provisions it automatically.                                                |
| Pair account     | One trusted Pimote pair             | Carries only A–B peer subjects. A–C uses another account. It is not a root session and does not provide the root connection graph.                 |
| Root directory   | One node's registered root sessions | Stores local root metadata. Selected records are copied to peers by folder/root filter.                                                            |
| Root connection  | One exact pair of root identities   | Authorizes model-facing message tools between two roots. It is separate from the node-level leaf link and discovery policy.                        |
| JetStream stream | One account and JetStream domain    | Owns a durable message or directory log. A stream has one leader in its home cluster/domain. A mirror is read-only; a source is a separate stream. |
| Durable consumer | One stream and filter               | Tracks delivery and acknowledgements for a root or a stream-replication task.                                                                      |

A NATS cluster replicates a stream only among servers in that cluster. A gateway super-cluster routes subjects between clusters but does not replicate stream state or provide a per-peer isolation boundary. Leaf links and gateways are transport topologies; JetStream sources/mirrors are separate, asynchronous data-copy mechanisms.

## Candidate message envelope and subjects

Exact subject syntax is not locked. The current example uses one account per peer pair and a subject scoped to the target and source root sessions:

```text
pimote.v1.inbox.<targetSessionUUID>.<sourceSessionUUID>
```

The message envelope carries the stable identity that the subject alone does not provide:

```ts
interface RootMessage {
  protocolVersion: 1;
  messageId: string;
  kind: 'request' | 'response';
  from: { nodeId: string; sessionId: string };
  to: { nodeId: string; sessionId: string };
  correlationId?: string;
  createdAt: string;
  text: string;
}
```

A response is a new message to the source root's inbox. It includes the request's `correlationId`. Root-session UUIDs identify conversations; session names and folder labels are mutable metadata.

## Symmetric offline queue requirement

Both nodes need a local place to queue messages while the peer link is unavailable. The symmetric candidate is one sender-owned stream per peer direction:

```text
A_TO_B on A  -- JetStream source/mirror -->  B_FROM_A on B
B_TO_A on B  -- JetStream source/mirror -->  A_FROM_B on A
```

Each sender-owned stream lives in that sender's JetStream domain under the A–B pair account. The sender's local roots write to the pair account through a local account bridge that still needs design. Each destination root has a durable consumer with a non-overlapping subject filter. The source consumer uses flow-controlled acknowledgement so the sender's WorkQueue item remains until the destination stream stores its copy. The root consumer acknowledges only after the message envelope reaches the Pi transcript. This gives three distinct facts:

1. The sender's JetStream accepted the message locally.
2. The destination's JetStream stored a copy.
3. The destination root's bridge recorded the envelope in its transcript.

None means the model processed the message. The NATS 2.14+ flow-controlled durable source consumer supports WorkQueue and Interest origins. Stream size/age limits can still expire messages and require explicit policy.

This is the current preferred shape because it lets either side queue outbound messages while the peer link is down. Direct publication to the recipient's remote JetStream domain is a simpler online-only alternative; it cannot accept a publish while that remote domain is unreachable.

## Open design decisions

1. **Local-to-peer account bridge:** How do local roots in A-A publish authorized messages into A-B, and how do received A-B messages enter the recipient's local Pi session? Keep the bridge scoped to the active root connection.
2. **Pair-account credentials:** Which NATS auth mode does the UI manage? Where does the pair account signing authority live? How does each node receive restricted leaf-user credentials, rotate them, or revoke the peer?
3. **Directory transfer:** Can filtered sources of the local `DIRECTORY` KV bucket provide each peer account's read-only view, or is a separate peer share stream needed? Define remote tombstones, folder changes, unshare, and archive cleanup.
4. **Root connection write authority:** `ROOT_CONNECTIONS` would live in a local account and use a canonical root-pair key, but each Pimote has an independent JetStream domain. Two local KV buckets with the same subject are not one shared store, and mirror/source copies do not merge writes. Choose a single home for each edge, directed per-node grants, or another conflict rule. Define what a disconnect on one side means while the peer link is down.
5. **Message subject, stream, and consumer naming:** Finalize account-scoped subject patterns, local-versus-pair account stream placement, root consumer filters, and whether the replication consumer and root consumer share or split stream responsibilities.
6. **Send acknowledgement and retention:** Decide whether local outbox PubAck counts as accepted, and how to report remote storage separately. Set `MaxAge`, `MaxBytes`, overflow behavior, retries, duplicate handling, reply expiry, archive purge, and disconnected-root queue cleanup.
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
