# @pimote/panels

Push structured card data from [pi](https://github.com/mariozechner/pi-coding-agent) extensions to the [pimote](https://github.com/alennartz/pimote) web client.

When your extension is running inside pimote, `detect()` returns a handle for sending cards to the panel UI. When running in a normal pi terminal session, it returns `null` — your extension keeps working either way.

## Install

```bash
npm install @pimote/panels
```

Requires `@mariozechner/pi-coding-agent` as a peer dependency (already present in any pi extension).

## Usage

```ts
import { detect } from '@pimote/panels';
import type { ExtensionFactory } from '@mariozechner/pi-coding-agent';

const extension: ExtensionFactory = (pi) => {
  const panels = detect(pi, 'my-extension');

  if (panels) {
    // Running inside pimote — push cards to the web UI
    panels.updateCards([
      {
        id: 'status',
        color: 'success',
        header: { title: 'Build', tag: 'passed' },
        body: [{ content: 'All 42 tests passed', style: 'text' }],
        footer: ['2.3s'],
      },
    ]);
  }

  // Rest of your extension — works in both pimote and regular pi
};

export default extension;
```

## API

### `detect(pi, key)`

Detects whether the extension is running inside pimote.

- **`pi`** — The `ExtensionAPI` object passed to your extension factory.
- **`key`** — A unique namespace string for your extension's cards. Cards from different keys don't interfere with each other.

Returns a `PanelHandle` if running inside pimote, or `null` otherwise.

Calling `detect()` again with the same key deactivates the previous handle (its methods become no-ops) and returns a new one.

### `PanelHandle`

```ts
interface PanelHandle {
  /** Replace all cards for this namespace. Previous cards are discarded. */
  updateCards(cards: Card[]): void;
  /** Remove all cards for this namespace. */
  clear(): void;
}
```

### `Card`

```ts
interface Card {
  id: string;
  color?: 'accent' | 'success' | 'warning' | 'error' | 'muted';
  header: {
    title: string;
    tag?: string;
  };
  body?: BodySection[];
  footer?: string[];
}

interface BodySection {
  content: string;
  style: 'text' | 'code' | 'secondary';
}
```

- **`id`** — Unique identifier for the card within your namespace.
- **`color`** — Optional color theme for the card.
- **`header.title`** — Card title, always visible.
- **`header.tag`** — Optional short label displayed next to the title.
- **`body`** — Optional content sections, each with a style (`text`, `code`, or `secondary`).
- **`footer`** — Optional array of short strings displayed at the bottom.

## How it works

Detection uses pi's EventBus for a synchronous in-process round-trip — pimote's server listens for `pimote:detect:request` and responds on `pimote:detect:response`. Card updates are emitted on the `pimote:panels` channel, which pimote's session manager picks up and pushes to the web client over WebSocket.

When pimote isn't present, the EventBus emit fires with no listener, `detect()` returns `null`, and there's zero overhead.

## License

MIT
