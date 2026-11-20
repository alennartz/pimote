#!/usr/bin/env node
// End-to-end smoke for the client-themes topic.
//
// Boots a real pimote server in an isolated HOME, opens two Chromium browser
// connections as one Pimote user, and drives the approved Appearance flow:
// desktop and mobile previews, Save/Cancel/Close, Follow server default, and
// same-user propagation. It also serves two static reports to verify the
// optional theme bridge and verbatim bundle serving.
//
// Optional environment variables:
//   CT_SHOTS=/tmp/dir  keep coherence screenshots outside the disposable sandbox
//   CT_KEEP=1          preserve the sandbox on a passing run

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve as pathResolve } from 'node:path';

import { makeReporter } from '../lib/report.mjs';
import { freePort, gitInit, seedSession, startPimote, stopPimote, waitForListening } from '../lib/sandbox.mjs';
import { WsProbe } from '../lib/ws-probe.mjs';
import { makeBrowserHelpers } from '../lib/browser.mjs';

const { assert, section, log, stats } = makeReporter('client-themes');

const USER = 'theme-user';
const PROJECT_NAME = 'theme-project';
const FALLBACK_BG = '#112233';
const FALLBACK_META = '#445566';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fact, timeoutMs = 10_000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await fact();
      if (value) return value;
    } catch {
      // The page can be between Svelte updates. Retry until the deadline.
    }
    await sleep(intervalMs);
  }
  return null;
}

function firstRefFor(snapshot, pattern) {
  const line = snapshot.split('\n').find((row) => pattern.test(row));
  const ref = line?.match(/\[ref=(e\d+)\]/i)?.[1];
  return ref ? `@${ref}` : null;
}

async function setViewport(browser, width, height) {
  await browser.browser(['set', 'viewport', String(width), String(height)]);
  await browser.wait(300);
}

async function prepareBrowser(browser, baseUrl) {
  await browser.browser(['open', baseUrl]);
  await browser.wait(1_500);
  await browser.evalBrowser(`(() => {
    localStorage.setItem('pimote:user', ${JSON.stringify(USER)});
    localStorage.removeItem(${JSON.stringify(`pimote:theme:${encodeURIComponent(USER)}`)});
    localStorage.removeItem('pimote:activeSessions');
    return true;
  })()`);
  await browser.browser(['reload']);
  await browser.wait(3_000);
  const ready = await waitFor(() => browser.evalBrowser(`Boolean(document.querySelector('[aria-label="Open Settings"]'))`), 12_000);
  if (!ready) throw new Error('PWA dashboard did not become ready');
}

async function openAppearance(browser) {
  const snapshot = (await browser.browser(['snapshot', '-i'])).stdout ?? '';
  const ref = firstRefFor(snapshot, /Open Settings/);
  if (ref) await browser.browser(['click', ref]);
  else await browser.evalBrowser(`(() => { const button = document.querySelector('button[aria-label="Open Settings"]'); button?.click(); return Boolean(button); })()`);

  const dialogReady = await waitFor(() => browser.evalBrowser(`Boolean(document.querySelector('[role="dialog"]'))`), 12_000);
  if (!dialogReady) throw new Error('Settings dialog did not open');
  const tabReady = await waitFor(
    () =>
      browser.evalBrowser(`(() => {
        const tab = Array.from(document.querySelectorAll('[role="tab"]')).find((entry) => (entry.textContent ?? '').trim() === 'Appearance');
        if (!tab) return false;
        tab.click();
        return true;
      })()`),
    5_000,
  );
  if (!tabReady) throw new Error('Appearance tab did not render');
  const themesReady = await waitFor(() => browser.evalBrowser(`document.querySelectorAll('[role="option"]').length >= 9`), 12_000);
  if (!themesReady) throw new Error('Theme catalog did not render');
  await browser.wait(400);
}

async function clickTheme(browser, label) {
  const clicked = await browser.evalBrowser(`(() => {
    const option = document.querySelector('[role="option"][aria-label=' + ${JSON.stringify(JSON.stringify(label))} + ']');
    option?.click();
    return Boolean(option);
  })()`);
  if (!clicked) throw new Error(`Theme option not found: ${label}`);
  await browser.wait(500);
}

async function clickButtonByText(browser, text) {
  const clicked = await browser.evalBrowser(`(() => {
    const buttons = Array.from(document.querySelectorAll('button')).filter((button) => (button.textContent ?? '').trim() === ${JSON.stringify(text)});
    const button = buttons.at(-1);
    button?.click();
    return Boolean(button);
  })()`);
  if (!clicked) throw new Error(`Button not found: ${text}`);
  await browser.wait(800);
}

