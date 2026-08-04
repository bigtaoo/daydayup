import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import { showUpdateNotice } from './updateNotifier';

/**
 * Shell-level installer auto-update. Requires an actual GitHub Release
 * (package.json build.publish) to find updates against; an unpackaged run
 * (`electron .` against source) has no app-update.yml, so this no-ops.
 */

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

export function initAppUpdater(): void {
  if (!app.isPackaged) {
    console.log('[desktop-shell] dev mode (unpackaged), skipping shell-level auto-update check');
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('error', (err) => {
    console.error('[desktop-shell] shell-level auto-update error:', err);
  });

  autoUpdater.on('update-downloaded', () => {
    showUpdateNotice('app', undefined, () => autoUpdater.quitAndInstall());
  });

  const check = (): void => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('[desktop-shell] checkForUpdates failed:', err);
    });
  };

  setTimeout(check, 10_000);
  setInterval(check, CHECK_INTERVAL_MS);
}
