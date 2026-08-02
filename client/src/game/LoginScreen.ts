import { Container, Text } from 'pixi.js';
import { Panel, Button } from './ui/widgets';
import { TextInputOverlay } from './ui/TextInputOverlay';
import * as authApi from '../net/auth';
import { getSession, setSession, type Session } from '../net/session';
import { getUiTexture } from '../render/uiSkins';
import { t } from '../i18n';

/** The auth network calls this screen needs — injected (default: the real
 * `net/auth.ts` functions), same DI convention as PartyScreen's `PartyApi`. */
export interface AuthApi {
  register: typeof authApi.register;
  login: typeof authApi.login;
  logout: typeof authApi.logout;
  changePassword: typeof authApi.changePassword;
}

/**
 * Account login/register (design/16-accounts.md — this project's first real login
 * system). Pure presentation + its own two-step username→password prompt (Pixi has no
 * native text input; `TextInputOverlay` shows one field at a time, same as
 * PartyScreen's join-code entry — sequential prompts are simplest here, not worth a
 * multi-field form for two fields).
 *
 * Logging in is NEVER required to play — a player who taps BACK without an account
 * stays exactly on the pre-existing guest path (`net/identity.ts`'s local random id).
 * This screen only changes what `getPlayerId()` returns once a session exists.
 */
export class LoginScreen {
  readonly view = new Container();
  private panel = new Panel({ alpha: 0.85, background: 'hub' });
  private title: Text;
  private statusText: Text;
  private whoText: Text;
  private loginBtn: Button;
  private registerBtn: Button;
  private logoutBtn: Button;
  private changePasswordBtn: Button;
  private backBtn: Button;
  private inputOverlay = new TextInputOverlay();

  private readonly matchBaseUrl: string;
  private readonly api: AuthApi;
  private session: Session | null;
  private busy = false;

  onBack: (() => void) | null = null;
  /** Fired once a login/register succeeds, or once account meta should re-sync after a
   * session change (login, register, or logout) — Game.ts hooks this to swap MetaStore. */
  onSessionChange: (() => void) | null = null;

  constructor(opts: { matchBaseUrl: string; api?: AuthApi }) {
    this.matchBaseUrl = opts.matchBaseUrl;
    this.api = opts.api ?? authApi;
    this.session = getSession();

    this.title = new Text({ text: t('auth.title'), style: { fill: 0xf7fafc, fontSize: 32, fontWeight: 'bold', fontFamily: 'sans-serif', padding: 16 } });
    this.title.anchor.set(0.5, 0);
    this.whoText = new Text({ text: '', style: { fill: 0x90cdf4, fontSize: 18, fontFamily: 'monospace', padding: 16 } });
    this.whoText.anchor.set(0.5, 0);
    this.statusText = new Text({ text: '', style: { fill: 0xf56565, fontSize: 13, fontFamily: 'monospace', padding: 12 } });
    this.statusText.anchor.set(0.5, 0);

    this.loginBtn = new Button(t('auth.login'), { w: 200, h: 44, fontSize: 15 });
    this.loginBtn.onTap = () => this.beginLogin();
    this.loginBtn.setIcon(getUiTexture('icon_account'));
    this.registerBtn = new Button(t('auth.register'), { w: 200, h: 44, fontSize: 15, color: 0x2f855a });
    this.registerBtn.onTap = () => this.beginRegister();
    this.registerBtn.setIcon(getUiTexture('icon_register'));
    this.changePasswordBtn = new Button(t('auth.changePassword'), { w: 200, h: 40, fontSize: 13 });
    this.changePasswordBtn.onTap = () => this.beginChangePassword();
    this.changePasswordBtn.setIcon(getUiTexture('icon_password'));
    this.logoutBtn = new Button(t('auth.logout'), { w: 160, h: 36, fontSize: 13, color: 0x742a2a });
    this.logoutBtn.onTap = () => void this.doLogout();
    this.logoutBtn.setIcon(getUiTexture('icon_logout'));
    this.backBtn = new Button(t('auth.back'), { w: 120, h: 32, fontSize: 13 });
    this.backBtn.onTap = () => this.onBack?.();
    this.backBtn.setIcon(getUiTexture('icon_back'));

    this.view.addChild(
      this.panel.view, this.title, this.whoText, this.statusText,
      this.loginBtn.view, this.registerBtn.view, this.changePasswordBtn.view, this.logoutBtn.view, this.backBtn.view,
    );
    this.view.eventMode = 'static';
    this.view.visible = false;
    this.refresh();
  }

  show(w: number, h: number): void {
    this.retext();
    this.layout(w, h);
    this.session = getSession();
    this.view.visible = true;
    this.refresh();
  }

