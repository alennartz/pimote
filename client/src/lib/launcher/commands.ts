import { connection } from '../stores/connection.svelte.js';
import { branchTreeStore } from '../stores/branch-tree-store.svelte.js';
import { globalSettingsStore } from '../stores/global-settings.svelte.js';
import { loginStore } from '../stores/login-store.js';
import { panelStore } from '../stores/panel-store.svelte.js';
import { closeSession, newSessionInProject, sessionRegistry } from '../stores/session-registry.svelte.js';
import type { LauncherCommand } from './contracts.js';

function hasPanelsForViewedSession(): boolean {
  const viewedId = sessionRegistry.viewedSessionId;
  const hierarchy = viewedId ? sessionRegistry.subagentRoots[viewedId] : null;
  const pendingResurrection = viewedId ? sessionRegistry.getPendingSubagentResurrection(viewedId) : null;
  return panelStore.hasCards || (hierarchy?.nodes.length ?? 0) > 0 || pendingResurrection !== null;
}

export function getDefaultLauncherCommands(): LauncherCommand[] {
  return [
    {
      id: 'go-home',
      label: 'Go to Home',
      keywords: ['dashboard', 'folders', 'back'],
      group: 'navigation',
      isAvailable: () => sessionRegistry.viewedSessionId !== null,
      run: () => sessionRegistry.goHome(),
    },
    {
      id: 'new-session-current-folder',
      label: 'New Session in Current Folder',
      keywords: ['start', 'create', 'conversation', 'chat'],
      group: 'session',
      isAvailable: () => sessionRegistry.viewedSessionId !== null,
      run: () => {
        const id = sessionRegistry.viewedSessionId;
        if (id) void newSessionInProject(id);
      },
    },
    {
      id: 'open-branch-explorer',
      label: 'Open Branch Explorer',
      keywords: ['tree', 'branches', 'history', 'fork'],
      group: 'session',
      isAvailable: () => sessionRegistry.viewedSessionId !== null,
      run: () => {
        const id = sessionRegistry.viewedSessionId;
        if (id) void branchTreeStore.open(id);
      },
    },
    {
      id: 'toggle-panels',
      label: 'Toggle Panels',
      keywords: ['sidebar', 'drawer', 'subagents', 'cards'],
      group: 'session',
      isAvailable: () => hasPanelsForViewedSession(),
      run: () => {
        if (panelStore.isDrawer) panelStore.togglePanel();
        else panelStore.toggleCollapsed();
      },
    },
    {
      id: 'close-current-session',
      label: 'Close Current Session',
      keywords: ['detach', 'leave', 'exit'],
      group: 'session',
      isAvailable: () => sessionRegistry.viewedSessionId !== null,
      run: () => {
        const id = sessionRegistry.viewedSessionId;
        if (id) closeSession(id);
      },
    },
    {
      id: 'open-settings',
      label: 'Open Settings',
      keywords: ['preferences', 'config', 'theme', 'global'],
      group: 'app',
      isAvailable: () => connection.status === 'connected',
      run: () => void globalSettingsStore.loadManifest(),
    },
    {
      id: 'open-provider-login',
      label: 'Open Provider Login',
      keywords: ['auth', 'oauth', 'account', 'api key'],
      group: 'app',
      isAvailable: () => connection.status === 'connected',
      run: () => void loginStore.open(),
    },
  ];
}
