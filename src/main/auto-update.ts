/**
 * Auto-update from GitHub Releases through update.electronjs.org (`update-electron-app`).
 *
 * That free service reads only public repositories, serves only macOS and Windows, and skips
 * drafts and pre-releases; Squirrel.Mac installs only a build signed like the running one. So
 * updates check only from a packaged, released build; developer, fixture and test launches never
 * do. Copies built before the switch was turned on never check (docs/release-operations.md).
 *
 * Linux has no in-place installer: a released Linux build asks GitHub for the newest published
 * release instead (`./release-check.ts`) and offers its download page. A deb or rpm installed
 * since the Genex package repository (packages.genex.games) is updated by the system's own
 * updates (apt, dnf, Software Updater), so it neither asks nor offers anything.
 *
 * A downloaded update is announced in the studio window, whose sidebar offers the restart
 * (`UiEvent.UpdateReady`); before the studio is up (the sandbox setup screen) it is one
 * notification that restarts when clicked. Either way it installs at the next quit. A Linux
 * release is announced the same way, as a download. Check for Updates (Settings, the app menu)
 * asks now (`createUpdateChecker`).
 *
 * Squirrel.Mac runs one check at a time, its download included, and refuses another asked
 * meanwhile; asked again after a download, it gets 304 for the same zip and Electron then
 * forgets the update. So Check for Updates goes through `watchInstaller`, which answers from a
 * check already running, and the periodic checks stop once a version is downloaded.
 */
import { SECOND_MS } from "../shared/duration.ts";
import { type ReadyUpdate, UpdateAction, type UpdateCheckResult, UpdateCheckStatus } from "../shared/app-update.ts";
import type { PublishedRelease, ReleaseCheck } from "./release-check.ts";
import { ReleaseCheckKind } from "./release-check.ts";

/** The release switch, on since the public launch; PRIVACY.md discloses the check. */
export const AUTO_UPDATE_ENABLED = true;
/**
 * The GitHub repository whose releases update.electronjs.org serves. `forge.config.cjs`
 * publishes to it and `package.json` names it (`auto-update.test.ts` holds the three together).
 */
/** This fork's own releases: updates come from the fork, never from upstream Genex. */
export const UPDATE_REPO = "Franzferdinan51/genex-desktop";
/** How often an installed copy asks for a newer release (the `ms` syntax the library parses). */
const UPDATE_CHECK_INTERVAL = "1 hour";
/** The platforms update.electronjs.org serves. */
const UPDATE_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set(["darwin", "win32"]);
/** The platforms told about a release they download themselves. */
const NOTIFY_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set(["linux"]);
/** The packaged executable the deb and rpm install, and the repository files their scripts write. */
const SYSTEM_PACKAGE_EXEC = "/usr/lib/genex/genex";
const GENEX_REPOSITORY_FILES = ["/etc/apt/sources.list.d/genex.list", "/etc/yum.repos.d/genex.repo"] as const;
/** How long Check for Updates waits on the installer's answer. */
const INSTALL_CHECK_TIMEOUT_MS = 30 * SECOND_MS;
/** A semantic version inside a release name: "Genex 0.2.0", "v0.2.0", "0.3.0-rc.2". */
const RELEASE_VERSION = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/;
/** Squirrel.Mac's refusal of a check asked while one runs (ReactiveObjC's RACCommandErrorNotEnabled). */
const SQUIRREL_BUSY = { domain: "RACCommandErrorDomain", code: 1 } as const;

/** Electron autoUpdater's events, in its spelling. */
const UpdaterEvent = {
  CheckingForUpdate: "checking-for-update",
  UpdateAvailable: "update-available",
  UpdateNotAvailable: "update-not-available",
  UpdateDownloaded: "update-downloaded",
  Error: "error",
} as const;

/** Why a launch does not check for updates. */
export const UpdateSkip = {
  Disabled: "disabled",
  Unpackaged: "unpackaged",
  Platform: "platform",
  DeveloperLaunch: "developer-launch",
  TestLaunch: "test-launch",
  Identity: "identity",
} as const;
export type UpdateSkip = (typeof UpdateSkip)[keyof typeof UpdateSkip];

/** The facts about this launch that decide whether it checks for updates. */
export interface UpdateLaunch {
  /** The release switch (`AUTO_UPDATE_ENABLED`). */
  enabled: boolean;
  /** `app.isPackaged`. */
  packaged: boolean;
  platform: NodeJS.Platform;
  /** A `studio:dev` launch, fixture profiles included. */
  developerLaunch: boolean;
  /** A smoke or self-test run. */
  testLaunch: boolean;
  /** Renamed forks must configure their own feed before enabling updates. */
  productName: string;
  /** Linux: this copy is the deb or rpm install with the Genex repository configured (`installedFromGenexRepository`). */
  systemPackages: boolean;
}