  /** Re-apply every static label from the active locale — same convention as
   * MainMenu.ts's `retext()` (design/17-i18n.md). */
  private retext(): void {
    this.title.text = t('auth.title');
    this.loginBtn.setText(t('auth.login'));
    this.registerBtn.setText(t('auth.register'));
    this.changePasswordBtn.setText(t('auth.changePassword'));
    this.logoutBtn.setText(t('auth.logout'));
    this.backBtn.setText(t('auth.back'));
  }

  hide(): void {
    this.view.visible = false;
    this.inputOverlay.close(); // never leave a DOM input dangling once navigated away
  }

  private layout(w: number, h: number): void {
    this.panel.layout(w, h);
    const cx = w / 2;
    const cy = h / 2;
    this.title.position.set(cx, cy - 160);
    this.whoText.position.set(cx, cy - 100);
    this.statusText.position.set(cx, cy + 110);
    this.loginBtn.view.position.set(cx - 100, cy - 40);
    this.registerBtn.view.position.set(cx - 100, cy + 14);
    this.changePasswordBtn.view.position.set(cx - 100, cy - 40);
    this.logoutBtn.view.position.set(cx - 80, cy + 14);
    this.backBtn.view.position.set(cx - 60, cy + 170);
  }

  private beginLogin(): void {
    if (this.busy) return;
    this.promptCredentials((username, password) => void this.doLogin(username, password));
  }

  private beginRegister(): void {
    if (this.busy) return;
    this.promptCredentials((username, password) => void this.doRegister(username, password));
  }

  private promptCredentials(onDone: (username: string, password: string) => void): void {
    this.statusText.text = '';
    this.inputOverlay.open({
      placeholder: t('auth.usernamePlaceholder'),
      maxLength: 20,
      onSubmit: (username) => {
        const name = username.trim();
        if (!name) {
          this.statusText.text = t('auth.usernameRequired');
          return;
        }
        this.inputOverlay.open({
          placeholder: t('auth.passwordPlaceholder'),
          maxLength: 64,
          password: true,
          onSubmit: (password) => onDone(name, password),
        });
      },
    });
  }

  private beginChangePassword(): void {
    if (this.busy || !this.session) return;
    this.statusText.text = '';
    this.inputOverlay.open({
      placeholder: t('auth.currentPasswordPlaceholder'),
      maxLength: 64,
      password: true,
      onSubmit: (oldPassword) => {
        this.inputOverlay.open({
          placeholder: t('auth.newPasswordPlaceholder'),
          maxLength: 64,
          password: true,
          onSubmit: (newPassword) => void this.doChangePassword(oldPassword, newPassword),
        });
      },
    });
  }

  private async doLogin(username: string, password: string): Promise<void> {
    if (this.busy) return; // re-entrant guard — mirrors PartyScreen's doCreate/doJoin
    this.busy = true;
    try {
      const result = await this.api.login(this.matchBaseUrl, username, password);
      setSession(result);
      this.session = result;
      this.onSessionChange?.();
    } catch (e) {
      this.statusText.text = (e as Error).message || t('auth.loginFailed');
    } finally {
      this.busy = false;
      this.refresh();
    }
  }

  private async doRegister(username: string, password: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const result = await this.api.register(this.matchBaseUrl, username, password);
      setSession(result);
      this.session = result;
      this.onSessionChange?.();
    } catch (e) {
      this.statusText.text = (e as Error).message || t('auth.registerFailed');
    } finally {
      this.busy = false;
      this.refresh();
    }
  }

  private async doChangePassword(oldPassword: string, newPassword: string): Promise<void> {
    if (!this.session || this.busy) return;
    this.busy = true;
    try {
      await this.api.changePassword(this.matchBaseUrl, this.session.token, oldPassword, newPassword);
      this.statusText.text = t('auth.passwordChanged');
    } catch (e) {
      this.statusText.text = (e as Error).message || t('auth.passwordChangeFailed');
    } finally {
      this.busy = false;
      this.refresh();
    }
  }

  private async doLogout(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const session = this.session;
    setSession(null);
    this.session = null;
    this.onSessionChange?.();
    this.refresh();
    if (session) {
      try {
        await this.api.logout(this.matchBaseUrl, session.token);
      } catch {
        /* best-effort — the session TTLs out server-side even if this call is lost */
      } finally {
        this.busy = false;
      }
    } else {
      this.busy = false;
    }
  }

  private refresh(): void {
    const loggedIn = this.session !== null;
    this.whoText.text = loggedIn ? t('auth.loggedInAs', { username: this.session!.username }) : t('auth.playingAsGuest');
    this.loginBtn.view.visible = !loggedIn;
    this.registerBtn.view.visible = !loggedIn;
    this.changePasswordBtn.view.visible = loggedIn;
    this.logoutBtn.view.visible = loggedIn;
  }
}