async function appearanceState(browser) {
  return browser.evalBrowser(`(() => {
    const selected = Array.from(document.querySelectorAll('[role="option"][aria-selected="true"]')).map((entry) => entry.getAttribute('aria-label'));
    const status = document.querySelector('[role="status"]')?.textContent?.trim() ?? '';
    const save = Array.from(document.querySelectorAll('button')).find((button) => (button.textContent ?? '').trim() === 'Save theme');
    const selectedCard = document.querySelector('[role="option"][aria-selected="true"] .theme-preview');
    return {
      selected,
      status,
      saveDisabled: save?.hasAttribute('disabled') ?? false,
      bg: getComputedStyle(document.documentElement).getPropertyValue('--pimote-ui-background').trim(),
      editorBg: selectedCard?.style.getPropertyValue('--preview-bg').trim() ?? '',
      editorKeyword: selectedCard?.style.getPropertyValue('--preview-keyword').trim() ?? '',
      dark: document.documentElement.classList.contains('dark'),
      colorScheme: document.documentElement.style.getPropertyValue('color-scheme').trim(),
      dialog: Boolean(document.querySelector('[role="dialog"]')),
      width: window.innerWidth,
    };
  })()`);
}

async function rootState(browser) {
  return browser.evalBrowser(`(() => ({
    bg: getComputedStyle(document.documentElement).getPropertyValue('--pimote-ui-background').trim(),
    dark: document.documentElement.classList.contains('dark'),
    colorScheme: document.documentElement.style.getPropertyValue('color-scheme').trim(),
    meta: document.querySelector('meta[name="theme-color"]')?.getAttribute('content') ?? null,
  }))()`);
}

