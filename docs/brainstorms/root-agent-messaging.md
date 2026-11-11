# Brainstorm: Root Agent Messaging in Pimote

## The idea

Pimote root sessions should discover, connect, and message other root sessions across trusted Pimote nodes. Pimote owns this feature, including its tools, NATS transport, root directory, and lifecycle integration. My-pi does not provide root messaging tools or a root-session transport provider.

Root messaging is distinct from my-pi's parent-local subagent communication. The two features have separate tool sets, providers, lifecycles, and implementation boundaries.

## Key decisions

### Pimote owns root communication

Implement root messaging in Pimote. Pimote owns the local broker process, peer setup, root registration, archive integration, root connection state, and client protocol. Pimote exposes a root-specific tool set. It does not reuse my-pi's subagent `send` and `respond` tools.

Pimote owns root registration and archive checks because it owns the authoritative session archive state. My-pi's session lifecycle has no archive state or archive reason. The exact behavior for an externally opened archived session remains deferred; DR-068 remains the current rule until a separate decision changes it.

### Local NATS and trusted peers

Each Pimote node runs one local NATS server with JetStream. Pimote starts and stops it with the application. It is one durable local replica, not a highly available cluster. Every Pimote client writes to its local NATS server. Clients do not publish directly to a peer's server.

Each node has a local account for its root directory and local state. Each trusted peer pair has a separate account namespace. One full-duplex leaf link carries traffic for that pair. Peer setup uses invitations, restricted NKey users, and verified TLS. No NKey seed is exposed to an agent.

Each sender owns one ordered outbox stream per peer direction. The peer receives a local copy. Connection-control events and messages share the ordered stream. NATS 2.14 or later is required for durable, flow-controlled sourcing from WorkQueue streams.

### Root identity, directory, and connections

The Pi session UUID identifies a root conversation. The node identity qualifies it across Pimote installations. Session names and folder names are mutable discovery metadata, not identity. A fork or new conversation receives a new session UUID.

Each side independently shares selected roots, selected folders, or all roots with a trusted peer. Discovery does not claim that a root process is currently listening. Ordinary session close does not remove its root registration or connections. Archive removes the root registration, connections, queued messages, and pending requests. Unarchive does not restore them.

A root connection joins two exact root identities. It is bidirectional and takes effect after the connection handshake. It does not require human or agent acceptance from the target. A root agent can connect or disconnect only a connection involving its own root. A user can manage connections between any two roots. Connecting does not create a session.

Connect is idempotent. A repeated request returns the existing pending or active connection. If both sides create candidates before either acknowledges the other's request, each selects the lexicographically smaller connection ID. A peer acknowledgement makes that choice active. A request remains pending while the peer link is unavailable. A close and a later open from one side use that side's ordered control stream, so the peer processes the close first. Sending while a connection is pending fails.

### Root messages and delivery

Root messages use a root-specific Pimote tool set. Exact tool names and schemas remain open. A root send is asynchronous. It returns after the sender's local JetStream outbox acknowledges storage. That receipt does not mean the peer stored, delivered, or processed the message.

An incoming message starts a turn when the target root is idle. If it is working, Pimote uses Pi's steer behavior. A closed but registered root has a durable local inbox. Peer ingress copies the message into that inbox before it acknowledges the peer stream. The root drains its inbox when its runtime opens.

Delivery is at least once. Message IDs stay in NATS transport state, not in the regular Pi user message. A crash after transcript persistence but before inbox acknowledgement can append a duplicate user message. The system does not claim exactly-once transcript admission or model processing. NATS duplicate suppression applies only within its configured finite window.

Replies are asynchronous and use the correlation ID supplied with the incoming message. A reply is a new root message. It does not depend on the model's latest target list.

### Root address and user flow

Users need a copyable root address and a connect flow that accepts it. Agent-facing tools need root discovery and connect/disconnect operations before a connection exists. Do not expose NATS subjects as durable root addresses. Names and argument shapes remain open.

A root message that arrives after its connection closes is delivered with a stale-connection annotation. The old correlation cannot be used for a reply; the roots must establish a new connection and send a new message.

## Why this direction

Pimote owns root `ManagedSlot`s, session metadata, archive state, and the client protocol. Placing root registration and archive handling in my-pi would force it to mirror Pimote lifecycle state. Pimote can serialize broker changes with its own archive and open operations.

The separation also reduces coupling with interactive subagent views. My-pi owns child runtimes and local child routing. Pimote owns root-to-root transport and root chat. Neither feature borrows the other's tool surface.

NATS gives Pimote durable local queues and a path to cross-machine peer transport. Local-only writes keep each node's state authoritative in its own broker. Sender-owned streams keep both directions available while a peer link is offline.

## Open questions for architecture

### Sharp questions

- Does the first version support only Pimote-hosted roots, or can a standalone Pi CLI session use Pimote-owned tools and transport?
- Which Pimote modules own the local NATS process, root directory, connection handshake, peer ingress, and root inbox?
- What are the root-specific tool names, argument shapes, output receipts, and permissions?
- What stable, copyable address format combines node identity and Pi session UUID?
- Which root metadata can each side share, and how do root and folder share scopes map to NATS keys and filters?
- How does the local root authority route registration requests while preserving the current archive rule? Automatic unarchive from CLI remains deferred.
- How do the peer invitation, NKey rotation and revocation, static account rules, and reachable TLS endpoint work?
- What JetStream retention, capacity, retry, reply-expiry, and dead-letter rules bound outboxes and local inboxes?
- Which WebSocket and client changes are required, and does Android participate in the first version?
- What limits stop two CLI/Pimote processes from opening the same Pi session file and competing for its inbox?

### Fog

- The exact connection, directory, and message presentation on the Pimote dashboard and root transcript needs visual design in architecture mockups.
