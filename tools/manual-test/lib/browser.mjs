// Shared agent-browser driving helpers for manual-test tools (the PWA
// mandatory-reuse driver). Wraps the `agent-browser` CLI with retries,
// Svelte-safe input filling, virtualized-folder-list helpers, and a page-side
// WebSocket instrumentation probe (request counting + socket capture) used to
// assert fetch call discipline and force reconnects.
//
// Usage:
//   const b = makeBrowserHelpers({ session: 'my-smoke-123', log });
//   await b.browser(['open', url]);          // raw CLI passthrough
//   await b.evalBrowser('document.title');
//   await b.fillSelector('input[aria-label="Search folders"]', 'query');
//   await b.revealFolder('/some/canonical/path');
//   await b.installSocketProbe();            // then resetSent()/sentLog()
//
// Note on the socket probe: it wraps WebSocket.prototype.send AFTER page
// load, so requests the app sent before installation are invisible. Count
// only request deltas taken after installSocketProbe()+resetSent().

import { spawn } from 'node:child_process';
import { once } from 'node:events';

export function makeBrowserHelpers({ session, log = () => {} }) {
  const BROWSER_SESSION = session;

  async function browser(args, { allowFailure = false, timeoutMs = 30_000, retries = 2 } = {}) {
    const fullArgs = ['--session', BROWSER_SESSION, ...args];
    log('agent-browser', args.join(' '));
    for (let attempt = 0; attempt <= retries; attempt++) {
      const child = spawn('agent-browser', fullArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      await once(child, 'exit');
      clearTimeout(timer);
      const transient = /Resource temporarily unavailable|daemon may be busy|Execution context was destroyed|Cannot find context|navigation/i.test(stdout + stderr);
      if ((child.exitCode === 0 && !timedOut) || allowFailure || (!transient && !timedOut) || attempt === retries) {
        if ((child.exitCode !== 0 || timedOut) && !allowFailure) {
          log('agent-browser failed:', args.join(' '), '\n' + stderr);
          throw new Error(`agent-browser failed: ${args.join(' ')}`);
        }
        return { stdout, stderr, code: child.exitCode };
      }
      await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
    }
    throw new Error('unreachable');
  }

  function parseEval(stdout) {
    const raw = stdout.trim();
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return raw.replace(/^"|"$/g, '');
    }
  }

  async function evalBrowser(expression) {
    return parseEval((await browser(['eval', expression])).stdout);
  }

  /** Set a Svelte-bound input's value and fire the input event. */
  async function fillSelector(selector, value) {
    const expr = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`;
    return (await evalBrowser(expr)) === true;
  }

  /**
   * Type into a Svelte-bound input as a rapid burst of intermediate values
   * (each firing `input`), scheduled inside one animation-frame-free page
   * timeline so the app's debounce sees real sub-250ms cadence.
   */
  async function typeBurst(selector, steps, delayMs = 40) {
    const expr = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const steps = ${JSON.stringify(steps)};
      steps.forEach((value, i) => setTimeout(() => {
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }, i * ${delayMs}));
      return true;
    })()`;
    return (await evalBrowser(expr)) === true;
  }

  async function wait(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ------------------------------------------------------ folder-list helpers

  /**
   * Scroll the dashboard until a virtualized row enters the rendered range.
   * Rows land asynchronously and the list re-sorts live (loaded session lists
   * move rows), so a row can sit above the sweep frontier when its data lands
   * or its recency resolves. Scan downward, then upward, then downward again
   * before giving up.
   */
  async function revealFolder(path) {
    const step = (dir) => `(() => {
      const target = Array.from(document.querySelectorAll('[data-folder-path]')).find(row => row.getAttribute('data-folder-path') === ${JSON.stringify(path)});
      if (target) { target.scrollIntoView({ block: 'center' }); return true; }
      const scroller = document.querySelector('[data-folder-path]')?.closest('.overflow-y-auto');
      if (scroller) scroller.scrollTop += ${dir} * Math.max(100, scroller.clientHeight * 0.6);
      return false;
    })()`;
    for (const dir of [1, -1, 1]) {
      await evalBrowser(`(() => {
        const row = document.querySelector('[data-folder-path]');
        const scroller = row?.closest('.overflow-y-auto');
        if (scroller) scroller.scrollTop = ${dir > 0 ? '0' : 'scroller.scrollHeight'};
      })()`);
      await wait(150);
      for (let attempt = 0; attempt < 40; attempt++) {
        const found = await evalBrowser(step(dir));
        await wait(150);
        if (found === true) return true;
      }
    }
    return false;
  }

  /** Text content of a folder row (icon label, name/subtitle, chips, badges). */
  async function rowText(path) {
    await revealFolder(path);
    return String(
      await evalBrowser(`(() => {
        const s = document.querySelector('[data-folder-path="' + ${JSON.stringify(path)} + '"]');
        return s?.closest('.group')?.textContent ?? '';
      })()`),
    );
  }

  /** Row icon variant: code | code-hub | persona | persona-hub. */
  async function rowIcon(path) {
    await revealFolder(path);
    return await evalBrowser(`(() => {
      const s = document.querySelector('[data-folder-path="' + ${JSON.stringify(path)} + '"]');
      return s?.closest('button')?.querySelector('svg[data-folder-icon]')?.getAttribute('data-folder-icon') ?? null;
    })()`);
  }

  /** Open the row context menu (long-press / right-click surface). */
  async function openRowMenu(path) {
    await revealFolder(path);
    const opened = await evalBrowser(`(() => {
      const s = document.querySelector('[data-folder-path="' + ${JSON.stringify(path)} + '"]');
      const trigger = s?.closest('.group');
      if (!trigger) return false;
      const rect = trigger.getBoundingClientRect();
      trigger.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 24, clientY: rect.top + 12 }));
      return true;
    })()`);
    await wait(400);
    return opened === true;
  }

  /** Click a context/dropdown menu item by its text. */
  async function clickMenuItem(text) {
    const clicked = await evalBrowser(`(() => {
      const item = Array.from(document.querySelectorAll('[role="menuitem"], [data-slot="context-menu-item"], [data-slot="dropdown-menu-item"]')).find((i) => i.textContent?.trim().includes(${JSON.stringify(text)}));
      if (!item) return false;
      item.click();
      return true;
    })()`);
    await wait(500);
    return clicked === true;
  }

  /** Click a dialog button whose trimmed text matches exactly. */
  async function clickDialogButton(text) {
    const clicked = await evalBrowser(`(() => {
      const btns = Array.from(document.querySelectorAll('[role="dialog"] button')).filter((b) => b.textContent?.trim() === ${JSON.stringify(text)});
      if (!btns.length) return false;
      btns.at(-1).click();
      return true;
    })()`);
    await wait(500);
    return clicked === true;
  }

  /** Is a virtualized folder row in the rendered range right now? */
  async function rowRenderedNow(path) {
    return (await evalBrowser(`Boolean(document.querySelector('[data-folder-path="' + ${JSON.stringify(path)} + '"]'))`)) === true;
  }

  /** Full row block text: row head (chips/badges) plus its session block. */
  async function rowBlockText(path) {
    return String(
      await evalBrowser(`(() => {
        const s = document.querySelector('[data-folder-path="' + ${JSON.stringify(path)} + '"]');
        return s?.closest('.group')?.parentElement?.textContent ?? '';
      })()`),
    );
  }

  /** Favorite star rendered on the row? */
  async function starOnRow(path) {
    return (await evalBrowser(`(() => {
      const s = document.querySelector('[data-folder-path="' + ${JSON.stringify(path)} + '"]');
      return Boolean(s?.closest('.group')?.querySelector('svg.fill-yellow-500'));
    })()`)) === true;
  }

  /** Reset the dashboard scroller to the top. */
  async function folderScrollTop() {
    return evalBrowser(`(() => {
      const row = document.querySelector('[data-folder-path]');
      const scroller = row?.closest('.overflow-y-auto');
      if (!scroller) return false;
      scroller.scrollTop = 0;
      return true;
    })()`);
  }

  /**
   * One virtualized-scroll step: report the currently rendered folder paths
   * (before scrolling) plus scroller geometry, then advance by `frac` of the
   * client height. Returns null when no scroller exists.
   */
  async function folderScrollStep(frac) {
    return await evalBrowser(`(() => {
      const row = document.querySelector('[data-folder-path]');
      const scroller = row?.closest('.overflow-y-auto');
      if (!scroller) return null;
      const paths = Array.from(document.querySelectorAll('[data-folder-path]')).map((r) => r.getAttribute('data-folder-path'));
      const before = scroller.scrollTop;
      scroller.scrollTop = before + scroller.clientHeight * ${frac};
      return { paths, top: scroller.scrollTop, height: scroller.scrollHeight, client: scroller.clientHeight };
    })()`);
  }

  // --------------------------------------------------- socket instrumentation

  /**
   * Wrap WebSocket.prototype.send to record every outbound protocol message
   * (window.__pmSent) and capture live socket instances (window.__pmSockets).
   * Install after page load; only count request deltas after resetSent().
   */
  async function installSocketProbe() {
    return (await evalBrowser(`(() => {
      if (window.__pmSocketProbe) return true;
      window.__pmSocketProbe = true;
      window.__pmSent = [];
      window.__pmSockets = [];
      const origSend = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        try {
          const parsed = JSON.parse(String(data));
          window.__pmSent.push(parsed);
        } catch {
          window.__pmSent.push({ type: '(unparsed)' });
        }
        if (!window.__pmSockets.includes(this)) window.__pmSockets.push(this);
        return origSend.call(this, data);
      };
      return true;
    })()`)) === true;
  }

  /** Outbound messages matching an optional JS filter expression. */
  async function sentLog(filterExpr = 'true') {
    return (await evalBrowser(`(window.__pmSent ?? []).filter((m) => (${filterExpr}))`)) ?? [];
  }

  /** Mark the current send-log length as the counting baseline (page-side,
   *  so later slices never race the growing log). */
  async function markSent() {
    return Number((await evalBrowser(`(() => { window.__pmSentMark = (window.__pmSent ?? []).length; return window.__pmSentMark; })()`)) ?? 0);
  }

  /** Outbound messages since the last markSent(), matching a JS filter. */
  async function sentSince(filterExpr = 'true') {
    return (await evalBrowser(`(window.__pmSent ?? []).slice(window.__pmSentMark ?? 0).filter((m) => (${filterExpr}))`)) ?? [];
  }

  /** Distinct folderPaths with any list_sessions send since page load. */
  async function loadedSessionPaths() {
    return (await evalBrowser(`[...new Set((window.__pmSent ?? []).filter((m) => m.type === 'list_sessions').map((m) => m.folderPath))]`)) ?? [];
  }

  /** Tail of the page console (diagnosis for failed assertions). */
  async function pageConsole(lines = 12) {
    const out = (await browser(['console'], { allowFailure: true })).stdout ?? '';
    return out.split('\n').filter(Boolean).slice(-lines).join(' | ');
  }

  async function resetSent() {
    return (await evalBrowser(`(() => { if (!window.__pmSent) return false; window.__pmSent.length = 0; return true; })()`)) === true;
  }

  /** Force a reconnect: close the most recent live socket from the page. */
  async function closeLatestSocket() {
    return (await evalBrowser(`(() => {
      const sockets = window.__pmSockets ?? [];
      const live = sockets.filter((s) => s.readyState === WebSocket.OPEN);
      const target = live.at(-1);
      if (!target) return false;
      window.__pmSocketsClosed = (window.__pmSocketsClosed ?? 0) + 1;
      target.close();
      return true;
    })()`)) === true;
  }

  /** Number of distinct sockets the probe has seen open (reconnect counting). */
  async function socketCount() {
    return Number((await evalBrowser(`(window.__pmSockets ?? []).length`)) ?? 0);
  }

  return {
    browser,
    parseEval,
    evalBrowser,
    fillSelector,
    typeBurst,
    wait,
    revealFolder,
    rowText,
    rowIcon,
    openRowMenu,
    clickMenuItem,
    clickDialogButton,
    rowRenderedNow,
    rowBlockText,
    starOnRow,
    folderScrollTop,
    folderScrollStep,
    installSocketProbe,
    sentLog,
    markSent,
    sentSince,
    loadedSessionPaths,
    pageConsole,
    resetSent,
    closeLatestSocket,
    socketCount,
  };
}