/** How a released build updates. */
export const UpdateMode = {
  /** macOS and Windows: download in the background, install on a restart. */
  Install: "install",
  /** Linux: tell the person about a newer release to download. */
  Notify: "notify",
  /** Linux from the Genex package repository: the system's own updates install it. */
  System: "system",
} as const;
export type UpdateMode = (typeof UpdateMode)[keyof typeof UpdateMode];

export type UpdateDecision = { start: true; mode: UpdateMode } | { start: false; reason: UpdateSkip };

const MESSAGE = {
  title: "Update ready — restart",
  namedBody: (version: string) =>
    `Genex ${version} is downloaded. Click to restart now, or it installs the next time you quit.`,
  unnamedBody: "A new version of Genex is downloaded. Click to restart now, or it installs the next time you quit.",
  availableTitle: (version: string) => `Genex ${version} is available`,
  availableBody: "Click to open its download page.",
  current: (version: string) => `Genex ${version} is the latest version.`,
  downloading: "A new version of Genex is downloading.",
  downloadingDetail: "It installs when you relaunch; Genex tells you when it's ready.",
  readyToRestart: (version: string) => `Genex ${version} is ready to install.`,
  readyDetail: "Relaunch now, or it installs the next time you quit.",
  available: (version: string) => `Genex ${version} is available.`,
  availableDetail: "Download it from the release page and install it over this version.",
  off: "This build of Genex doesn't check for updates.",
  offDetail: "Development builds and builds packaged under another name update from source.",
  system: "Genex updates with your system.",
  systemDetail:
    "New versions arrive with your system's updates: Software Updater, sudo apt upgrade or sudo dnf upgrade.",
  failed: "Genex couldn't check for updates.",
  failedDetail: "Check your connection and try again.",
  newVersion: "the new version",
} as const;

/** Whether this launch checks for updates, and the first reason it does not. */
export function autoUpdateDecision(launch: UpdateLaunch): UpdateDecision {
  if (!launch.enabled) return { start: false, reason: UpdateSkip.Disabled };
  if (!launch.packaged) return { start: false, reason: UpdateSkip.Unpackaged };
  if (!UPDATE_PLATFORMS.has(launch.platform) && !NOTIFY_PLATFORMS.has(launch.platform))
    return { start: false, reason: UpdateSkip.Platform };
  if (launch.developerLaunch) return { start: false, reason: UpdateSkip.DeveloperLaunch };
  if (launch.testLaunch) return { start: false, reason: UpdateSkip.TestLaunch };
  if (launch.productName !== "Genex") return { start: false, reason: UpdateSkip.Identity };
  if (UPDATE_PLATFORMS.has(launch.platform)) return { start: true, mode: UpdateMode.Install };
  return { start: true, mode: launch.systemPackages ? UpdateMode.System : UpdateMode.Notify };
}

/**
 * Whether this Linux copy is the deb or rpm install whose maintainer scripts configured the Genex
 * package repository. A zip copy elsewhere on the same machine is not: nothing updates it.
 */
export function installedFromGenexRepository(execPath: string, exists: (path: string) => boolean): boolean {
  return execPath === SYSTEM_PACKAGE_EXEC && GENEX_REPOSITORY_FILES.some((path) => exists(path));
}

/**
 * The version a release's name carries, or null. update.electronjs.org passes on the GitHub
 * release's title ("Genex 0.2.0", as release.yml names it); Squirrel.Windows the bare version.
 */
export function releaseVersion(releaseName: string): string | null {
  return RELEASE_VERSION.exec(releaseName)?.[0] ?? null;
}

/** The notification for a downloaded update, naming its version when the release gave one. */
function updateReadyNote(version: string | null): { title: string; body: string } {
  return { title: MESSAGE.title, body: version ? MESSAGE.namedBody(version) : MESSAGE.unnamedBody };
}

/** What announcing and installing a downloaded update needs from main. */
export interface UpdateAnnouncerDeps {
  /** The studio's core is up, so its window shows the prompt (now, or when it next opens). */
  studioUp(): boolean;
  /** Tells the studio window (`UiEvent.UpdateReady`). */
  announce(update: ReadyUpdate): void;
  /** Shows a notification; `onClick` runs when the person clicks it. */
  notify(note: { title: string; body: string }, onClick: () => void): void;
  /** Asks before a restart would end an active run; resolves true when nothing runs. */
  confirmRestart(): Promise<boolean>;
  /** Quits and relaunches into the downloaded version (`autoUpdater.quitAndInstall`). */
  quitAndInstall(): void;
  /** Opens a release page (already checked by `releasePageUrl`) in the browser. */
  openRelease(url: string): void;
}