async function writeReportBundle(root, helper = true) {
  const script = helper ? '<script type="module" src="/pwa/theme-bridge.js"></script>' : '';
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="theme-color" content="${FALLBACK_META}">
    <title>Theme bridge report</title>
    <style>
      :root { --pimote-ui-background: ${FALLBACK_BG}; color-scheme: light; }
      body { margin: 0; background: var(--pimote-ui-background); }
    </style>
  </head>
  <body><main id="report">Report fallback</main>${script}</body>
</html>
`;
  const extra = 'window.reportBundleMarker = "verbatim-theme-report";\n';
  await writeFile(join(root, 'index.html'), html);
  await writeFile(join(root, 'report.js'), extra);
  return { index: Buffer.from(html), script: Buffer.from(extra) };
}

async function main() {
  console.log('[client-themes] Appearance and report bridge smoke');
  const sandboxHome = await mkdtemp(join(tmpdir(), 'client-themes-smoke-'));
  const configDir = join(sandboxHome, '.config', 'pimote');
  const agentDir = join(sandboxHome, 'agent');
  const projectDir = join(sandboxHome, PROJECT_NAME);
  const reportDir = join(sandboxHome, 'theme-report');
  const fallbackReportDir = join(sandboxHome, 'fallback-report');
  const stateDir = join(sandboxHome, '.local', 'state', 'pimote');
  const staticHostDir = join(stateDir, 'static-host');
  await mkdir(configDir, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await mkdir(staticHostDir, { recursive: true });
  await gitInit(projectDir, 'main');
  const sessionsRoot = join(agentDir, 'sessions');
  const sessionId = await seedSession(sessionsRoot, projectDir, 'Theme smoke seed', 'Theme smoke response');
  await mkdir(reportDir, { recursive: true });
  await mkdir(fallbackReportDir, { recursive: true });
  const reportFiles = await writeReportBundle(reportDir, true);
  const fallbackFiles = await writeReportBundle(fallbackReportDir, false);
  const port = await freePort();
  const configPath = join(configDir, 'config.json');
  await writeFile(configPath, JSON.stringify({ roots: [projectDir], port, bufferSize: 100, updateCheck: false, defaultTheme: 'pimote/dracula' }, null, 2));
  await writeFile(
    join(staticHostDir, `${sessionId}.json`),
    JSON.stringify(
      {
        version: 1,
        entries: [
          { slug: 'theme-report', folderPath: reportDir, cardMetadata: { title: 'Theme report' } },
          { slug: 'fallback-report', folderPath: fallbackReportDir, cardMetadata: { title: 'Fallback report' } },
        ],
      },
      null,
      2,
    ),
  );

  const logPath = join(sandboxHome, 'pimote.log');
  const shotsDir = process.env.CT_SHOTS ? pathResolve(process.env.CT_SHOTS) : sandboxHome;
  await mkdir(shotsDir, { recursive: true });
  log('sandbox HOME =', sandboxHome);
  log('project      =', projectDir);
  log('port         =', port);

  const baseUrl = `http://127.0.0.1:${port}`;
  const token = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const browserA = makeBrowserHelpers({ session: `ct-a-${token}`, log });
  const browserB = makeBrowserHelpers({ session: `ct-b-${token}`, log });
  const browserReport = makeBrowserHelpers({ session: `ct-report-${token}`, log });
  const probe = new WsProbe(port, `ct-probe-${token}`, USER);
  let child;
  try {
    child = startPimote({ port, sandboxHome, agentDir, configPath, logPath });
    await waitForListening(child, port, logPath);
    await probe.open();

    section('W — catalog and isolated session bootstrap');
    const catalogResponse = await probe.send({ type: 'get_theme_catalog' });
    assert(catalogResponse.success === true, 'PWA theme catalog request succeeds');
    const catalog = catalogResponse.data;
    const themes = catalog?.themes ?? [];
    const defaultTheme = themes.find((theme) => theme.id === catalog?.defaultThemeId);
    const lightTheme = themes.find((theme) => theme.id === 'pimote/light');
    const darkTheme = themes.find((theme) => theme.id === 'pimote/dark');
    assert(themes.length >= 8, 'catalog exposes all built-in paired themes');
    assert(defaultTheme?.id === 'pimote/dracula', 'isolated server default is Dracula');
    assert(lightTheme && darkTheme, 'catalog contains light and dark fixtures for preview assertions');
    const opened = await probe.send({ type: 'open_session', sessionId, folderPath: projectDir });
    assert(opened.success === true, 'isolated session opens for the test user');

    section('B — browser bootstrap and desktop Appearance flow');
    await setViewport(browserA, 1280, 900);
    await prepareBrowser(browserA, baseUrl);
    await browserA.installSocketProbe();
    const connected = await waitFor(() => browserA.evalBrowser(`Boolean(document.querySelector('[aria-label="Open Settings"]'))`), 8_000);
    assert(connected === true, 'desktop browser connects and renders the dashboard');
    await openAppearance(browserA);
    let state = await appearanceState(browserA);
    assert(state.width >= 768, 'desktop viewport uses the desktop settings shell');
    assert(state.selected.includes('Follow server default'), 'Follow server default is selected for a new profile');
    assert(state.bg.toLowerCase() === defaultTheme.ui.background.toLowerCase(), 'saved default palette is active before preview');
    await browserA.browser(['screenshot', join(shotsDir, 'desktop-initial.png')]);

    await clickTheme(browserA, 'Pimote Light');
    state = await appearanceState(browserA);
    assert(state.selected.includes('Pimote Light'), 'desktop theme selection marks the chosen card');
    assert(state.status.includes('Previewing Pimote Light'), 'desktop selection reports an unsaved local preview');
    assert(state.bg.toLowerCase() === lightTheme.ui.background.toLowerCase(), 'local preview applies the UI palette immediately');
    assert(state.editorBg.toLowerCase() === lightTheme.editor.surface.background.toLowerCase(), 'theme card previews the paired editor surface');
    assert(state.editorKeyword.toLowerCase() === lightTheme.editor.syntax.keyword.toLowerCase(), 'theme card previews the paired syntax palette');
    assert(state.saveDisabled === false, 'desktop Save enables after profile reconciliation and adoption');
    await browserA.browser(['screenshot', join(shotsDir, 'desktop-preview.png')]);

    await clickButtonByText(browserA, 'Cancel');
    const desktopCancelled = await browserA.evalBrowser(`!document.querySelector('[role="dialog"]')`);
    assert(desktopCancelled === true, 'desktop Cancel closes the settings dialog');
    const afterDesktopCancel = await rootState(browserA);
    assert(afterDesktopCancel.bg.toLowerCase() === defaultTheme.ui.background.toLowerCase(), 'desktop Cancel restores the saved palette');

    await openAppearance(browserA);
    await clickTheme(browserA, 'Pimote Light');
    await browserA.resetSent();
    await clickButtonByText(browserA, 'Save theme');
    state = await appearanceState(browserA);
    const saveMessages = await browserA.sentSince(`m.type === 'set_theme'`);
    assert(
      saveMessages.some((message) => message.themeId === 'pimote/light'),
      'desktop Save sends the selected theme ID',
    );
    assert(state.status.includes('Showing the saved theme'), 'desktop Save leaves the saved status');
    assert(state.selected.includes('Pimote Light'), 'desktop Save keeps the saved card selected');
    assert(state.saveDisabled === true, 'desktop Save disables after the save settles');
    assert(state.bg.toLowerCase() === lightTheme.ui.background.toLowerCase(), 'desktop Save keeps the previewed palette active');
    await browserA.browser(['screenshot', join(shotsDir, 'desktop-saved.png')]);

    section('C — same-user propagation and mobile Close/Save');
    await setViewport(browserB, 390, 840);
    await prepareBrowser(browserB, baseUrl);
    await browserB.installSocketProbe();
    await openAppearance(browserB);
    state = await appearanceState(browserB);
    assert(state.width < 768, 'mobile viewport uses the mobile settings shell');
    assert(state.selected.includes('Pimote Light'), 'same-user connection adopts the saved desktop selection');
    assert(state.bg.toLowerCase() === lightTheme.ui.background.toLowerCase(), 'same-user connection applies the saved palette');
    await browserB.browser(['screenshot', join(shotsDir, 'mobile-saved.png')]);

    await clickTheme(browserB, 'Pimote Dark');
    state = await appearanceState(browserB);
    assert(state.selected.includes('Pimote Dark'), 'mobile selection marks the chosen card');
    assert(state.status.includes('Previewing Pimote Dark'), 'mobile selection reports an unsaved preview');
    assert(state.bg.toLowerCase() === darkTheme.ui.background.toLowerCase(), 'mobile local preview applies a dark UI palette');
    const mobileClose = await browserB.evalBrowser(`(() => {
      const button = document.querySelector('button[aria-label="Close editor"]');
      button?.click();
      return Boolean(button);
    })()`);
    assert(mobileClose === true, 'mobile Close control is present');
    await browserB.wait(800);
    const closed = await browserB.evalBrowser(`!document.querySelector('[role="dialog"]')`);
    assert(closed === true, 'mobile Close closes the settings dialog');
    const afterClose = await rootState(browserB);
    assert(afterClose.bg.toLowerCase() === lightTheme.ui.background.toLowerCase(), 'mobile Close cancels the unsaved dark preview');

    await openAppearance(browserB);
    state = await appearanceState(browserB);
    assert(state.selected.includes('Pimote Light'), 'reopening mobile settings shows the saved selection after Close');
    await clickTheme(browserB, 'Follow server default');
    state = await appearanceState(browserB);
    assert(state.selected.includes('Follow server default'), 'mobile Follow server default selection is visible');
    assert(state.bg.toLowerCase() === defaultTheme.ui.background.toLowerCase(), 'Follow server default resolves the configured Dracula palette');
    await browserB.resetSent();
    await browserB.markSent();
    await clickButtonByText(browserB, 'Save theme');
    state = await appearanceState(browserB);
    const defaultSaveMessages = await browserB.sentSince(`m.type === 'set_theme'`);
    assert(
      defaultSaveMessages.some((message) => message.themeId === null),
      'mobile Save clears the override with a null theme ID',
    );
    assert(state.selected.includes('Follow server default'), 'mobile Save keeps Follow server default selected');
    assert(state.status.includes('Showing the saved theme'), 'mobile Save leaves a saved status');
    assert(state.bg.toLowerCase() === defaultTheme.ui.background.toLowerCase(), 'mobile Save keeps the server default palette active');
    await browserB.browser(['screenshot', join(shotsDir, 'mobile-default-saved.png')]);

    await browserA.wait(1_500);
    const aAfterPropagation = await appearanceState(browserA);
    assert(aAfterPropagation.selected.includes('Follow server default'), 'same-user desktop connection receives the mobile default selection');
    assert(aAfterPropagation.bg.toLowerCase() === defaultTheme.ui.background.toLowerCase(), 'same-user desktop connection applies the default palette');

    section('R — optional report bridge and verbatim static-host bytes');
    const helperAsset = await readFile(join(process.cwd(), 'client', 'build', 'pwa', 'theme-bridge.js'));
    const reportResponse = await fetch(`${baseUrl}/s/theme-report/`);
    const reportBody = Buffer.from(await reportResponse.arrayBuffer());
    assert(reportResponse.status === 200, 'static-host serves the helper report bundle');
    assert(reportBody.equals(reportFiles.index), 'static-host serves report index bytes verbatim');
    const reportScriptResponse = await fetch(`${baseUrl}/s/theme-report/report.js`);
    const reportScriptBody = Buffer.from(await reportScriptResponse.arrayBuffer());
    assert(reportScriptResponse.status === 200 && reportScriptBody.equals(reportFiles.script), 'static-host serves report assets verbatim');
    const helperResponse = await fetch(`${baseUrl}/pwa/theme-bridge.js`);
    const helperBody = Buffer.from(await helperResponse.arrayBuffer());
    assert(helperResponse.status === 200 && helperBody.equals(helperAsset), 'PWA exposes the optional report helper asset unchanged');

    const noHelperResponse = await fetch(`${baseUrl}/s/fallback-report/`);
    const noHelperBody = Buffer.from(await noHelperResponse.arrayBuffer());
    assert(noHelperResponse.status === 200 && noHelperBody.equals(fallbackFiles.index), 'a report without the helper remains a valid optional bundle');

    await setViewport(browserReport, 900, 700);
    await browserReport.browser(['open', `${baseUrl}/s/theme-report/`]);
    await browserReport.wait(1_500);
    const cacheKey = `pimote:theme:${encodeURIComponent(USER)}`;
    await browserReport.evalBrowser(`(() => {
      localStorage.setItem('pimote:user', ${JSON.stringify(USER)});
      localStorage.setItem(${JSON.stringify(cacheKey)}, ${JSON.stringify(JSON.stringify(defaultTheme))});
      return true;
    })()`);
    await browserReport.browser(['reload']);
    await browserReport.wait(1_200);
    let reportState = await rootState(browserReport);
    assert(reportState.bg.toLowerCase() === defaultTheme.ui.background.toLowerCase(), 'report helper applies the cached user theme');
    assert(reportState.dark === true, 'report helper applies the cached dark mode');
    assert(reportState.meta?.toLowerCase() === defaultTheme.ui.background.toLowerCase(), 'report helper updates report theme-color metadata');

    await browserReport.evalBrowser(`(() => {
      localStorage.setItem(${JSON.stringify(cacheKey)}, ${JSON.stringify(JSON.stringify(lightTheme))});
      window.dispatchEvent(new StorageEvent('storage', { key: ${JSON.stringify(cacheKey)}, newValue: ${JSON.stringify(JSON.stringify(lightTheme))} }));
      return true;
    })()`);
    await browserReport.wait(300);
    reportState = await rootState(browserReport);
    assert(reportState.bg.toLowerCase() === lightTheme.ui.background.toLowerCase(), 'report helper follows a cross-tab cached-theme update');
    assert(reportState.dark === false, 'report helper switches root mode on a cross-tab light-theme update');

    await browserReport.evalBrowser(`(() => {
      localStorage.removeItem('pimote:theme:no-cache');
      localStorage.setItem('pimote:user', 'no-cache');
      window.dispatchEvent(new StorageEvent('storage', { key: 'pimote:user', newValue: 'no-cache' }));
      return true;
    })()`);
    await browserReport.wait(300);
    reportState = await rootState(browserReport);
    assert(reportState.bg.toLowerCase() === FALLBACK_BG, 'report helper leaves fallback styles when the new user has no cache');
    assert(reportState.meta?.toLowerCase() === FALLBACK_META, 'report helper restores fallback metadata when cache is absent');

    await browserReport.evalBrowser(`(() => {
      const nextKey = 'pimote:theme:other';
      localStorage.setItem(nextKey, ${JSON.stringify(JSON.stringify(defaultTheme))});
      localStorage.setItem('pimote:user', 'other');
      window.dispatchEvent(new StorageEvent('storage', { key: 'pimote:user', newValue: 'other' }));
      return true;
    })()`);
    await browserReport.wait(300);
    reportState = await rootState(browserReport);
    assert(reportState.bg.toLowerCase() === defaultTheme.ui.background.toLowerCase(), 'report helper discovers and applies a changed user cache');

    await browserReport.browser(['open', `${baseUrl}/s/fallback-report/`]);
    await browserReport.wait(1_000);
    const fallbackPageState = await rootState(browserReport);
    assert(fallbackPageState.bg.toLowerCase() === FALLBACK_BG, 'report without the helper keeps its own fallback styles');

    console.log(`\n[client-themes] complete: ${stats.failures === 0 ? 'PASS' : `${stats.failures} FAIL`}`);
    if (stats.failures > 0) {
      log('server log:', logPath);
      log('sandbox preserved:', sandboxHome);
    }
  } catch (error) {
    console.error('[client-themes] uncaught error', error);
    log('server log:', logPath);
    log('sandbox preserved:', sandboxHome);
    stats.failures++;
  } finally {
    probe.close();
    if (child && child.exitCode === null) await stopPimote(child);
    await browserA.browser(['close'], { allowFailure: true });
    await browserB.browser(['close'], { allowFailure: true });
    await browserReport.browser(['close'], { allowFailure: true });
    if (!process.env.CT_KEEP && stats.failures === 0) await rm(sandboxHome, { recursive: true, force: true });
  }
  process.exit(stats.failures === 0 ? 0 : 1);
}

main();
