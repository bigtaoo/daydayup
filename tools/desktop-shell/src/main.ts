import { app, BrowserWindow, BrowserView, ipcMain, Menu, MenuItemConstructorOptions } from 'electron';
import * as path from 'path';
import { TOOLS, DEFAULT_TOOL_ID, ToolConfig, resolveToolUrl } from './tools';
import { registerGitSyncHandlers } from './gitSync';
import { registerFsHandlers } from './fsBridge';
import { initUpdateNotifier, showUpdateNotice } from './updateNotifier';
import { initAppUpdater } from './appUpdater';
import * as contentUpdatePoller from './contentUpdatePoller';

const SIDEBAR_WIDTH = 180;

let mainWindow: BrowserWindow | null = null;
let sidebarView: BrowserView | null = null;
let contentView: BrowserView | null = null;
let activeToolId = DEFAULT_TOOL_ID;

function layoutViews(): void {
  if (!mainWindow || !sidebarView || !contentView) return;
  const [width, height] = mainWindow.getContentSize();
  sidebarView.setBounds({ x: 0, y: 0, width: SIDEBAR_WIDTH, height });
  contentView.setBounds({ x: SIDEBAR_WIDTH, y: 0, width: Math.max(0, width - SIDEBAR_WIDTH), height });
}

function switchTool(toolId: string): void {
  const tool = TOOLS.find((t) => t.id === toolId);
  if (!tool || !contentView) return;
  activeToolId = tool.id;
  contentUpdatePoller.setActiveTool(tool, contentView);
  contentView.webContents.loadURL(resolveToolUrl(tool)).catch((err) => {
    console.error(`[desktop-shell] failed to load tool ${tool.id}:`, err);
  });
  sidebarView?.webContents.send('tool:active', activeToolId);
}

function currentTool(): ToolConfig | undefined {
  return TOOLS.find((t) => t.id === activeToolId);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'DD Tool',
  });

  sidebarView = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, 'preloadSidebar.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.addBrowserView(sidebarView);
  sidebarView.webContents.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  contentView = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.addBrowserView(contentView);
  // Covers both the first load from switchTool() and the reload() triggered by a content hot-update — both go through did-finish-load.
  contentView.webContents.on('did-finish-load', () => {
    contentUpdatePoller.confirmBaseline().catch((err) => console.error('[desktop-shell] confirmBaseline failed:', err));
  });

  layoutViews();
  mainWindow.on('resize', layoutViews);
  mainWindow.on('focus', () => contentUpdatePoller.checkNow());
  mainWindow.on('closed', () => {
    mainWindow = null;
    sidebarView = null;
    contentView = null;
  });

  initUpdateNotifier(sidebarView);
  switchTool(activeToolId);
  contentUpdatePoller.startContentUpdatePolling();
  buildMenu();
}

function buildMenu(): void {
  const devSimulateMenu: MenuItemConstructorOptions = {
    label: 'Dev Debug',
    submenu: [
      {
        label: 'Simulate: content has a new version (full notice flow)',
        click: () => {
          const tool = currentTool();
          const view = contentView;
          if (!tool || !view) return;
          showUpdateNotice('content', tool.id, () => view.webContents.reload());
        },
      },
      {
        label: 'Simulate: the shell itself has a new version',
        click: () => showUpdateNotice('app', undefined, () => console.log('[desktop-shell] (simulated) quitAndInstall')),
      },
    ],
  };
  Menu.setApplicationMenu(Menu.buildFromTemplate([devSimulateMenu]));
}

ipcMain.handle('tools:list', () => TOOLS);
ipcMain.handle('tool:switch', (_e, toolId: string) => switchTool(toolId));
ipcMain.on('nw:save-ack', () => {
  contentUpdatePoller.notifySaveAck();
});

registerGitSyncHandlers();
registerFsHandlers(() => mainWindow);

app.whenReady().then(() => {
  createWindow();
  initAppUpdater();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
