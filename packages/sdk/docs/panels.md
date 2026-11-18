# Panels

The panels module pushes structured cards from a pi extension into the Pimote web client. A card is a small block of text in the session panel. Use cards for status, build results, or links to a hosted report. Do not use them for prose answers, and do not use them for dialogs: pi's own UI APIs cover dialogs.

## Detect Pimote

```ts
import { detect } from '@pimote/sdk/panels';

const panels = detect(pi, 'my-extension');
if (!panels) return; // running in a plain pi terminal
```

`detect(pi, key)` performs a synchronous EventBus round-trip and returns `PanelHandle` when Pimote answers, or `null` when nothing does. It works in any mode, so guard on `null` and keep the extension usable elsewhere.

`key` is a namespace for your cards. Two extensions with different keys never overwrite each other. Calling `detect()` again with the same key deactivates the previous handle, and its methods become no-ops.

Handles are scoped to one `ExtensionAPI`. Two sessions can detect the same key without affecting each other.

## Handle

```ts
interface PanelHandle {
  updateCards(cards: Card[]): void;
  clear(): void;
}
```

`updateCards` replaces the whole card set for the namespace. It is a snapshot, not a merge, so pass every card you still want.

`clear` removes the namespace.

Both methods are no-ops after the handle is deactivated.

## Card

```ts
interface Card {
  id: string;
  color?: 'accent' | 'active' | 'success' | 'warning' | 'error' | 'muted';
  header: { title: string; tag?: string };
  body?: { content: string; style: 'text' | 'code' | 'secondary' }[];
  footer?: string[];
  href?: string;
}
```

| Field          | Contract                                                                      |
| -------------- | ----------------------------------------------------------------------------- |
| `id`           | Unique within the namespace. Pimote renders it as `<namespace>:<id>`.         |
| `color`        | Semantic accent. The host chooses the exact color.                            |
| `header.title` | Card title. Always rendered.                                                  |
| `header.tag`   | Short label beside the title.                                                 |
| `body`         | Ordered sections. `text` is prose, `code` is monospace, `secondary` is muted. |
| `footer`       | Short strings along the bottom.                                               |
| `href`         | Link target. The session panel renders the whole card as a link.              |

Use `color` for state, not decoration:

| Color     | Use                               |
| --------- | --------------------------------- |
| `active`  | Work is in flight.                |
| `success` | Settled without an error.         |
| `warning` | Caution, or waiting on something. |
| `error`   | Failure.                          |
| `muted`   | Low-priority information.         |
| `accent`  | General emphasis.                 |

`href` opens in a new tab and the session panel is the list that honors it. Pimote does not validate the value, and a cross-origin URL works as a plain anchor. Use a same-origin path, such as `/s/<slug>/` for a bundle served by `pimote_static_host`.

## Repaint when the client asks

Cards live in server memory for the session, and a client claim or a session reset discards them. Pimote then emits `pimote:panels:sync` with `{reason: 'claim' | 'reset'}` on the session's EventBus. Emit your current cards again when you see it:

```ts
import { detect } from '@pimote/sdk/panels';

const panels = detect(pi, 'my-extension');
if (panels) {
  const paint = () => panels.updateCards(currentCards());
  pi.events.on('pimote:panels:sync', paint);
  paint();
}
```

Without that listener, a reconnected browser sees an empty namespace until the extension repaints.

## Validation

Pimote validates a card set before it stores it. One invalid card rejects the entire message: the previous cards stay, and no error reaches the extension. A missing `header.title`, a bad `color`, or a non-array `body` is enough to drop the update.

Check your payload against the `Card` shape above. Pimote does not log the rejection.

## Delivery

Cards from all namespaces merge into one panel list. Namespaces keep insertion order, and each namespace keeps its own card order. Pimote coalesces pushes, so a burst of `updateCards` calls can arrive as a single repaint. Do not emit per token.

Cards are not persisted. A session that restarts runs the extension factory again, so paint in the factory or in a `session_start` handler.