/** Main's side of a downloaded update: what the window reads, and the restart it asks for. */
export interface UpdateAnnouncer {
  /** The update waiting for the person (a restart or a download), or null. */
  ready(): ReadyUpdate | null;
  /** The updater finished a download: remember it and tell the person. */
  downloaded(releaseName: string): void;
  /** A newer release this copy cannot install in place: remember it and tell the person once. */
  available(release: PublishedRelease): void;
  /** Restart into the downloaded update; false when there is none, one is already asking, or a run is kept. */
  restart(): Promise<boolean>;
  /** Open the waiting release's download page; false when no downloadable release waits. */
  download(): boolean;
}

export function createUpdateAnnouncer(deps: UpdateAnnouncerDeps): UpdateAnnouncer {
  let ready: ReadyUpdate | null = null;
  let releaseUrl: string | null = null;
  let asking = false;
  const restart = async (): Promise<boolean> => {
    if (ready?.action !== UpdateAction.Restart || asking) return false;
    asking = true;
    try {
      if (!(await deps.confirmRestart())) return false;
      deps.quitAndInstall();
      return true;
    } finally {
      asking = false;
    }
  };
  const download = (): boolean => {
    if (ready?.action !== UpdateAction.Download || !releaseUrl) return false;
    deps.openRelease(releaseUrl);
    return true;
  };
  return {
    ready: () => ready,
    downloaded(releaseName) {
      const update = { version: releaseVersion(releaseName), action: UpdateAction.Restart };
      ready = update;
      releaseUrl = null;
      if (deps.studioUp()) deps.announce(update);
      else deps.notify(updateReadyNote(update.version), () => void restart());
    },
    available(release) {
      const known = ready?.action === UpdateAction.Download && ready.version === release.version;
      if (known || ready?.action === UpdateAction.Restart) return;
      const update = { version: release.version, action: UpdateAction.Download };
      ready = update;
      releaseUrl = release.url;
      if (deps.studioUp()) deps.announce(update);
      else deps.notify({ title: MESSAGE.availableTitle(release.version), body: MESSAGE.availableBody }, download);
    },
    restart,
    download,
  };
}

/** What Electron's autoUpdater answered one check. */
export const InstallCheck = {
  None: "none",
  Found: "found",
  Downloaded: "downloaded",
  Failed: "failed",
} as const;
export type InstallCheck = (typeof InstallCheck)[keyof typeof InstallCheck];

/** What Electron's autoUpdater is doing, as its events tell. */
export const InstallerPhase = {
  Idle: "idle",
  /** A check runs; on macOS another one asked now is refused. */
  Checking: "checking",
  /** A newer version was found and downloads, still inside that check. */
  Downloading: "downloading",
  /** A version is downloaded and installs at the next quit. */
  Downloaded: "downloaded",
} as const;
export type InstallerPhase = (typeof InstallerPhase)[keyof typeof InstallerPhase];

/** The part of Electron's autoUpdater one check uses. */
export interface CheckableUpdater {
  once(event: string, listener: (error?: unknown) => void): unknown;
  removeListener(event: string, listener: (error?: unknown) => void): unknown;
  checkForUpdates(): void;
}

/** The part of Electron's autoUpdater `watchInstaller` uses: one check, and its events from launch. */
export interface WatchableUpdater extends CheckableUpdater {
  on(event: string, listener: (error?: unknown) => void): unknown;
}

/** The autoUpdater's events, and what each answers. */
const INSTALL_ANSWERS: readonly (readonly [string, InstallCheck])[] = [
  [UpdaterEvent.UpdateNotAvailable, InstallCheck.None],
  [UpdaterEvent.UpdateAvailable, InstallCheck.Found],
  [UpdaterEvent.UpdateDownloaded, InstallCheck.Downloaded],
  [UpdaterEvent.Error, InstallCheck.Failed],
];

/** The autoUpdater's events, and the phase each one starts. */
const INSTALLER_PHASES: readonly (readonly [string, InstallerPhase])[] = [
  [UpdaterEvent.CheckingForUpdate, InstallerPhase.Checking],
  [UpdaterEvent.UpdateAvailable, InstallerPhase.Downloading],
  [UpdaterEvent.UpdateDownloaded, InstallerPhase.Downloaded],
  [UpdaterEvent.UpdateNotAvailable, InstallerPhase.Idle],
  [UpdaterEvent.Error, InstallerPhase.Idle],
];

/** Whether an autoUpdater error only refused a second check, leaving the running one to answer. */
function refusedAsBusy(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if (!("domain" in error) || !("code" in error)) return false;
  return error.domain === SQUIRREL_BUSY.domain && error.code === SQUIRREL_BUSY.code;
}

/**
 * Ask the autoUpdater once: its first answer, or failed on a throw or after `timeoutMs`. A
 * download already running answers found, and a downloaded version downloaded, without asking:
 * the first asks Squirrel nothing it can take, the second would make Electron forget the update.
 * While a check runs, or when Squirrel refuses this one as busy, the running check answers.
 */
export function askUpdater(
  updater: CheckableUpdater,
  {
    timeoutMs = INSTALL_CHECK_TIMEOUT_MS,
    phase = () => InstallerPhase.Idle,
  }: { timeoutMs?: number; phase?: () => InstallerPhase } = {},
): Promise<InstallCheck> {
  const now = phase();
  if (now === InstallerPhase.Downloading) return Promise.resolve(InstallCheck.Found);
  if (now === InstallerPhase.Downloaded) return Promise.resolve(InstallCheck.Downloaded);
  return new Promise((resolve) => {
    const answer = (check: InstallCheck) => (error?: unknown) => {
      if (check === InstallCheck.Failed && refusedAsBusy(error)) return;
      finish(check);
    };
    const listeners = INSTALL_ANSWERS.map(([event, check]) => [event, answer(check)] as const);
    const timer = setTimeout(() => finish(InstallCheck.Failed), timeoutMs);
    function finish(check: InstallCheck): void {
      clearTimeout(timer);
      for (const [event, listener] of listeners) updater.removeListener(event, listener);
      resolve(check);
    }
    for (const [event, listener] of listeners) updater.once(event, listener);
    if (now === InstallerPhase.Checking) return;
    try {
      updater.checkForUpdates();
    } catch {
      finish(InstallCheck.Failed);
    }
  });
}

/**
 * Electron's autoUpdater, watched from launch, so Check for Updates knows the periodic check it
 * would collide with. A refused check changes nothing, and a downloaded version stays downloaded.
 */
export function watchInstaller(
  updater: WatchableUpdater,
  options: { timeoutMs?: number } = {},
): { ask(): Promise<InstallCheck> } {
  let phase: InstallerPhase = InstallerPhase.Idle;
  for (const [event, next] of INSTALLER_PHASES) {
    updater.on(event, (error) => {
      if (phase === InstallerPhase.Downloaded || refusedAsBusy(error)) return;
      phase = next;
    });
  }
  return { ask: () => askUpdater(updater, { ...options, phase: () => phase }) };
}

/** What Check for Updates needs: this launch's decision, the announcer, and the two ways to ask. */
export interface UpdateCheckerDeps {
  decision: UpdateDecision;
  /** The running version (`app.getVersion()`). */
  current: string;
  updates: Pick<UpdateAnnouncer, "ready" | "available">;
  /** macOS/Windows: ask the installer (`watchInstaller(autoUpdater).ask`). */
  askInstaller(): Promise<InstallCheck>;
  /** Linux: ask GitHub for the newest published release (`latestRelease`). */
  latestRelease(): Promise<ReleaseCheck>;
}

/** The status an installer answer means. */
const INSTALL_STATUS = {
  [InstallCheck.None]: UpdateCheckStatus.Current,
  [InstallCheck.Found]: UpdateCheckStatus.Downloading,
  [InstallCheck.Downloaded]: UpdateCheckStatus.Waiting,
  [InstallCheck.Failed]: UpdateCheckStatus.Failed,
} as const satisfies Record<InstallCheck, UpdateCheckStatus>;

/** Check for Updates: one check at a time; a found release announces itself like a periodic one. */
export function createUpdateChecker(deps: UpdateCheckerDeps): { check(): Promise<UpdateCheckResult> } {
  const { decision, current, updates } = deps;
  let running: Promise<UpdateCheckResult> | null = null;
  const result = (status: UpdateCheckStatus): UpdateCheckResult => {
    const update = updates.ready();
    return status === UpdateCheckStatus.Waiting && update
      ? { status, current, update }
      : {
          status: status === UpdateCheckStatus.Waiting ? UpdateCheckStatus.Downloading : status,
          current,
          update: null,
        };
  };
  const ask = async (): Promise<UpdateCheckResult> => {
    if (updates.ready()?.action === UpdateAction.Restart) return result(UpdateCheckStatus.Waiting);
    if (!decision.start) return result(UpdateCheckStatus.Off);
    if (decision.mode === UpdateMode.System) return result(UpdateCheckStatus.System);
    if (decision.mode === UpdateMode.Install) return result(INSTALL_STATUS[await deps.askInstaller()]);
    const found = await deps.latestRelease();
    if (found.kind === ReleaseCheckKind.Failed) return result(UpdateCheckStatus.Failed);
    if (found.kind === ReleaseCheckKind.Newer) updates.available(found.release);
    return result(updates.ready() ? UpdateCheckStatus.Waiting : UpdateCheckStatus.Current);
  };
  return {
    check() {
      running ??= ask().finally(() => {
        running = null;
      });
      return running;
    },
  };
}

/** The app menu's answer to Check for Updates: what it says, and the one step it offers, if any. */
export function updateCheckNote(result: UpdateCheckResult): {
  message: string;
  detail: string;
  act: UpdateAction | null;
} {
  const version = result.update?.version ?? MESSAGE.newVersion;
  if (result.status === UpdateCheckStatus.Current)
    return { message: MESSAGE.current(result.current), detail: "", act: null };
  if (result.status === UpdateCheckStatus.Downloading)
    return { message: MESSAGE.downloading, detail: MESSAGE.downloadingDetail, act: null };
  if (result.status === UpdateCheckStatus.Off) return { message: MESSAGE.off, detail: MESSAGE.offDetail, act: null };
  if (result.status === UpdateCheckStatus.System)
    return { message: MESSAGE.system, detail: MESSAGE.systemDetail, act: null };
  if (result.status === UpdateCheckStatus.Failed)
    return { message: MESSAGE.failed, detail: MESSAGE.failedDetail, act: null };
  if (result.update?.action === UpdateAction.Download)
    return { message: MESSAGE.available(version), detail: MESSAGE.availableDetail, act: UpdateAction.Download };
  return { message: MESSAGE.readyToRestart(version), detail: MESSAGE.readyDetail, act: UpdateAction.Restart };
}

/** What starting the updater needs from main: the log, and where a finished download goes. */
export interface AutoUpdateDeps {
  log(line: string): void;
  /** A new version finished downloading; `releaseName` is the feed's name for it. */
  downloaded(releaseName: string): void;
}

/** The logger update-electron-app writes to: a word, then values (a URL, headers, an Error). */
type UpdaterLogger = Record<"log" | "info" | "warn" | "error", (...parts: unknown[]) => void>;

/** What Genex hands update-electron-app beyond the feed and the cadence. */
export interface PeriodicUpdateOptions {
  logger: UpdaterLogger;
  onNotifyUser(info: { releaseName?: string }): void;
}

/** Started periodic checks, which stop on request. */
interface PeriodicUpdates {
  stopUpdates(): void;
}

/** One log line from the updater's arguments: words and error messages; objects (headers, release notes) stay out. */
function updaterLogLine(parts: readonly unknown[]): string {
  const words = parts.flatMap((part) => {
    if (part instanceof Error) return [part.message];
    if (typeof part === "string" || typeof part === "number" || typeof part === "boolean") return [String(part)];
    return [];
  });
  return words.join(" ");
}

/** update-electron-app on update.electronjs.org: a check now, then one every `UPDATE_CHECK_INTERVAL`. */
async function startUpdateElectronApp(options: PeriodicUpdateOptions): Promise<PeriodicUpdates> {
  const { UpdateSourceType, updateElectronApp } = await import("update-electron-app");
  return updateElectronApp({
    updateSource: { type: UpdateSourceType.ElectronPublicUpdateService, repo: UPDATE_REPO },
    updateInterval: UPDATE_CHECK_INTERVAL,
    notifyUser: true,
    ...options,
  });
}

/** Starts the periodic update checks; call only when `autoUpdateDecision` says start. */
export async function startAutoUpdate(
  { log, downloaded }: AutoUpdateDeps,
  start: (options: PeriodicUpdateOptions) => Promise<PeriodicUpdates> = startUpdateElectronApp,
): Promise<void> {
  const write = (...parts: unknown[]) => log(updaterLogLine(parts));
  const periodic = await start({
    logger: { log: write, info: write, warn: write, error: write },
    // A download finishes long after the checks start, so `periodic` is set by then.
    onNotifyUser: ({ releaseName }) => {
      // Asked again, Squirrel.Mac gets 304 for the same zip and Electron forgets the update.
      periodic.stopUpdates();
      downloaded(releaseName ?? "");
    },
  });
}
