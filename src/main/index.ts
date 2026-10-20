import { isClaudeLoginActive } from "../shared/claude-login.ts";
import { isCodexLoginActive } from "../shared/codex-login.ts";
import { updateCodingCli } from "../substrate/cli-update.ts";
import { HarnessLogBatch } from "./harness-log-batch.ts";
import { createDesktopControl } from "./desktop-control-host.ts";
import type { DesktopControl } from "./core/desktop-control.ts";
import { showAfterPaint } from "./window-ready.ts";
import { PerformanceRecorder, watchEventLoop } from "./performance.ts";
import { registerPerformanceIpc } from "./ipc/performance.ts";
/**
 * Electron main — the app shell around the substrate.
 *
 * Main owns everything privileged: the event store, git snapshots, the sandbox, the engines, the
 * preview's `webContents`, and the keep-awake blocker. The renderer is a view; the harness is a
 * contained child process. Neither can reach past main. This file keeps the app lifecycle and the
 * window; each IPC domain registers itself from `./ipc/`, and the smoke, self test and acceptance
 * runners in `./smoke/` are imported only when their flag is set.
 */
import {
  BrowserWindow,
  Menu,
  MenuItem,
  Notification,
  app,
  autoUpdater,
  crashReporter,
  dialog,
  ipcMain,
  nativeTheme,
  net,
  protocol,
  powerSaveBlocker,
  ShareMenu,
  shell,
  utilityProcess,
} from "electron";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { type ThreadStatusMap, UiEvent } from "../shared/ui-events.ts";
import { onSoundShortcut } from "./game-sound.ts";
import type { GameFullScreen } from "./game-full-screen.ts";
import { wireGameFullScreen } from "./full-screen-view.ts";
import { HarnessState } from "../shared/protocol.ts";
import { ClaudeCodeEngine } from "../substrate/engines/claude-code.ts";
import { CodexEngine } from "../substrate/engines/codex.ts";
import { configureCodingClis, resolveCodingCli } from "../substrate/engines/external-cli.ts";
import { installCodingCli } from "../substrate/cli-installer.ts";
import { CodingCliState } from "../shared/coding-cli.ts";
import { PLUGIN_ICON_PATH } from "../shared/plugins.ts";
import { OllamaEngine } from "../substrate/engines/ollama.ts";
import { PluginMarketplace } from "../substrate/plugins/marketplace.ts";
import { scanPackage } from "../substrate/plugins/scan.ts";
import {
  createReloadPolicy,
  installProcessHandlers,
  PageRecovery,
  pageRecovery,
  QuitQuestion,
  quitQuestion,
  runShutdown,
  shutdownSteps,
  type ShutdownStep,
} from "./app-lifecycle.ts";
import { createBootGate, startStepAfter } from "./boot-gate.ts";
import {
  activateChatFixture,
  DevProviders,
  FIRST_LAUNCH_STATUS,
  FIXTURE_AGENTS_FAILURE,
  FIXTURE_SANDBOX_PROBLEM,
  FIXTURE_UPDATE_RELEASE,
  FixtureName,
  fixtureEngines,
  installOlderPlugins,
  isChatFixture,
  prepareFixture,
} from "./dev/fixtures.ts";
import {
  AUTO_UPDATE_ENABLED,
  UPDATE_REPO,
  UpdateMode,
  autoUpdateDecision,
  createUpdateAnnouncer,
  createUpdateChecker,
  installedFromGenexRepository,
  startAutoUpdate,
  updateCheckNote,
  watchInstaller,
} from "./auto-update.ts";
import { RELEASE_CHECK_INTERVAL_MS, latestRelease } from "./release-check.ts";
import { UpdateAction } from "../shared/app-update.ts";
import { gatedHostTool } from "./core/genex-cli.ts";
import { normalGamesElsewhere, normalGamesFolder } from "./core/never-touch-list.ts";
import { diagnosticsText, gatherDiagnostics } from "./diagnostics.ts";
import { type FeedbackSources, sendFeedback } from "./feedback.ts";
import { renderGameCover } from "./game-cover-renderer.ts";
import { createIpcHandle, pushToRenderer } from "./ipc-handle.ts";
import { registerBootIpc } from "./ipc/boot.ts";
import { registerUpdateIpc } from "./ipc/update.ts";
import { registerGamesIpc } from "./ipc/games.ts";
import { registerStorageIpc } from "./ipc/storage.ts";
import { registerJobsIpc } from "./ipc/jobs.ts";
import { registerLearningIpc } from "./ipc/learning.ts";
import { registerLoginIpc } from "./ipc/login.ts";
import { registerCliInstallIpc } from "./ipc/cli-install.ts";
import { createCliInstalls } from "./cli-install.ts";
import { registerMcpIpc } from "./ipc/mcp.ts";
import { registerModelsIpc } from "./ipc/models.ts";
import { registerNotificationsIpc } from "./ipc/notifications.ts";
import { registerPermissionsIpc } from "./ipc/permissions.ts";
import { registerPluginsIpc } from "./ipc/plugins.ts";
import { type PreviewBoundsRecord, registerPreviewIpc } from "./ipc/preview.ts";
import { registerProjectsIpc } from "./ipc/projects.ts";
import { registerPlayIpc } from "./ipc/play.ts";
import { registerGenexAccountIpc } from "./ipc/genex-account.ts";
import {
  createGenexAccount,
  type GenexAccount,
  type GenexAccountPort,
  pluginAccountPort,
} from "./core/genex-account.ts";
import { devStandAccountPort } from "./dev/dev-stand-account.ts";
import { fixtureAccountPort } from "./dev/fixture-genex-account.ts";
import { openGenexPage } from "./genex-browser.ts";
import { fixtureGamePage, fixturePlayRequest } from "./dev/fixture-play.ts";
import { launchFixtureAccount } from "./dev/fixture-people.ts";
import {
  fixtureUpload,
  networkUpload,
  type PeopleDeps,
  type PlayPeople,
  playPeople,
  refusingRequest,
} from "./play/people.ts";
import { type CreatorStats, creatorStats } from "./play/creator-stats.ts";
import { type GenexCredits, genexCredits } from "./play/credits.ts";
import {
  type AssetLibrary,
  assetLibrary,
  LIBRARY_UPLOAD_TIMEOUT_MS,
  libraryPictureFile,
  type LibraryPictureFile,
  networkDownload,
  networkPictureFile,
} from "./play/asset-library.ts";
import { type LibrarySharing, librarySharing } from "./core/library-sharing.ts";
import { registerAssetLibraryIpc } from "./ipc/asset-library.ts";
import { readAssetPreview } from "./asset-preview.ts";
import { fixtureDownload, fixtureFileResponse } from "./dev/fixture-asset-library.ts";
import { networkRequest, type PlayGallery, playGallery, type PlayWorld } from "./play/gallery.ts";
import { createPlayManage, type PlayManage } from "./play/manage.ts";
import { fixtureClone, gitClone, gitCloneCode, remixGame } from "./play/remix.ts";
import { type MentionSources, vendorAssetModule } from "./core/mention-tags.ts";
import type { PlayViewer } from "./play/viewer.ts";
import { playMicStore } from "./play/mic-store.ts";
import { playViewsOf, wirePlayViewer } from "./play/viewer-view.ts";
import { type PlayComments, playComments } from "./play/comments.ts";
import { playOrigins } from "./play/origins.ts";
import { PLAY_ORIGIN, type PlayPoint } from "../shared/play.ts";
import { registerRunsIpc } from "./ipc/runs.ts";
import { registerSettingsIpc } from "./ipc/settings.ts";
import { readLicenseTexts } from "./licenses.ts";
import { registerSkillsIpc } from "./ipc/skills.ts";
import { registerTerminalIpc } from "./ipc/terminal.ts";
import { registerMentionRetry, registerThreadsIpc } from "./ipc/threads.ts";
import { engineBoot, type EngineBoot } from "./engine-boot.ts";
import { KeepAwake } from "./keep-awake.ts";
import { routeStudioLink } from "./link-policy.ts";
import { createLoginControllers, type SubscriptionEngine } from "./login-controllers.ts";
import { createOpenRouterLogin } from "./openrouter-login.ts";
import { openStudioLog } from "./logs.ts";
import { migrateLegacyUserData, userDataMigrationLine } from "./user-data-migration.ts";
import { confirmPluginInstall, reacquirePlugin } from "./plugin-install-dialog.ts";
import { PLUGIN_PANEL_CSP } from "./plugin-panel-csp.ts";
import { HttpStatus, textResponse } from "./page-serve.ts";
import { GamePreview, registerGameScheme } from "./preview.ts";
import { RunSummaryReader } from "./run-summary-reader.ts";
import { registerRunSharingIpc } from "./ipc/run-sharing.ts";
import { createRunSharing, finishedBuildRef, launchSends, runsOrigin } from "./run-sharing.ts";
import { readFinishedFacts } from "./run-sharing-facts.ts";
import { fieldPlatform } from "../shared/run-sharing.ts";
import type { SmokeReadGates } from "./smoke/read-gates.ts";
import type { EvalCoreOptions, EvalLaunch } from "./smoke/eval-lane.ts";
import { StudioCore, type StudioCoreOptions } from "./studio-core.ts";
import { appLookAccess } from "./app-look-access.ts";
import { layoutFor } from "./core/layout.ts";
import { appLookRun, macAppLook, stubAppLook, unsupportedAppLook } from "../substrate/app-look.ts";
import { TerminalService, type TerminalHost } from "./terminal-service.ts";
import { windowControlsPainter } from "./window-chrome.ts";
import { appUserModelId, installedWorkingDir, runSquirrelStep, squirrelStartup } from "./windows-install.ts";
import { BootPhase, type SandboxProblem, StartStep, StudioPlatform } from "../shared/boot.ts";
import { SandboxUnavailableError } from "../substrate/sandbox-unavailable.ts";
import { longPath } from "../substrate/windows-sandbox.ts";
import { installWindowsSandbox } from "../substrate/windows-sandbox-setup.ts";
import { toolchain } from "../substrate/toolchain.ts";
import { errorMessage } from "../shared/errors.ts";
import { MINUTE_MS, SECOND_MS } from "../shared/duration.ts";
import { EVAL_LANE_EXIT } from "../shared/eval-lane.ts";
import { EngineId } from "../shared/providers.ts";
import { TerminalKind } from "../shared/terminal.ts";
import {
  flagValue,
  hasFlag,
  linuxSecretStorageSwitches,
  quitsWhenLastWindowCloses,
  StudioFlag,
  testLaunchChromiumSwitches,
} from "./dev/launch-flags.ts";
import { EventKind } from "../shared/event-log.ts";

/** The studio window: its first size and the least it shrinks to. */
const MAIN_WINDOW = { width: 1440, height: 900, minWidth: 1080, minHeight: 680 } as const;
/**
 * The window's own colour before the page paints and while it resizes: the Genex page colour of the
 * system's light or dark, which a first launch's theme follows too (renderer/appearance/first-paint.ts).
 */
const WINDOW_BACKGROUND = { dark: "#131214", light: "#f5f5f5" } as const;
/** A hidden, offscreen observation window for one Autopilot facet. */
const FACET_WINDOW = { width: 960, height: 600, backgroundColor: "#05070d" } as const;
/** Where a parked fixture window sits: off every display. */
const PARKED_WINDOW_X = -4000;
/** UI events main keeps for the developer runtime's harness-log reads. */
const UI_EVENT_BUFFER_MAX = 200;
/** Renderer console lines main keeps for diagnostics and the smoke. */
const RENDERER_CONSOLE_MAX = 200;
/** What the log says of a page that died while the app quits: nothing is done about it. */
const QUITTING = "quitting";
/** How long a developer launch waits for the renderer to show its threads, and how often it looks. */
const HYDRATION_TIMEOUT_MS = 15 * SECOND_MS;
const HYDRATION_POLL_MS = 100;
/** How long a fixture session may take to open its game from the sidebar, and how often it looks. */
const FIXTURE_OPEN_TIMEOUT_MS = 15 * SECOND_MS;
const FIXTURE_OPEN_POLL_MS = 50;
/**
 * How long a start the window watches may take before it offers Try again, a report and Quit. A
 * healthy one takes under a minute; srt-win's own limits (the egress check, each folder grant) end
 * a stuck step within a few, and the start goes on behind the offer.
 */
const START_TIMEOUT_MS = 3 * MINUTE_MS;
/** What a hydrated renderer shows: the threads, or the sandbox setup screen. */
const HYDRATED = "nav [data-thread], [data-sandbox-setup]";
/** The model the local Bonsai acceptance runs when none is named. */
const DEFAULT_BONSAI_MODEL = "bonsai-2:27b-pq2_0";
/** A plugin's picture is an image: an SVG among them draws, but runs and fetches nothing. */
const PLUGIN_ICON_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

/** What the user reads in the app's own dialogs, and why a start-up step refuses. */
const MESSAGE = {
  devLaunchRefused: "Developer launch requires a developer build and owned launch configuration",
  couldNotStart: "The studio could not start",
  quit: "Quit",
  linkNotOpened: "That link could not be opened",
  pluginUnavailable: "Plugin unavailable",
  quitDuringRun: "An unattended run is active. Quit and end it?",
  restartDuringRun: "An unattended run is active. Relaunch to update and end it?",
  restart: "Relaunch",
  keepRunning: "Keep running",
  quitWithResume: (time: string) => `A paused build will resume on its own at ${time}. Quit and cancel the resume?`,
  restartWithResume: (time: string) =>
    `A paused build will resume on its own at ${time}. Relaunch to update and cancel the resume?`,
  cancel: "Cancel",
  checkForUpdates: "Check for Updates…",
  download: "Download",
  later: "Later",
  ok: "OK",
  coreNotStarted: "the studio core has not started",
  noGameView: "the studio window has no game view",
  shutdownUnfinished: (steps: string[]) => `shutdown did not finish: ${steps.join(", ")}`,
  hydrationTimeout: "renderer hydration timeout",
  pageGone: (cause: string) => `studio window renderer gone (${cause})`,
  pageReloaded: (cause: string) => `The studio window stopped unexpectedly (${cause}) and was reloaded.`,
  pageKeepsStopping: (cause: string) => `The studio window keeps stopping (${cause}); it was not reloaded again.`,
  keepsCrashing: "The studio window keeps crashing",
  keepsCrashingDetail: "Work in progress continues in the background.",
  reload: "Reload",
  startTookTooLong: (minutes: number) =>
    `The protected workspace was still starting after ${minutes} minutes. Genex keeps trying and opens by itself if it finishes; Try again restarts Genex.`,
} as const;

const dirname = path.dirname(fileURLToPath(import.meta.url));
const distRoot = path.join(dirname, "..");

/**
 * Read-only app resources: the harness seed, the stable bootstrap, the game template, vendored
 * three.js. In a packaged build these are asar-*unpacked*, because the bootstrap is spawned as a
 * child process and the vendor files are served to the preview — neither works from inside an
 * archive. `__dirname` still points at the archive, so translate it.
 */
function resourcesDir(): string {
  const inArchive = path.join(distRoot, "resources");
  const marker = `app.asar${path.sep}`;
  return inArchive.includes(marker) ? inArchive.replace(marker, `app.asar.unpacked${path.sep}`) : inArchive;
}
const resources = resourcesDir();

// Squirrel's install, update and uninstall launches make or remove the shortcuts and exit before
// anything else runs: no profile, no window (main/windows-install.ts).
const squirrelStep = squirrelStartup(process.platform, process.argv, process.execPath);
if (squirrelStep) {
  await runSquirrelStep(squirrelStep, (file, args) =>
    spawn(file, args, { detached: true, stdio: "ignore", windowsHide: true }),
  );
  app.exit(0);
  // `app.exit` ends the process from the event loop; nothing below may run first.
  await new Promise<never>(() => {});
}
const workingDir = installedWorkingDir(process.platform, process.execPath, app.isPackaged);
if (workingDir) process.chdir(workingDir);
// Before any notification: Windows attributes toasts and taskbar entries by this id.
const userModelId = appUserModelId(process.platform, process.execPath, existsSync);
if (userModelId) app.setAppUserModelId(userModelId);

declare const __STUDIO_DEV_BUILD__: { checkout: string; buildId: string } | null;
const devLaunchConfig = flagValue(StudioFlag.DevLaunch);
const asksForDeveloper = process.argv.some((arg) => arg.startsWith(StudioFlag.Dev));
const developerBuildUnlaunched = Boolean(__STUDIO_DEV_BUILD__) && devLaunchConfig === undefined;
const developerLaunchUnbacked =
  asksForDeveloper && (!__STUDIO_DEV_BUILD__ || app.isPackaged || devLaunchConfig === undefined);
if (developerBuildUnlaunched || developerLaunchUnbacked) {
  console.error(MESSAGE.devLaunchRefused);
  app.exit(1);
}
/** The normal profile's data folder, read before a developer or test launch moves userData. */
const normalProfileData = app.getPath("userData");
const dev =
  devLaunchConfig !== undefined && __STUDIO_DEV_BUILD__
    ? (await import("./dev/launch-context.ts")).initializeLaunch(__STUDIO_DEV_BUILD__, devLaunchConfig)
    : null;
let devRuntime: Awaited<ReturnType<typeof import("./dev/runtime.ts").startRuntime>> | null = null;

// Must happen before `app.whenReady()`.
registerGameScheme([{ scheme: "studio-plugin", privileges: { standard: true, secure: true } }]);

const isSelfTest = hasFlag(StudioFlag.SelfTest);
/** Boots the real app (window, UI, harness) and reports whether it came up clean, then quits. */
const isSmoke = hasFlag(StudioFlag.Smoke);
for (const [name, value] of testLaunchChromiumSwitches({
  platform: process.platform,
  testLaunch: isSmoke || isSelfTest,
}))
  app.commandLine.appendSwitch(name, value);
for (const [name, value] of linuxSecretStorageSwitches({
  platform: process.platform,
  env: process.env,
  hasPasswordStoreSwitch: app.commandLine.hasSwitch("password-store"),
}))
  app.commandLine.appendSwitch(name, value);
// Controlled read gates for the isolated UI acceptance only; never populated in normal use.
const smokeReads: SmokeReadGates = {};
const ollamaHost = flagValue(StudioFlag.OllamaHost);
const testUserData =
  isSmoke || isSelfTest
    ? (flagValue(StudioFlag.UserData) ??
      // Windows' temp folder can be spelled with 8.3 names (RUNNER~1); the app's folders never are.
      longPath(mkdtempSync(path.join(app.getPath("temp"), isSmoke ? "studio-smoke-" : "studio-selftest-"))))
    : null;
const liveCredentialChecksAllowed = process.env.STUDIO_ALLOW_LIVE_CREDENTIAL_CHECKS === "1";
/** `--studio-eval-lane`: the eval lane this launch runs, checked before the launch writes anything. */
const evalLane = await openEvalLaneLaunch();
if (testUserData) {
  for (const [key, dir] of [
    ["userData", "electron"],
    ["sessionData", "session"],
  ] as const) {
    const target = path.join(testUserData, dir);
    mkdirSync(target, { recursive: true });
    app.setPath(key, target);
  }
}
// The normal profile carries its data over from the "AI Game Studio" folder before anything reads userData.
const userDataMigration = migrateLegacyUserData({
  appData: app.getPath("appData"),
  userData: app.getPath("userData"),
  appName: app.getName(),
  isolated: Boolean(dev || testUserData),
});
/** Where this launch keeps its core data: a developer profile's core, a test run's folder, or the real userData. */
const userDataRoot = dev?.core ?? testUserData ?? app.getPath("userData");
/** `userData/logs/studio.log`: main's errors, harness stderr, core lines and renderer console errors, redacted. */
const studioLog = openStudioLog(path.join(userDataRoot, "logs"), { home: app.getPath("home") });
const userDataMigrationLog = userDataMigrationLine(userDataMigration);
if (userDataMigrationLog) studioLog.write("main", userDataMigrationLog);
// An error nothing caught is logged, never a quit or Electron's modal box; developer and smoke
// launches also print it, where their runners read stderr.
installProcessHandlers(process, (source, line) => {
  studioLog.write(source, line);
  if (dev || isSmoke) console.error(`[${source}] ${line}`);
});
// Native crash dumps stay on this Mac, beside the log in this launch's own data; nothing is uploaded.
app.setPath("crashDumps", path.join(userDataRoot, "Crashpad"));
crashReporter.start({ uploadToServer: false });
// Fixture sessions must not probe the user's installed coding executables, even for version/help.
// Explicit live acceptance retains real discovery and remains a separate account-authorized gate.
const fixtureProviders = dev?.providers === DevProviders.Fixture;
const isolatedCodingDiscovery = Boolean(testUserData || fixtureProviders) && !liveCredentialChecksAllowed;
// The first-launch welcome: never in a test run, and in a fixture profile only for the first-launch fixture.
const welcomeFixture = !fixtureProviders || dev?.fixture === FixtureName.FirstLaunch;
const showsWelcome = !isSmoke && !isSelfTest && welcomeFixture;
configureCodingClis(
  path.join(userDataRoot, "engine-homes", "coding-clis.json"),
  [dev?.checkout ?? app.getAppPath(), dev?.games ?? path.join(app.getPath("home"), "AI Games")],
  // An isolated launch has a test folder or a developer profile, so the core root is one of them.
  isolatedCodingDiscovery
    ? { loginPath: "", home: testUserData ?? userDataRoot, env: { PATH: "" }, standardDirs: [] }
    : {},
);
const fixtureNativePolicy = fixtureProviders || isSmoke;
/**
 * Where Play talks to genex.games in this launch: genex.games itself, or a local or test copy that a
 * development profile names (`play/origins.ts`); never in a packaged app, and never in a fixture
 * launch, which answers Play from its own data.
 */
const playOrigin = playOrigins(process.env, dev !== null && !app.isPackaged && !fixtureNativePolicy);
// Human review is an explicit opt-in; automated fixture windows stay parked and unfocusable.
const interactiveFixture = process.env.STUDIO_FIXTURE_INTERACTIVE === "1";
const parkedFixtureWindow = isSmoke || (fixtureProviders && !interactiveFixture);
const rendererConsole: Array<{ level: string; message: string; source?: string; line?: number; at?: string }> = [];
let core: StudioCore | null = null;
/**
 * Share build metrics (Settings → Privacy): off by default, and silent in every developer and test
 * launch. Node's own fetch carries no cookies; Electron's session fetch would carry the profile's.
 */
const runSharing = createRunSharing({
  dir: path.join(userDataRoot, "run-sharing"),
  origin: runsOrigin(process.env),
  sends: launchSends({
    packaged: app.isPackaged,
    argv: process.argv,
    developerProfile: dev !== null,
    testData: testUserData !== null,
  }),
  fetch: (url, init) => globalThis.fetch(url, init),
  app: { version: app.getVersion(), platform: fieldPlatform(process.platform) },
  readFacts: async (ref) => (core ? readFinishedFacts(core.store, ref) : null),
});
/** Built with the core (it needs the plugins root and the app version); the Plugins dialog is its only caller. */
let marketplace: PluginMarketplace | null = null;
let window: BrowserWindow | null = null;
let preview: GamePreview | null = null;
/** The Live game's full screen in the current window. */
let gameScreen: GameFullScreen | null = null;
/** Play's catalog, made with the core: the dashboard's reads and the viewer's likes and tickets. */
let playCatalog: PlayGallery | null = null;
let playAccount: { people: PlayPeople; creators: CreatorStats; credits: GenexCredits; library: AssetLibrary } | null =
  null;
let gameLibrary: LibrarySharing | null = null;
let playManage: PlayManage | null = null;
/** The app's Genex account, made with the core: Play, Settings and Publish read it. */
let genexAccount: GenexAccount | null = null;
/** The fixture account a fixture launch is signed in to Genex as (`dev/fixture-people.ts`), if any. */
const fixtureGenexAccount = launchFixtureAccount(process.env.STUDIO_FIXTURE_GENEX_ACCOUNT, dev?.fixture);
/** Play's game viewer in the current window. */
let playView: PlayViewer | null = null;
/** Where startup stands for the window: Ready, or the sandbox setup screen with its Retry. */
const bootGate = createBootGate(
  process.platform,
  process.platform === StudioPlatform.Windows
    ? {
        installSandbox: installWindowsSandbox,
        setUpFailed: (err) => studioLog.write("main", `sandbox setup failed: ${errorMessage(err)}`),
      }
    : {},
);
/** The Windows and Linux window controls, in the theme's colours the renderer last sent. */
const windowControls = windowControlsPainter(process.platform);
// `keepAwake.held` doubles as the run-active signal for close/quit below.
const keepAwake = new KeepAwake(powerSaveBlocker);
/**
 * Holds the Mac awake while a paused build waits to resume on its own (`core/auto-resume.ts`): the
 * run's own hold ended when it settled, and an idle-sleeping Mac would resume only at the next wake.
 * Kept apart from `keepAwake`: a waiting resume has no preview to protect and must not hold back
 * an account change, so it is never the run-active signal.
 */
const resumeAwake = new KeepAwake(powerSaveBlocker);
/** The user already answered "Quit" to the active-run prompt — the re-entrant quit must not ask twice. */
let quitConfirmed = false;
/** The async quit prompt is on screen — a second Cmd+Q must not stack another one over it. */
let quitDialogOpen = false;
/** Notifications the updater showed, held until they close, or macOS loses the click handler with the collected object. */
const updateNotes = new Set<Notification>();
/** A downloaded update of the app: the window's restart prompt and the restart itself (./auto-update.ts). */
const updates = createUpdateAnnouncer({
  studioUp: () => core !== null,
  announce: (update) => pushUiEvent({ type: UiEvent.UpdateReady, payload: update }),
  notify: showUpdateNote,
  confirmRestart: confirmUpdateRestart,
  quitAndInstall: () => autoUpdater.quitAndInstall(),
  openRelease: (url) => void shell.openExternal(url),
});
/** Whether and how this launch updates: only a released build checks (./auto-update.ts). */
const updateDecision = autoUpdateDecision({
  enabled: AUTO_UPDATE_ENABLED,
  packaged: app.isPackaged,
  platform: process.platform,
  developerLaunch: Boolean(dev),
  testLaunch: isSmoke || isSelfTest,
  productName: app.getName(),
  systemPackages: process.platform === "linux" && installedFromGenexRepository(process.execPath, existsSync),
});
/** The installer's checks, watched from launch so Check for Updates never collides with one (./auto-update.ts). */
const installer = watchInstaller(autoUpdater);
/** Check for Updates, from Settings and the app menu; Linux's periodic check runs it too. */
const updateChecker = createUpdateChecker({
  decision: updateDecision,
  current: app.getVersion(),
  updates,
  askInstaller: () => installer.ask(),
  latestRelease: () => latestRelease({ repo: UPDATE_REPO, current: app.getVersion(), fetchImpl: net.fetch }),
});
const uiEvents: UiEvent[] = [];
const harnessLogBatch = new HarnessLogBatch((payload) => pushUiEvent({ type: UiEvent.HarnessLog, payload }));
/** The React build the renderer bundles (`scripts/renderer-build.mjs`). */
declare const __STUDIO_REACT__: "production" | "development";
const performanceIdentity = {
  platform: process.platform,
  arch: process.arch,
  isPackaged: app.isPackaged,
  react: __STUDIO_REACT__,
};
const performanceRecorder = new PerformanceRecorder(Boolean(dev) || hasFlag(StudioFlag.Diagnostics));
const loopMonitor = performanceRecorder.snapshot().enabled
  ? watchEventLoop((value) => studioLog.write("performance", JSON.stringify({ ...performanceIdentity, value })))
  : null;
performanceRecorder.mark("launch");
export const terminals = new TerminalService(
  () =>
    utilityProcess.fork(path.join(resources, "terminal/host.cjs"), [], {
      stdio: "ignore",
      serviceName: "Studio terminal",
    }) as TerminalHost,
  (event) => {
    const page = livePage();
    if (page) pushToRenderer(page, "studio:terminal", event);
  },
);
app.on("accessibility-support-changed", (_event, enabled) => {
  const page = livePage();
  if (page) pushToRenderer(page, "studio:terminal", { type: "accessibility", enabled });
});

let liveThreadStatus: ThreadStatusMap = {};
/** An eval-lane launch's view of the core's UI events (it digests the game its chat seeds); null otherwise. */
let evalLaneUiTap: ((event: UiEvent) => void) | null = null;
const { codexLogin, claudeLogin, openCodeLogin } = createLoginControllers({
  terminals,
  openExternal: (url) => shell.openExternal(url),
  subscription,
  pushUiEvent,
  onOpenCodeSignedIn: async () => {
    if (core?.engines.has(EngineId.OpenCode)) await core.engines.get(EngineId.OpenCode).refreshModels?.(true);
    pushUiEvent({ type: UiEvent.EnginesChanged, payload: { engine: EngineId.OpenCode } });
  },
  showCodexState: (state) => {
    preview?.setOccluded(state.visible);
    const page = livePage();
    if (page) pushToRenderer(page, "studio:codex-login", state);
  },
  showClaudeState: (state) => {
    const page = livePage();
    if (page) pushToRenderer(page, "studio:claude-login", state);
  },
});
// The person approved Genex on OpenRouter in the browser: the app comes forward to show it connected.
const openRouterLogin = createOpenRouterLogin({
  openExternal: (url) => shell.openExternal(url),
  onReturn: () => showExistingWindow(),
});

/** The studio window's page, while there is one alive to receive a push (not closed, not crashed). */
function livePage(): Electron.WebContents | null {
  if (!window || window.isDestroyed() || window.webContents.isCrashed()) return null;
  return window.webContents;
}

/** Brings a dead studio page back, for every way the person can ask to see the window again. */
function reviveCrashedWindow(): void {
  if (window && !window.isDestroyed() && window.webContents.isCrashed()) window.webContents.reload();
}

function subscription(id: string): SubscriptionEngine | null {
  if (!core?.engines.has(id)) return null;
  const engine = core.engines.get(id);
  if (engine instanceof ClaudeCodeEngine || engine instanceof CodexEngine) return engine;
  return null;
}

function pushUiEvent(event: UiEvent): void {
  evalLaneUiTap?.(event);
  if (event.type !== UiEvent.HarnessLog) harnessLogBatch.flush();
  if (event.type === UiEvent.HarnessStatus) {
    const all = event.payload?.all;
    if (all) liveThreadStatus = all;
  }
  if (event.type === UiEvent.HarnessState && event.payload?.state !== HarnessState.Ready) liveThreadStatus = {};
  performanceRecorder.push(event.type, event.payload);
  if (dev && event.type === UiEvent.HarnessLog) {
    uiEvents.push(event);
    if (uiEvents.length > UI_EVENT_BUFFER_MAX) uiEvents.shift();
  }
  const page = livePage();
  if (page) pushToRenderer(page, "studio:event", event);
  const finished = finishedBuildRef(event);
  if (finished) void runSharing.buildFinished(finished).catch((err) => studioLog.write("main", errorMessage(err)));
  // The contractor called its checkpoint tool: the moment is worth seeing, so Live's Reload says
  // the game changed (with the builder's note). It never reloads on its own: Live is the person's.
  if (event.type === UiEvent.DelegationCheckpoint) {
    const { project, cwd } = event.payload;
    const note = event.payload.note || null;
    void core?.checkpointPreview(project, cwd, note).catch(() => {});
  }
  keepAwake.observe(event);
}

/**
 * A failure the user must still find tomorrow: in the thread first, toast second. Falls back to
 * the studio thread when the intended one cannot take the append — the trace matters more than
 * its address.
 */
async function appendErrorDurably(threadId: string | undefined, message: string): Promise<void> {
  studioLog.write("main", message);
  if (!core) return;
  try {
    await core.append([{ type: EventKind.Error, message }], threadId ?? core.mainThread);
  } catch {
    await core.append([{ type: EventKind.Error, message }]).catch(() => {});
  }
}

/**
 * The eval lane an `--studio-eval-lane` launch runs and the core options it runs on, or null
 * without the switch. A refused launch (not a smoke, live without the opt-in, a root outside the
 * run's work folder, in ~/AI Games or the normal profile) exits here, before anything is written.
 */
async function openEvalLaneLaunch(): Promise<{ launch: EvalLaunch; coreOptions: EvalCoreOptions } | null> {
  const file = flagValue(StudioFlag.EvalLane);
  if (file === undefined) return null;
  const lane = await import("./smoke/eval-lane.ts");
  // Read before a test launch moves userData: the normal profile an eval must never touch.
  const normalUserData = app.getPath("userData");
  const userData = testUserData ?? normalUserData;
  const opened = await lane.openEvalLane({
    file: path.resolve(file),
    smoke: isSmoke,
    devLaunch: dev !== null,
    fixtureFlag: hasFlag(StudioFlag.EvalFixture),
    liveAllowed: liveCredentialChecksAllowed,
    userData,
    aiGames: path.join(app.getPath("home"), "AI Games"),
    defaultUserData: normalUserData,
  });
  if (opened.ok) return { launch: opened.launch, coreOptions: lane.evalCoreOptions(opened.launch, userData) };
  console.error(lane.evalLaunchRefusedLine(opened));
  app.exit(EVAL_LANE_EXIT.Refused);
  // `app.exit` ends the process from the event loop; nothing below may run first.
  return new Promise<never>(() => {});
}

/** Where games live and which engines run, by kind of launch. */
function launchCoreOptions(): Partial<ConstructorParameters<typeof StudioCore>[0]> {
  if (dev) {
    const chatFixture = isChatFixture(dev.fixture);
    return {
      gamesRoot: dev.games,
      executionPolicy: {
        allowedProjectRoot: dev.games,
        ...(fixtureProviders ? { runBackgroundImprovement: false } : {}),
      },
      ...(fixtureProviders
        ? {
            engines: fixtureEngines(
              chatFixture,
              dev.fixture === FixtureName.FirstLaunch ? FIRST_LAUNCH_STATUS : undefined,
            ),
          }
        : {}),
    };
  }
  // An eval lane: real engines (or the fixture ones), games in the run's own folder, no background work.
  if (isSmoke && evalLane) return evalLane.coreOptions;
  if (isSmoke)
    return {
      engines: [
        new OllamaEngine({ ...(ollamaHost ? { host: ollamaHost } : {}) }),
        ...fixtureEngines().filter((e) => e.id !== EngineId.Ollama),
      ],
      executionPolicy: { runBackgroundImprovement: false },
    };
  // Games live in a plain visible folder, not buried in Library — Finder should show them.
  return { gamesRoot: normalGamesFolder(app.getPath("home")) };
}

/**
 * Other Genex profiles' data no worker of this launch reaches: the normal profile's, and a developer
 * build's checkout's development profiles, each unless it is this launch's own.
 */
function otherProfiles(userData: string): string[] {
  const devProfiles = __STUDIO_DEV_BUILD__ ? [path.join(__STUDIO_DEV_BUILD__.checkout, ".studio-dev", "profiles")] : [];
  return [normalProfileData, ...devProfiles].filter((dir) => path.resolve(dir) !== path.resolve(userData));
}

/**
 * How agents look at app windows (`app_look`) and the macOS access it needs: a fixture profile
 * looks at the stub (nothing on this Mac), macOS the real windows, other systems answer that it is
 * macOS only for now.
 */
function appLookOptions(userData: string): Pick<StudioCoreOptions, "appLook" | "screenAccess"> {
  if (fixtureNativePolicy) return { appLook: stubAppLook() };
  if (process.platform !== "darwin") return { appLook: unsupportedAppLook() };
  const { scratch, engineHomes } = layoutFor(userData);
  const access = appLookAccess(engineHomes);
  return { appLook: macAppLook({ run: appLookRun, scratchDir: scratch, access: access.status }), screenAccess: access };
}

/** Computer control (cua-driver), made with the first core: one registry, stopped on quit. */
let desktop: DesktopControl | undefined;

async function createCore(userData: string): Promise<StudioCore> {
  desktop ??= createDesktopControl({ automated: isSmoke || isSelfTest, resources });
  // Smoke runs keep everything under their throwaway userData.
  const launch = launchCoreOptions();
  const studio: StudioCore = new StudioCore({
    renderGameCover,
    // Read at send time, once the core exists: Play's catalog and account hang off it.
    mentionSources: mentionSourcesFor(() => studio),
    ...(desktop ? { desktop } : {}),
    paths: { userData, resources },
    ...appLookOptions(userData),
    neverTouch: otherProfiles(userData),
    // The normal profile keeps its games outside its data: another launch's workers never reach them.
    neverTouchGames: normalGamesElsewhere(launch.gamesRoot, app.getPath("home")),
    ...launch,
    ...(ollamaHost ? { ollamaHost } : {}),
    // Electron's binary doubles as node for the harness child process.
    execPath: process.execPath,
    runAsNode: true,
    appVersion: app.getVersion(),
    markBoot: (step) => {
      performanceRecorder.mark(step);
      // Which step a slow start spent its time on, in every log a person can send.
      studioLog.write("main", `start: ${step} at ${Math.round(performance.now())} ms`);
      const next = startStepAfter(step);
      if (next) bootGate.progress(next);
    },
    onUiEvent: pushUiEvent,
    onAutoResumePending: (pending) => (pending ? resumeAwake.hold() : resumeAwake.release()),
    onLog: (line, stream) => {
      // stderr carries the harness's own errors and the core's `[core]`/`[host]` lines.
      if (stream === "stderr") studioLog.write("harness", line);
      // A smoke's runner reads only stderr: a harness that dies during boot says why there too.
      if (stream === "stderr" && isSmoke) console.error(`[harness] ${line}`);
      harnessLogBatch.push(line, stream);
    },
  });
  // The plugin-updates fixture's profile holds older plugins before the core reads its plugin store.
  if (fixtureProviders && dev?.fixture === FixtureName.PluginUpdates)
    await installOlderPlugins(studio.layout.engineHomes, resources);
  performanceRecorder.mark("core-start");
  await studio.init();
  performanceRecorder.mark("core-ready");
  wirePlugins(studio);
  // Local-only fork: a real launch connects the person's own model server (their LM Studio or
  // another local server) on its own, so the studio opens ready to build locally. Fixture and
  // smoke profiles stay offline by construction and never probe.
  if (!fixtureNativePolicy) void studio.connectLocalServer().catch(() => {});
  return studio;
}

/** The marketplace, reacquisition, scanning and optional debug log of the core's plugins. */
function wirePlugins(studio: StudioCore): void {
  const pluginsRoot = path.join(studio.layout.engineHomes, "plugins");
  // Fixture profiles are offline by construction: the index is never fetched, so a test run can
  // neither reach GitHub nor depend on what is published there. This fork is offline the same
  // way for every profile: the published catalog lives on a hosted service, and a local-only
  // studio installs plugins from local folders and repositories the person names instead.
  const market = new PluginMarketplace({
    root: pluginsRoot,
    studioVersion: app.getVersion(),
    offline: true,
  });
  marketplace = market;
  studio.plugins.reacquire = (info) => reacquirePlugin(studio, market, info, confirmInstall);
  // Code that is read again is scanned again: a restore or a hot reload never keeps an older verdict.
  studio.plugins.scan = (directory, manifest) => scanPackage(directory, manifest);
  // Genex's host tools use the real account or open the npm registry: native steps a fixture refuses.
  const hostTool = studio.plugins.hostTool;
  if (hostTool) studio.plugins.hostTool = gatedHostTool(hostTool, fixtureNativePolicy);
  if (process.env.STUDIO_PLUGIN_DEBUG === "1") {
    const logs = path.join(pluginsRoot, "logs");
    mkdirSync(logs, { recursive: true, mode: 0o700 });
    studio.plugins.debug = (id, line) => {
      try {
        appendFileSync(path.join(logs, `${id}.log`), `${new Date().toISOString()} ${line}\n`);
      } catch {}
    };
  }
}

const confirmInstall = confirmPluginInstall(requireCore, fixtureNativePolicy);

/** The started core; a plugin install is only ever confirmed after the core exists. */
function requireCore(): StudioCore {
  if (!core) throw new Error(MESSAGE.coreNotStarted);
  return core;
}

/** `~/AI Games`, as a human reads it — the renderer never sees absolute paths. */
function gamesRootLabel(root: string): string {
  const home = app.getPath("home");
  return root.startsWith(home) ? `~${root.slice(home.length)}` : root;
}

/** The developer window's title, which names the profile and the build it runs. */
function devWindowTitle(launch: NonNullable<typeof dev>): string {
  return `Genex Dev ${launch.profileId} · ${launch.manifest.buildId}`;
}

/** This launch's window title: a developer profile's, the smoke's, or Electron's default. */
function windowTitle(): { title?: string } {
  if (dev) return { title: devWindowTitle(dev) };
  if (isSmoke) return { title: "Genex Smoke" };
  return {};
}

/** A parked fixture window: unfocusable, off the taskbar and off every display. */
function parkedWindowOptions(): Electron.BrowserWindowConstructorOptions {
  if (!parkedFixtureWindow) return {};
  const terminalSmokeOnLinux = isSmoke && process.platform === "linux" && hasFlag(StudioFlag.TerminalSmoke);
  return { focusable: false, skipTaskbar: true, x: terminalSmokeOnLinux ? 0 : PARKED_WINDOW_X, y: 0 };
}

/** The studio window's options: its size, its platform's title bar, the preload and the sandboxed renderer. */
function studioWindowOptions(): Electron.BrowserWindowConstructorOptions {
  return {
    ...MAIN_WINDOW,
    backgroundColor: nativeTheme.shouldUseDarkColors ? WINDOW_BACKGROUND.dark : WINDOW_BACKGROUND.light,
    ...windowControls.chrome(),
    show: false,
    // Fixed-size acceptance must not depend on the current display's work-area height.
    ...(isSmoke ? { enableLargerThanScreen: true } : {}),
    ...parkedWindowOptions(),
    ...windowTitle(),
    webPreferences: {
      preload: path.join(distRoot, "preload", "preload.cjs"),
      ...(dev ? { backgroundThrottling: false } : {}),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  };
}

async function createWindow(studio: StudioCore): Promise<BrowserWindow> {
  const win = new BrowserWindow(studioWindowOptions());
  performanceRecorder.mark("window-created");
  win.on("unresponsive", () => studioLog.write("main", "studio window unresponsive"));
  attachPreviews(studio, win);
  attachPlay(studio, win);
  collectRendererConsole(win);
  keepLinksOutside(studio, win);
  if (dev) {
    const launch = dev;
    win.on("page-title-updated", (event) => {
      event.preventDefault();
      win.setTitle(devWindowTitle(launch));
    });
  }
  if (!parkedFixtureWindow && !dev) showAfterPaint(win);
  await win.loadFile(path.join(distRoot, "renderer", "index.html"));
  if (parkedFixtureWindow || dev) showWindow(win);
  watchWindowLifecycle(win);
  return win;
}

/**
 * The window a launch opens when the sandbox cannot start: the same renderer, which asks
 * `studio:boot` first and shows "Set up the protected workspace" with Retry. There is no core
 * behind it, so it has no game view and navigates nowhere.
 */
async function createSetupWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow(studioWindowOptions());
  // The window's own questions are answered only once it is the studio window, which its first
  // question can be before it has loaded.
  window = win;
  performanceRecorder.mark("window-created");
  win.on("unresponsive", () => studioLog.write("main", "studio window unresponsive"));
  collectRendererConsole(win);
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.on("closed", () => {
    if (window === win) window = null;
  });
  if (!parkedFixtureWindow && !dev) showAfterPaint(win);
  await win.loadFile(path.join(distRoot, "renderer", "index.html"));
  if (parkedFixtureWindow || dev) showWindow(win);
  return win;
}

/** The game view inside the studio window, and the factory for the facets' hidden ones. */
function attachPreviews(studio: StudioCore, win: BrowserWindow): void {
  const view = new GamePreview({
    gamesRoot: studio.layout.gamesRoot,
    vendorDir: path.join(resources, "vendor"),
    resolveRoot: (name) => studio.games.dirFor(name),
  });
  preview = view;
  studio.options.preview = view;
  // Pooled observation ports for parallel Autopilot facets. Captures are page-side
  // (__studio.capture() renders straight from the canvas), so the window needs no compositor
  // surface and stays genuinely hidden. The previous shown-but-parked windows (x=-4400)
  // resurfaced whenever macOS reshuffled displays or Mission Control ran — four ghost windows
  // on the user's desktop mid-run. Rendering is offscreen: a hidden window with a
  // normal compositor never fires requestAnimationFrame, whatever backgroundThrottling says,
  // so a game in it stood still — the computer-smoke fixture reported frame 0 after a
  // 600 ms W hold. Offscreen rendering paints the frames itself at 60 fps, so a worker's
  // window keeps simulating while the worker plays in it.
  const used = new Set<number>();
  studio.options.createHeadlessPreview = async () => {
    let slot = 1;
    while (used.has(slot)) slot++;
    used.add(slot);
    try {
      return createFacetPreview(studio, slot, () => used.delete(slot));
    } catch (error) {
      used.delete(slot);
      throw error;
    }
  };
  view.attachTo(win, { x: 0, y: 0, width: 0, height: 0 });
  // Live moves with the window's edge in the same frame; the renderer's next measurement refines it.
  const followWindow = (): void => {
    if (win.isDestroyed()) return;
    const [width = 0, height = 0] = win.getContentSize();
    view.followWindow({ width, height });
  };
  followWindow();
  win.on("resize", followWindow);
  view.setOccluded(codexLogin.snapshot().visible);
  wireGameSound(studio, win, view);
  gameScreen = wireGameFullScreen({ studio, win, view, boundsSeen: previewBoundsSeen });
}

/**
 * The app's Genex account for this core: the Genex plugin's account, kept while Genex is off, or a
 * fixture launch's own (signed in as the fixture account it asked for).
 */
function genexAccountFor(studio: StudioCore): GenexAccount {
  genexAccount ??= createGenexAccount({
    port: genexAccountPort(studio),
    openSignIn: (url) => openGenexPage(fixtureNativePolicy, url, playOrigin.web),
  });
  return genexAccount;
}

/**
 * What the app's Genex account rides on: a fixture launch's own, a development copy of genex.games'
 * own sign-in (the Genex plugin's token is genex.games' and the copy would refuse it), or the plugin's.
 */
function genexAccountPort(studio: StudioCore): GenexAccountPort {
  if (fixtureNativePolicy) return fixtureAccountPort(fixtureGenexAccount, Date.now);
  if (playOrigin.api !== PLAY_ORIGIN.api) {
    const request = networkRequest(globalThis.fetch, playOrigin.api);
    return devStandAccountPort({ request, now: Date.now, web: playOrigin.web });
  }
  return pluginAccountPort(studio.plugins);
}

/** Play's catalog for this core: genex.games over the network, or a fixture launch's own answers. */
function playCatalogFor(studio: StudioCore): PlayGallery {
  playCatalog ??= playGallery({
    request: fixtureNativePolicy ? fixturePlayRequest : networkRequest(globalThis.fetch, playOrigin.api),
    token: genexAccountFor(studio).token,
    now: Date.now,
    localImages: fixtureNativePolicy,
  });
  return playCatalog;
}

/**
 * Play's people, a creator's numbers and the Credits tab for this core, all on the Genex account:
 * genex.games over the network, or a fixture launch's own people and numbers.
 */
function playAccountFor(studio: StudioCore): NonNullable<typeof playAccount> {
  const account = genexAccountFor(studio);
  const deps: PeopleDeps = {
    request: fixtureNativePolicy ? fixturePlayRequest : networkRequest(globalThis.fetch, playOrigin.api),
    token: account.token,
    now: Date.now,
    localImages: fixtureNativePolicy,
    upload: fixtureNativePolicy ? fixtureUpload : networkUpload(globalThis.fetch),
    refused: account.refused,
    web: playOrigin.web,
  };
  // A 401 to a creator's numbers or the credits ends the sign-in as one to the account's own calls does.
  const counted = { ...deps, request: refusingRequest(deps.request, deps.refused) };
  playAccount ??= {
    people: playPeople(deps),
    creators: creatorStats(counted),
    credits: genexCredits(counted),
    // Save sends whole game files, so its upload waits longer than an avatar's.
    library: assetLibrary({
      ...counted,
      upload: fixtureNativePolicy ? fixtureUpload : networkUpload(globalThis.fetch, LIBRARY_UPLOAD_TIMEOUT_MS),
    }),
  };
  return playAccount;
}

/**
 * A published game's card menu for this core, on the Genex account: genex.games over the network,
 * or a fixture launch's own answers. A change makes the catalog and profiles read their games afresh.
 */
function playManageFor(studio: StudioCore): PlayManage {
  const account = genexAccountFor(studio);
  const request = fixtureNativePolicy ? fixturePlayRequest : networkRequest(globalThis.fetch, playOrigin.api);
  playManage ??= createPlayManage({
    // A 401 ends the sign-in as one to the account's own calls does.
    request: refusingRequest(request, account.refused),
    token: account.token,
    upload: fixtureNativePolicy ? fixtureUpload : networkUpload(globalThis.fetch),
    changed: () => {
      playCatalogFor(studio).forget();
      playAccountFor(studio).people.forgetProfiles();
    },
    localImages: fixtureNativePolicy,
  });
  return playManage;
}

/** The person's genex.games library joined with a game's files: Save, Share and Add for the Assets tab. */
function librarySharingFor(studio: StudioCore): LibrarySharing {
  gameLibrary ??= librarySharing({
    library: () => playAccountFor(studio).library,
    // Add and Save write into the game: only a game this launch's project policy allows.
    gameDir: async (project) => {
      const dir = studio.games.dirFor(project);
      await studio.assertProjectAllowed(dir);
      return dir;
    },
    webGame: async (project) => !(await studio.games.list()).find((game) => game.name === project)?.engine,
    assets: (project) => studio.projectAssets(project),
    readFile: (dir, file, maxBytes) => readAssetPreview(dir, file, [], maxBytes),
    manifest: (slug) => playCatalogFor(studio).assetManifest(slug),
    // A fixture launch never reaches the network: its downloads are the fixture's own files.
    download: fixtureNativePolicy ? fixtureDownload : networkDownload(globalThis.fetch),
    vendorModule: vendorAssetModule,
  });
  return gameLibrary;
}

/** A tile's picture file from the library: genex.games' asset hosts, or a fixture launch's own made-up file. */
function pictureFileFor(): LibraryPictureFile {
  // A fixture launch never reaches the network: its picture files are the fixture's own.
  return fixtureNativePolicy ? libraryPictureFile(fixtureDownload) : networkPictureFile(globalThis.fetch);
}

/** Where a message's @ tags come from: Play's catalog, the Genex account, its library and git (a fixture's stand-ins). */
function mentionSourcesFor(core: () => StudioCore): MentionSources {
  return {
    world: (slug) => playCatalogFor(core()).world(slug),
    me: async () => (await playAccountFor(core()).people.me())?.id ?? null,
    clone: fixtureNativePolicy ? fixtureClone : gitCloneCode,
    assetManifest: (slug) => playCatalogFor(core()).assetManifest(slug),
    addFromLibrary: async (project, generationId) =>
      (await librarySharingFor(core()).add(project, { generationId })).files,
  };
}

/** A Play game's public source as a new game of the person's own; answers its library name. */
function remixPlayGame(studio: StudioCore, world: PlayWorld): Promise<string> {
  return remixGame(world, {
    gamesRoot: () => studio.layout.gamesRoot,
    // A fixture launch never reaches the network: its copy is a local stand-in.
    clone: fixtureNativePolicy ? fixtureClone : gitClone,
    install: async (dir) => {
      await studio.builds.installGuarded({ project: world.slug, dir });
    },
    adopt: async (dir, title) =>
      (await studio.adoptProject(dir, { title, template: false, trustProjectSettings: false, guardScripts: true }))
        .name,
    build: async (name) => {
      const game = (await studio.games.list()).find((listed) => listed.name === name);
      if (game) await studio.builds.ensure({ project: name, dir: game.dir, shape: game.shape, guarded: true });
    },
    progress: (progress) => pushUiEvent({ type: UiEvent.PlayRemix, payload: { slug: world.slug, ...progress } }),
  });
}

/** The Mac's share menu (Messages, Mail, AirDrop…) for `url`, under the button at `at` when the renderer said where. */
function popShareMenu(url: string, at: PlayPoint | undefined): void {
  const win = window;
  if (!win || win.isDestroyed() || process.platform !== StudioPlatform.Mac) return;
  new ShareMenu({ urls: [url] }).popup({ window: win, ...at });
}

/** A Play game's comments on genex.games, as the Genex account (a fixture launch's own comments). */
function playCommentsFor(studio: StudioCore): PlayComments {
  const account = genexAccountFor(studio);
  return playComments({
    request: fixtureNativePolicy ? fixturePlayRequest : networkRequest(globalThis.fetch, playOrigin.api),
    token: account.token,
    now: Date.now,
    localImages: fixtureNativePolicy,
    me: async () => (await playAccountFor(studio).people.me())?.id ?? null,
  });
}

/** Play's full-screen viewer in `win`: a published game, the studio's bar over its top edge. */
function attachPlay(studio: StudioCore, win: BrowserWindow): void {
  playView = wirePlayViewer({
    win,
    gallery: playCatalogFor(studio),
    emit: (payload) => pushUiEvent({ type: UiEvent.PlayViewer, payload }),
    openExternal: (url) => {
      if (!fixtureNativePolicy) void openOutside(studio, win, url);
    },
    web: playOrigin.web,
    offline: fixtureNativePolicy ? { gamePage: fixtureGamePage } : null,
    micPreload: path.join(distRoot, "preload", "play-mic.cjs"),
    micStore: playMicStore(path.join(userDataRoot, "play-mic.json")),
    barPage: path.join(distRoot, "renderer", "play-bar.html"),
    barPreload: path.join(distRoot, "preload", "play-bar.cjs"),
    comments: playCommentsFor(studio),
  });
}

/**
 * Live is heard only while Genex is in front. ⌥⌘M reaches the renderer's own keydown, except
 * while the game has the keyboard: then the key arrives here, and the renderer, which owns the
 * switch, is asked to flip it.
 */
function wireGameSound(studio: StudioCore, win: BrowserWindow, view: GamePreview): void {
  const syncForeground = (): void => studio.previewForeground(!win.isDestroyed() && win.isFocused());
  win.on("focus", syncForeground);
  win.on("blur", syncForeground);
  syncForeground();
  const game = view.view?.webContents;
  if (game) onSoundShortcut(game, () => studio.emit(UiEvent.PreviewSoundToggle, { at: Date.now() }));
}

/** One facet's observation port, in its own hidden offscreen window and session partition. */
function createFacetPreview(studio: StudioCore, index: number, released: () => void): GamePreview {
  const facetWin = new BrowserWindow({
    width: FACET_WINDOW.width,
    height: FACET_WINDOW.height,
    skipTaskbar: true,
    focusable: false,
    show: false,
    backgroundColor: FACET_WINDOW.backgroundColor,
    fullscreenable: false,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  const port = new GamePreview({
    gamesRoot: studio.layout.gamesRoot,
    vendorDir: path.join(resources, "vendor"),
    partition: `game-preview-facet-${index}`,
    offscreen: true,
    // Builders, playtesters, reviewers and the lead all play the game here; only Live is heard.
    muted: true,
    resolveRoot: (name) => studio.games.dirFor(name),
  });
  port.attachTo(facetWin, { x: 0, y: 0, width: FACET_WINDOW.width, height: FACET_WINDOW.height });
  port.dispose = async () => {
    await port.destroy();
    if (!facetWin.isDestroyed()) facetWin.destroy();
    released();
  };
  // One lease at another size for a look (`preview.viewport`); null puts it back at the facet size.
  port.setViewSize = (size) => {
    if (facetWin.isDestroyed()) return;
    const { width, height } = size ?? FACET_WINDOW;
    // The window opened at FACET_WINDOW as its outer size, so a restore sets that, not the content.
    if (size) facetWin.setContentSize(width, height);
    else facetWin.setSize(width, height);
    port.setBounds({ x: 0, y: 0, width, height });
  };
  return port;
}

/** Collected before the first load so a renderer that fails on boot is diagnosable. */
function collectRendererConsole(win: BrowserWindow): void {
  win.webContents.on("console-message", (details) => {
    rendererConsole.push({
      level: String(details.level),
      message: details.message,
      source: details.sourceId,
      line: details.lineNumber,
      at: new Date().toISOString(),
    });
    if (rendererConsole.length > RENDERER_CONSOLE_MAX) rendererConsole.shift();
    if (details.level === "error")
      studioLog.write("renderer", `${details.message} (${details.sourceId}:${details.lineNumber})`);
  });
}

/**
 * A link in chat is a contractor's markdown, and this window is the studio's only UI: nothing
 * a report links to may replace it. A click opens outside the window — the browser, the
 * file's own app for a document in a game folder, or Finder for anything that could run — or
 * is refused in words, and the studio stays on screen, never navigated to a file that does not
 * exist and left black.
 */
function keepLinksOutside(studio: StudioCore, win: BrowserWindow): void {
  win.webContents.on("will-navigate", (event, url) => {
    event.preventDefault();
    void openOutside(studio, win, url);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    void openOutside(studio, win, url);
    return { action: "deny" };
  });
}

async function openOutside(studio: StudioCore, win: BrowserWindow, raw: string): Promise<void> {
  const problem = await openRoutedLink(studio, raw);
  if (!problem) return;
  rendererConsole.push({
    level: "warning",
    message: `link not opened: ${raw} — ${problem}`,
    source: "main",
    line: 0,
    at: new Date().toISOString(),
  });
  await dialog
    .showMessageBox(win, {
      type: "warning",
      message: MESSAGE.linkNotOpened,
      detail: `${raw}\n\n${problem}`,
    })
    .catch(() => {});
}

/** Open a link where its route says; the words of what went wrong, or "" when it opened. */
async function openRoutedLink(studio: StudioCore, raw: string): Promise<string> {
  const games = await studio.games.list().catch(() => []);
  const route = await routeStudioLink(raw, {
    projectDirs: [studio.layout.gamesRoot, ...games.map((game) => game.dir)],
  });
  if (route.action === "external")
    return shell.openExternal(route.url).then(
      () => "",
      (err: Error) => err.message,
    );
  if (route.action === "open-path") return shell.openPath(route.target);
  if (route.action === "reveal") {
    shell.showItemInFolder(route.target);
    return "";
  }
  return route.reason;
}

/** A parked fixture window shows without focus, a developer window at once, a normal one when painted. */
function showWindow(win: BrowserWindow): void {
  if (parkedFixtureWindow) {
    win.showInactive();
    return;
  }
  if (!dev) {
    win.once("ready-to-show", () => win.show());
    return;
  }
  win.show();
  if (fixtureProviders) app.focus({ steal: true });
}

function watchWindowLifecycle(win: BrowserWindow): void {
  // The preview's WebContentsView dies with its window — destroying it mid-run would blind (or
  // kill) every remaining evidence pass. While a run is active, close means hide. A real quit is
  // unaffected: before-quit releases the blocker before window close events fire. A restart into
  // an update closes the windows first, so once the person agreed to end the run, close closes.
  win.on("close", (event) => {
    if (!keepAwake.held || quitConfirmed) return;
    event.preventDefault();
    win.hide();
  });
  win.on("closed", () => {
    window = null;
    void codexLogin.dismiss();
    void claudeLogin.cancel();
    void terminals.dispose();
  });
  // A crashed renderer (out of memory an hour into a run, say) leaves an empty window while runs
  // carry on.
  // Reload it and leave a note in the Studio chat, but only a couple of times a minute, so a page
  // that crashes on load does not spin; past that the person decides.
  const reloads = createReloadPolicy();
  win.webContents.on("render-process-gone", (_event, details) => {
    void claudeLogin.cancel();
    void terminals.dispose();
    const decision = shutdownInProgress ? QUITTING : reloads.decide(details.reason);
    studioLog.write("main", `renderer gone: ${details.reason} (exit ${details.exitCode}); ${decision}`);
    if (decision === QUITTING) return;
    const step = pageRecovery(decision, { quitting: win.isDestroyed(), unattended: fixtureNativePolicy });
    recoverPage(win, `${details.reason}, exit code ${details.exitCode}`, step);
  });
  win.webContents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) {
      void claudeLogin.cancel();
      void terminals.dispose();
    }
  });
}

/**
 * A dead page, after the reload policy decided: reloaded with a note in the Studio chat, or — past
 * the budget — left with a note, and the person asked whether to reload or quit. The death is also
 * in the renderer console diagnostics, where smoke gates and owned sessions look for failures.
 */
function recoverPage(win: BrowserWindow, cause: string, step: PageRecovery): void {
  if (step === PageRecovery.Ignore) return;
  rendererConsole.push({
    level: "error",
    message: MESSAGE.pageGone(cause),
    source: "main",
    line: 0,
    at: new Date().toISOString(),
  });
  if (rendererConsole.length > RENDERER_CONSOLE_MAX) rendererConsole.shift();
  if (step === PageRecovery.Reload) {
    void appendErrorDurably(undefined, MESSAGE.pageReloaded(cause));
    win.webContents.reload();
    return;
  }
  void appendErrorDurably(undefined, MESSAGE.pageKeepsStopping(cause));
  if (step === PageRecovery.Ask) void askAfterCrashes();
}

/** Reload or Quit, once the page keeps dying. No parent window: a sheet on a dead window is invisible. */
async function askAfterCrashes(): Promise<void> {
  const { response } = await dialog.showMessageBox({
    type: "error",
    message: MESSAGE.keepsCrashing,
    detail: MESSAGE.keepsCrashingDetail,
    buttons: [MESSAGE.reload, MESSAGE.quit],
    defaultId: 0,
    cancelId: 0,
  });
  if (response === 1) app.quit();
  else reviveCrashedWindow();
}

/**
 * The last rectangle the renderer asked the native game view to take. Read only by the build
 * smoke, which proves a full-stage view (Builds, Assets, a plugin dialog) really hides the game
 * rather than merely drawing over it.
 */
export const previewBoundsSeen: PreviewBoundsRecord = { last: null };

/** Settings → Copy diagnostics: versions, paths, provider status and the log's tail, redacted. */
async function diagnosticsReport(studio: StudioCore): Promise<string> {
  return diagnosticsText(
    await gatherDiagnostics({
      app: { name: app.getName(), version: app.getVersion(), packaged: app.isPackaged },
      versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
      os: { platform: process.platform, arch: process.arch, release: os.release() },
      paths: { userData: userDataRoot, gamesRoot: studio.layout.gamesRoot, log: studioLog.file },
      performance: {
        ...performanceIdentity,
        ...performanceRecorder.snapshot(),
        loop: loopMonitor?.snapshot(),
        gpu: app.getGPUFeatureStatus(),
        processes: app.getAppMetrics(),
      },
      home: app.getPath("home"),
      harnessCalls: studio.host.pendingRpcs(),
      engines: () => studio.engines.describe(),
      logTail: (count) => studioLog.tail(count),
    }),
  );
}

/** Send feedback's report: this build and OS, the diagnostics report and the open chat's newest events. */
function feedbackSources(studio: StudioCore): FeedbackSources {
  return {
    app: { version: app.getVersion(), packaged: app.isPackaged },
    os: { platform: process.platform, release: os.release(), arch: process.arch },
    home: app.getPath("home"),
    diagnostics: () => diagnosticsReport(studio),
    chatEvents: (threadId, count) => studio.store.listEvents(threadId, { limit: count, tail: true }),
    fetch,
  };
}

/**
 * A report from the setup screen, before any core: this build and OS and the log's tail, with no
 * games folder, providers or chats to read yet.
 */
function bootFeedbackSources(): FeedbackSources {
  const studioApp = { name: app.getName(), version: app.getVersion(), packaged: app.isPackaged };
  const system = { platform: process.platform, release: os.release(), arch: process.arch };
  const diagnostics = async () =>
    diagnosticsText(
      await gatherDiagnostics({
        app: studioApp,
        versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
        os: system,
        paths: { userData: userDataRoot, gamesRoot: "", log: studioLog.file },
        home: app.getPath("home"),
        engines: async () => [],
        logTail: (count) => studioLog.tail(count),
      }),
    );
  return {
    app: { version: studioApp.version, packaged: studioApp.packaged },
    os: system,
    home: app.getPath("home"),
    diagnostics,
    chatEvents: async () => [],
    fetch,
  };
}

/** The coding-CLI installs Settings offers: busy while a sign-in, a run or a turn is under way. */
function cliInstalls(studio: StudioCore) {
  return createCliInstalls({
    // Electron's fetch, so the installer download goes through the system proxy.
    install: (provider) => installCodingCli(provider, { fetch: net.fetch }),
    busy: () => {
      const signingIn = isClaudeLoginActive(claudeLogin.snapshot()) || isCodexLoginActive(codexLogin.snapshot());
      return keepAwake.held || studio.budget.userInFlight > 0 || signingIn;
    },
    update: async (provider) => {
      const engine = studio.engines.get(provider);
      const selected = await engine.account?.();
      return studio.engines.maintain(provider, () => updateCodingCli(provider, selected?.cli.path));
    },
    found: async (provider) => {
      await subscription(provider)?.recheckLogin();
      await studio.engines.get(provider).refreshModels?.(true);
      return (await resolveCodingCli(provider, undefined, undefined, true)).status.state === CodingCliState.Ready;
    },
    pushUiEvent,
    log: (line) => studioLog.write("main", line),
  });
}

/** Every IPC channel, registered once per launch by its domain's registrar in `./ipc/`. */
/** The launch's engine checks, started, with every later list kept for the next launch (`engine-boot.ts`). */
function startEngineBoot(studio: StudioCore): EngineBoot {
  const boot = engineBoot({
    describe: () => studio.engines.describe(),
    file: path.join(userDataRoot, "engine-homes", "last-engines.json"),
    build: app.getVersion(),
    changed: () => pushUiEvent({ type: UiEvent.EnginesChanged, payload: {} }),
    log: (message) => studioLog.write("main", message),
  });
  studio.engines.onDescribed((list) => boot.remember(list));
  boot.start();
  return boot;
}

function registerIpc(studio: StudioCore, engines: EngineBoot): void {
  const handle = createIpcHandle(ipcMain, {
    fixture: fixtureNativePolicy,
    isStudioUi: isStudioWindow,
    isPlayBar: isPlayBarPage,
    performance: performanceRecorder,
  });
  registerPerformanceIpc(handle, performanceRecorder);
  // The renderer's bootstrap carries only a 600-event tail across all threads; one real run is
  // over a thousand events, so the morning review must be computed from the project's full log.
  const runSummaryReader = new RunSummaryReader(studio.store);
  registerTerminalIpc(handle, {
    core: studio,
    terminals,
    accessibilityEnabled: () => app.isAccessibilitySupportEnabled(),
    shellPath: async () => (await toolchain()).path,
    openExternal: (url) => shell.openExternal(url),
  });
  registerThreadsIpc(handle, {
    core: studio,
    engines,
    gamesRootLabel,
    threadStatus: () => liveThreadStatus,
    pushUiEvent,
    appendErrorDurably,
    smokeReads: isSmoke ? smokeReads : null,
    welcome: showsWelcome,
    developer: !app.isPackaged,
    playWeb: playOrigin.web,
  });
  registerMentionRetry(handle, studio);
  registerGamesIpc(handle, { core: studio, runSummaryReader, pushUiEvent });
  registerStorageIpc(handle, { core: studio });
  registerJobsIpc(handle, { core: studio, openExternal: (url) => shell.openExternal(url) });
  registerModelsIpc(handle, { core: studio, subscription, pushUiEvent, openRouterLogin });
  registerPreviewIpc(handle, {
    core: studio,
    preview: () => preview,
    previewBoundsSeen,
    fullScreen: { enter: () => gameScreen?.enter(), active: () => gameScreen?.active() ?? false },
  });
  registerRunsIpc(handle, { core: studio, runSummaryReader, keepAwake, pushUiEvent, appendErrorDurably });
  registerLearningIpc(handle, {
    core: studio,
    scriptedImprovementPass: fixtureProviders && dev?.fixture === FixtureName.StudioActivity,
    pushUiEvent,
  });
  registerSettingsIpc(handle, {
    core: studio,
    diagnostics: () => diagnosticsReport(studio),
    feedback: (payload) => sendFeedback(payload, feedbackSources(studio)),
    licenses: () => readLicenseTexts(resources),
  });
  registerRunSharingIpc(handle, { sharing: runSharing });
  registerPluginsIpc(handle, {
    core: studio,
    marketplace: () => marketplace,
    confirmInstall,
    fixtureNativePolicy,
    window: () => window,
  });
  registerPermissionsIpc(handle, { core: studio });
  registerSkillsIpc(handle, { core: studio, subscription, home: () => app.getPath("home") });
  registerMcpIpc(handle, { core: studio, fixtureNativePolicy });
  registerLoginIpc(handle, {
    claudeLogin,
    codexLogin,
    openCodeLogin,
    subscription,
    pushUiEvent,
    busy: () => keepAwake.held || (core?.budget.userInFlight ?? 0) > 0,
  });
  registerCliInstallIpc(handle, cliInstalls(studio));
  registerProjectsIpc(handle, { core: studio, window: () => window, gamesRootLabel, web: playOrigin.web });
  registerGenexAccountIpc(handle, { account: genexAccountFor(studio) });
  registerPlayIpc(handle, {
    gallery: playCatalogFor(studio),
    remix: (world) => remixPlayGame(studio, world),
    viewer: () => playView,
    ...playAccountFor(studio),
    manage: playManageFor(studio),
    web: playOrigin.web,
    share: popShareMenu,
  });
  const { library } = playAccountFor(studio);
  registerAssetLibraryIpc(handle, { library, sharing: librarySharingFor(studio), pictureFile: pictureFileFor() });
  registerNotificationsIpc(handle, {
    notifications: { isSupported: () => Notification.isSupported(), create: (options) => new Notification(options) },
    window: () => window,
    setDockBadge: (text) => app.dock?.setBadge(text),
    pushUiEvent,
  });
}

async function main(): Promise<void> {
  if (isSelfTest) {
    await runSelfTestAndExit();
    return;
  }
  if (!claimTheMac()) return;
  await app.whenReady();
  performanceRecorder.mark("app-ready");
  const bootHandle = createIpcHandle(ipcMain, { fixture: fixtureNativePolicy, isStudioUi: isStudioWindow });
  registerBootIpc(bootHandle, {
    gate: bootGate,
    report: (draft) => sendFeedback(draft, bootFeedbackSources()),
    setWindowControls: (controls) => windowControls.paint(window, controls),
    quit: () => app.quit(),
  });
  registerUpdateIpc(bootHandle, {
    updates,
    check: () => updateChecker.check(),
    // An unpackaged build reports Electron's version, so only a packaged one names its own.
    about: () => ({
      version: app.isPackaged ? app.getVersion() : null,
      platform: process.platform,
      arch: process.arch,
    }),
  });
  addCheckForUpdatesMenuItem();
  const started = await startStudio();
  if (isSmoke) {
    if (started) app.exit(await runSmokeLaunch(started));
    return;
  }
  // The setup screen checks too: a release that fixes the sandbox problem can arrive through it.
  checkForUpdates();
  if (!dev) app.on("activate", reopenWindow);
}

/** Is `event` from the studio window's own top frame (not a plugin page or a game)? */
function isStudioWindow(event: { sender: unknown; senderFrame: unknown }): boolean {
  return event.sender === window?.webContents && event.senderFrame === window?.webContents.mainFrame;
}

/** Whether an IPC call came from Play's bar layer's own page, over a game in the studio window. */
function isPlayBarPage(event: { sender: unknown; senderFrame: unknown }): boolean {
  const bar = window && !window.isDestroyed() ? playViewsOf(window)?.bar() : null;
  if (!bar || bar.webContents.isDestroyed()) return false;
  return event.sender === bar.webContents && event.senderFrame === bar.webContents.mainFrame;
}

/** A Dock click with no window open: the studio, or the setup screen while the sandbox waits. */
async function reopenWindow(): Promise<void> {
  // A window hidden by close-during-run still exists, so getAllWindows() is non-empty — the
  // Dock click must show that window, not silently do nothing.
  if (window) {
    if (!window.isVisible()) window.show();
    reviveCrashedWindow();
    return;
  }
  if (BrowserWindow.getAllWindows().length > 0) return;
  if (core) window = await createWindow(core);
  else if (bootGate.state().phase === BootPhase.SandboxSetup) window = await createSetupWindow();
}

/** Periodic update checks, only from a released build (./auto-update.ts). */
function checkForUpdates(): void {
  if (!updateDecision.start) return;
  const log = (line: string) => studioLog.write("update", line);
  // Linux from the Genex package repository: apt or dnf brings the next version.
  if (updateDecision.mode === UpdateMode.System) {
    log("updates come from the system's package manager");
    return;
  }
  if (updateDecision.mode === UpdateMode.Notify) {
    // Linux: ask GitHub now and every few hours; a newer release announces itself.
    const ask = () => void updateChecker.check().then((result) => log(`release check: ${result.status}`));
    ask();
    setInterval(ask, RELEASE_CHECK_INTERVAL_MS).unref();
    return;
  }
  startAutoUpdate({ log, downloaded: (releaseName) => updates.downloaded(releaseName) }).catch((err) =>
    log(errorMessage(err)),
  );
}

/**
 * Check for Updates… in the default menu: the app menu after About on macOS, Help elsewhere.
 * Electron's default menu stays as it is otherwise.
 */
function addCheckForUpdatesMenuItem(): void {
  const menu = Menu.getApplicationMenu();
  if (!menu) return;
  const host = process.platform === "darwin" ? menu.items[0] : menu.items.find((item) => item.role === "help");
  if (!host?.submenu) return;
  const item = new MenuItem({ label: MESSAGE.checkForUpdates, click: () => void answerUpdateCheck() });
  host.submenu.insert(process.platform === "darwin" ? 1 : host.submenu.items.length, item);
  Menu.setApplicationMenu(menu);
}

/** The menu's Check for Updates: ask, then say what it found and offer the one next step. */
async function answerUpdateCheck(): Promise<void> {
  const note = updateCheckNote(await updateChecker.check());
  const actLabel = note.act === UpdateAction.Download ? MESSAGE.download : MESSAGE.restart;
  const buttons = note.act ? [actLabel, MESSAGE.later] : [MESSAGE.ok];
  const { response } = await dialog.showMessageBox({ message: note.message, detail: note.detail, buttons });
  if (response !== 0 || !note.act) return;
  if (note.act === UpdateAction.Download) updates.download();
  else void updates.restart();
}

/** The updater's notification, before the studio's window can show the prompt; a click runs `onClick`. */
function showUpdateNote(note: { title: string; body: string }, onClick: () => void): void {
  if (!Notification.isSupported()) return;
  const shown = new Notification(note);
  updateNotes.add(shown);
  shown.on("close", () => updateNotes.delete(shown));
  shown.on("click", () => {
    updateNotes.delete(shown);
    onClick();
  });
  shown.show();
}

/**
 * What a quit (or, with `relaunch`, a restart into an update) asks first, or null when it loses
 * nothing: an active run ends, or a paused build's planned automatic resume is dropped.
 */
function quitPrompt(relaunch: boolean): { message: string; keep: string } | null {
  const resumeAt = core?.autoResumeAt ?? null;
  const question = quitQuestion({ runActive: keepAwake.held, resumeAt, confirmed: quitConfirmed });
  if (question === QuitQuestion.RunActive)
    return { message: relaunch ? MESSAGE.restartDuringRun : MESSAGE.quitDuringRun, keep: MESSAGE.keepRunning };
  if (question !== QuitQuestion.ResumePending || resumeAt === null) return null;
  const time = new Date(resumeAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return { message: relaunch ? MESSAGE.restartWithResume(time) : MESSAGE.quitWithResume(time), keep: MESSAGE.cancel };
}

/**
 * Before a restart into an update: an active run ends only on the person's word, as on a quit.
 * Their yes also lets the window close rather than hide (`watchWindowLifecycle`), which the
 * install waits on. No parent window, like the quit prompt; a Cmd+Q meanwhile is not stacked.
 */
async function confirmUpdateRestart(): Promise<boolean> {
  const prompt = quitPrompt(true);
  if (!prompt) return true;
  if (quitDialogOpen) return false;
  quitDialogOpen = true;
  try {
    const { response } = await dialog.showMessageBox({
      type: "warning",
      message: prompt.message,
      buttons: [MESSAGE.restart, prompt.keep],
      defaultId: 1,
      cancelId: 1,
    });
    if (response !== 0) return false;
    quitConfirmed = true;
    return true;
  } finally {
    quitDialogOpen = false;
  }
}

/** Headless verification path — see tests/e2e. */
async function runSelfTestAndExit(): Promise<void> {
  await app.whenReady();
  performanceRecorder.mark("app-ready");
  const { runSelfTest } = await import("./smoke/selftest.ts");
  const code = await runSelfTest({ resources, userData: testUserData ?? userDataRoot });
  app.exit(code);
}

/**
 * One studio per Mac. Two instances share one userData: the second corrupts the first's
 * event store and doubles the harness — a stale twin caused both the "No handler registered"
 * run and the two-contractors-in-one-folder collision. (Smoke runs use their own userData
 * and may run alongside a real instance.) False when another instance already has it.
 */
function claimTheMac(): boolean {
  const claimsTheLock = !isSmoke && !dev;
  if (claimsTheLock && !app.requestSingleInstanceLock()) {
    app.exit(0);
    return false;
  }
  if (!dev) app.on("second-instance", showExistingWindow);
  return true;
}

function showExistingWindow(): void {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  // Launching the studio again is a request to see it — a window hidden by close-during-run
  // would otherwise take the focus() invisibly.
  if (!window.isVisible()) {
    window.show();
  }
  window.focus();
  reviveCrashedWindow();
}

/** What a started studio hands the smoke runners. */
interface StartedStudio {
  core: StudioCore;
  window: BrowserWindow;
  preview: GamePreview;
}

/**
 * Core, IPC, window, harness and (for a developer launch) the dev runtime. Null when the window
 * opened on the sandbox setup screen instead (its Retry finishes the start), or after a failed
 * start exits.
 */
async function startStudio(): Promise<StartedStudio | null> {
  // The sandbox-setup fixture shows the screen over a real, ready core; its Retry just opens it.
  if (showsFixtureSetup()) bootGate.hold(FIXTURE_SANDBOX_PROBLEM, async () => {});
  if (opensWhileStarting()) openStartWindow();
  const studio = await coreOrSetup();
  return studio ? launchStudio(studio) : null;
}

/** The sandbox-setup fixture, which holds a ready core on the setup screen. */
function showsFixtureSetup(): boolean {
  return fixtureProviders && dev?.fixture === FixtureName.SandboxSetup;
}

/** A Windows launch a person watches: its core starts slowly enough to need a window first. */
function opensWhileStarting(): boolean {
  return process.platform === StudioPlatform.Windows && !dev && !isSmoke;
}

/**
 * Open the window before the core: on Windows its start can take most of a minute (the protected
 * workspace checks the network and sets folder access), and with no window there was nothing on
 * screen. The window says which step the start is on until the studio's own window replaces it,
 * or turns into the setup screen.
 */
function openStartWindow(): void {
  bootGate.starting(StartStep.Games);
  createSetupWindow().catch((err) => studioLog.write("main", `start window: ${errorMessage(err)}`));
  setTimeout(startTookTooLong, START_TIMEOUT_MS).unref();
}

/**
 * A start still running at {@link START_TIMEOUT_MS}: the window shows it as failed, with Try again
 * (which restarts Genex: the running start cannot be taken back), a report and Quit. The start goes
 * on, and a studio that comes up still replaces the window.
 */
function startTookTooLong(): void {
  const { step } = bootGate.state();
  const shown = bootGate.overdue(MESSAGE.startTookTooLong(START_TIMEOUT_MS / MINUTE_MS), async () => {
    app.relaunch();
    app.exit(0);
  });
  if (shown) studioLog.write("main", `start still running after ${START_TIMEOUT_MS / SECOND_MS} s (${step})`);
}

/** Load the window again for a new boot state: one showing a failure no longer asks main. */
async function reshowBoot(): Promise<void> {
  if (window && !window.isDestroyed()) await window.loadFile(path.join(distRoot, "renderer", "index.html"));
}

/**
 * The started core, or null: when the sandbox cannot start, the window opens on the setup screen;
 * any other failure reports and exits. Smoke and developer launches fail as before, because their
 * runners read the failure from stderr and wait on a studio that never comes (the sandbox-setup
 * fixture shows the screen instead).
 */
async function coreOrSetup(): Promise<StudioCore | null> {
  try {
    return await createCore(userDataRoot);
  } catch (err) {
    const showsSetup = err instanceof SandboxUnavailableError && !isSmoke && !dev;
    if (showsSetup) await openSandboxSetup(err.problem);
    else if (opensWhileStarting()) await showCoreFailure(err);
    else failStartup(err);
    return null;
  }
}

/**
 * Hold startup on "Set up the protected workspace"; Retry runs {@link retryStartup}. On Windows the
 * window starts Set up by itself, so a person sees "Setting up Genex" and the administrator prompt.
 */
async function openSandboxSetup(problem: SandboxProblem): Promise<void> {
  studioLog.write("main", `sandbox unavailable: ${problem.code} ${problem.details.join("; ")}`);
  const shownFailed = bootGate.state().phase === BootPhase.Failed;
  bootGate.hold(problem, retryStartup);
  // The window opened for the start asks again until the start ends, and shows the setup screen;
  // one already showing the start as failed (it took too long) has stopped asking.
  if (window && !window.isDestroyed()) {
    if (shownFailed) await reshowBoot();
    return;
  }
  window = await createSetupWindow();
}

/**
 * A watched start whose core failed for a reason other than the sandbox: the window shows it with
 * Try again (the core's start again), a report and Quit, instead of an error box that quits.
 */
async function showCoreFailure(err: unknown): Promise<void> {
  logStartupFailure(err);
  bootGate.fail(errorMessage(err), retryStartup);
  await reshowBoot();
}

/**
 * Retry from the setup screen: start the core again. A sandbox still unavailable throws back to
 * the gate, which shows the new problem; once it starts, the studio window replaces the setup one.
 */
async function retryStartup(): Promise<void> {
  await launchStudio(await createCore(userDataRoot));
}

/** Report a start-up failure and quit, as a launch always has for anything but the sandbox. */
function failStartup(err: unknown): void {
  reportStartupFailure(err);
  app.exit(1);
}

/**
 * The asset-library fixture's window gets its library's files (a tile's picture, a sound it plays)
 * from the fixture, so no socket opens for them; every other https request goes out as usual. Any
 * other launch leaves https alone.
 */
function serveFixtureLibraryFiles(): void {
  if (!fixtureProviders || dev?.fixture !== FixtureName.AssetLibrary) return;
  protocol.handle(
    "https",
    async (request) =>
      (await fixtureFileResponse(request.url)) ?? net.fetch(request, { bypassCustomProtocolHandlers: true }),
  );
}

/** Wire a started core into the app: its IPC, the window, the harness and any developer fixture. */
async function launchStudio(studio: StudioCore): Promise<StartedStudio | null> {
  const userData = userDataRoot;
  try {
    core = studio;
    // The update-ready fixture shows the window's restart prompt; nothing was downloaded.
    if (fixtureProviders && dev?.fixture === FixtureName.UpdateReady) updates.downloaded(FIXTURE_UPDATE_RELEASE);
    protocol.handle("studio-plugin", (request) => servePluginPanel(studio, request));
    serveFixtureLibraryFiles();
    const fixture = fixtureProviders && dev ? await prepareFixture(studio, dev.fixture) : null;
    // The engine checks take seconds: they start now, beside the window, and the window opens on
    // the engines the last launch checked. After a fixture's engines are in place.
    const engines = startEngineBoot(studio);
    registerIpc(studio, engines);
    // The studio's window asks first thing: it opens on the studio, not on the screen before it.
    if (!showsFixtureSetup()) bootGate.ready();
    const before = window;
    const win = await createWindow(studio);
    window = win;
    // The start or setup window this launch opened first gives way to the studio's.
    if (before && before !== win && !before.isDestroyed()) before.destroy();
    // First launch opens on an empty library, with no game chat to select.
    if (fixture?.project) await seedFixtureModel(win, fixture.threadId);
    const booted = await startHarness(studio);
    if (!booted) return null;
    if (fixture) await activateChatFixture(studio, fixture);
    if (fixture?.project) await openFixtureGame(win, fixture.project);
    announceReady(userData);
    showFixtureAgentsFailure(userData);
    const view = requirePreview();
    if (dev && __STUDIO_DEV_BUILD__) devRuntime = await startDevRuntime(dev, studio, win, view);
    return { core: studio, window: win, preview: view };
  } catch (err) {
    failStartup(err);
    return null;
  }
}

/** The studio is up: the window hears it, the log says so, and rows a closed app left unsent go. */
function announceReady(userData: string): void {
  pushUiEvent({ type: UiEvent.StudioReady, payload: { userData } });
  studioLog.write("main", `studio ready at ${Math.round(performance.now())} ms`);
  // Rows a closed app left unsent go now, or are dropped once a week old.
  void runSharing.flush().catch((err) => studioLog.write("main", errorMessage(err)));
}

/** The agents-start-failed fixture: a started studio shows the agents' line, and its Try again just clears it. */
function showFixtureAgentsFailure(userData: string): void {
  if (!fixtureProviders || dev?.fixture !== FixtureName.AgentsStartFailed) return;
  showAgentsFailure(FIXTURE_AGENTS_FAILURE, async () => announceReady(userData));
}

/** The game view `createWindow` attached; every started window has one. */
function requirePreview(): GamePreview {
  if (!preview) throw new Error(MESSAGE.noGameView);
  return preview;
}

async function servePluginPanel(studio: StudioCore, request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (url.pathname === `/${PLUGIN_ICON_PATH}`) return await servePluginIcon(studio, url.hostname);
    const panel = await studio.plugins.panel(url.hostname, url.pathname.slice(1));
    return new Response(panel.html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": PLUGIN_PANEL_CSP,
      },
    });
  } catch {
    return textResponse(HttpStatus.NotFound, MESSAGE.pluginUnavailable);
  }
}

/** A plugin's picture, as an image only: navigated to, it runs nothing and is never sniffed as anything else. */
async function servePluginIcon(studio: StudioCore, id: string): Promise<Response> {
  const icon = await studio.plugins.icon(id);
  if (!icon) return textResponse(HttpStatus.NotFound, MESSAGE.pluginUnavailable);
  return new Response(new Uint8Array(icon.bytes), {
    headers: {
      "Content-Type": icon.type,
      "Content-Security-Policy": PLUGIN_ICON_CSP,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** Give the fixture's game thread its fixture model, then reload so the renderer reads it. */
async function seedFixtureModel(win: BrowserWindow, threadId: string): Promise<void> {
  await win.webContents.executeJavaScript(
    `localStorage.setItem(${JSON.stringify(`studio.model.${threadId}`)},'codex::fixture-v1')`,
  );
  await win.loadFile(path.join(distRoot, "renderer/index.html"));
}

/**
 * A fixture session begins in its game: every launch opens home, so the fixture opens the game
 * from the sidebar as a person would, and waits until the window shows it (or the sandbox setup,
 * which has no games). A game that never opens fails the launch, as a broken fixture should.
 */
async function openFixtureGame(win: BrowserWindow, project: string): Promise<void> {
  const row = `nav [data-project=${JSON.stringify(project)}]`;
  await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const until = Date.now() + ${FIXTURE_OPEN_TIMEOUT_MS};
    let clicked = false;
    const tick = () => {
      const shell = document.querySelector("[data-studio-state]");
      if (shell && shell.dataset.room === "build" && shell.dataset.project === ${JSON.stringify(project)}) return resolve(true);
      // A window held on the sandbox setup has no games to open.
      if (document.querySelector("[data-sandbox-setup]")) return resolve(false);
      const button = document.querySelector(${JSON.stringify(row)});
      if (button && !clicked) {
        clicked = true;
        button.click();
      }
      if (Date.now() > until) return reject(new Error("the fixture game did not open"));
      setTimeout(tick, ${FIXTURE_OPEN_POLL_MS});
    };
    tick();
  })`);
}

/**
 * Boot the harness; false when it would not, and the studio's sidebar says so. A developer or smoke
 * launch throws, as its runner reads the failure from stderr.
 */
async function startHarness(studio: StudioCore): Promise<boolean> {
  try {
    // start() already rewinds a self that cannot boot and retries; this is what is left after that.
    await studio.start();
    return true;
  } catch (err) {
    if (dev || isSmoke) throw err;
    showAgentsFailure(errorMessage(err), async () => {
      await studio.start();
      announceReady(userDataRoot);
    });
    return false;
  }
}

/**
 * The studio's window is open, so it stays: the games and Play work without the harness, and the
 * sidebar says the agents didn't start, with Try again (`retry`) and a report. On Windows the
 * harness waits on a sandbox that starts behind the open window, so this can come a minute after
 * the window opened. A Try again that fails shows its own words.
 */
function showAgentsFailure(failure: string, retry: () => Promise<void>): void {
  studioLog.write("main", `harness would not start: ${failure}`);
  bootGate.agentsFailed(failure, retry);
  pushUiEvent({ type: UiEvent.HarnessStartFailed, payload: { failure } });
}

/** The developer runtime, once the renderer shows its threads. */
async function startDevRuntime(
  launch: NonNullable<typeof dev>,
  studio: StudioCore,
  win: BrowserWindow,
  view: GamePreview,
): Promise<NonNullable<typeof devRuntime>> {
  await waitForHydration(win);
  return (await import("./dev/runtime.ts")).startRuntime(
    launch,
    studio,
    win,
    view,
    () => rendererConsole,
    () => uiEvents.filter((e) => e.type === UiEvent.HarnessLog).slice(-200),
    signInOnScreen,
    async () => {
      const failed = await runShutdown(quitSteps(), { log: studioLog.write });
      if (failed.length) throw new Error(MESSAGE.shutdownUnfinished(failed));
    },
    () => ({ ...performanceIdentity, ...performanceRecorder.snapshot(), loop: loopMonitor?.snapshot() }),
  );
}

async function waitForHydration(win: BrowserWindow): Promise<void> {
  const until = Date.now() + HYDRATION_TIMEOUT_MS;
  while (!(await win.webContents.executeJavaScript(`!!document.querySelector(${JSON.stringify(HYDRATED)})`))) {
    if (Date.now() > until) throw new Error(MESSAGE.hydrationTimeout);
    await sleep(HYDRATION_POLL_MS);
  }
}

/** A Codex sign-in sheet or a live Claude sign-in terminal is on screen. */
function signInOnScreen(): boolean {
  return (
    codexLogin.snapshot().visible ||
    terminals.list().some((session) => session.kind === TerminalKind.ClaudeLogin && session.phase !== "exited")
  );
}

/** Write a start-up failure to the log. */
function logStartupFailure(err: unknown): void {
  studioLog.write("main", `startup failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
}

function reportStartupFailure(err: unknown): void {
  logStartupFailure(err);
  if (dev || isSmoke) {
    console.error("Fixture/development startup failed", err);
    console.error("Renderer startup diagnostics", JSON.stringify(rendererConsole.slice(-20)));
    return;
  }
  dialog.showErrorBox(MESSAGE.couldNotStart, (err as Error).stack ?? String(err));
}

/** The smoke, or one of the acceptance runs its flags choose; the exit code. */
async function runSmokeLaunch(started: StartedStudio): Promise<number> {
  const smokeUserData = testUserData ?? userDataRoot;
  if (evalLane) {
    const { evalCliVersions, runEvalLane, SYSTEM_CLOCK, threadBoundListeners } = await import("./smoke/eval-lane.ts");
    const bound = threadBoundListeners();
    evalLaneUiTap = bound.push;
    const deps = { cliVersions: evalCliVersions(evalLane.launch), onThreadBound: bound.onThreadBound };
    return stopAfter(started.core, runEvalLane(started.core, evalLane.launch.spec, SYSTEM_CLOCK, deps));
  }
  if (hasFlag(StudioFlag.TerminalSmoke)) {
    const { runTerminalAcceptance } = await import("./smoke/terminal-acceptance.ts");
    return stopAfter(started.core, runTerminalAcceptance(terminals, started.window, smokeUserData));
  }
  const providerRoot = flagValue(StudioFlag.ProviderAcceptance);
  if (providerRoot) {
    const { runProviderAcceptance } = await import("./smoke/provider-acceptance.ts");
    return stopAfter(started.core, runProviderAcceptance(started.core, path.resolve(providerRoot)));
  }
  const localRoot = flagValue(StudioFlag.BonsaiAcceptance);
  if (localRoot) {
    const { runBonsaiAcceptance } = await import("./smoke/bonsai-acceptance.ts");
    const model = flagValue(StudioFlag.BonsaiModel) ?? DEFAULT_BONSAI_MODEL;
    return stopAfter(started.core, runBonsaiAcceptance(started.core, started.preview, path.resolve(localRoot), model));
  }
  const { runSmoke } = await import("./smoke/run-smoke.ts");
  return runSmoke({
    ...started,
    testUserData: smokeUserData,
    resources,
    isolatedCodingDiscovery,
    developmentController: Boolean(__STUDIO_DEV_BUILD__ || dev || devRuntime),
    rendererConsole,
    smokeReads,
    previewBoundsSeen,
    pushUiEvent,
    keepAwakeHeld: () => keepAwake.held,
  });
}

/** An acceptance run's exit code, after the core it drove has stopped. */
async function stopAfter(studio: StudioCore, run: Promise<number>): Promise<number> {
  const code = await run;
  await studio.stop();
  return code;
}

app.on("window-all-closed", () => {
  if (quitsWhenLastWindowCloses({ platform: process.platform, testLaunch: isSmoke || isSelfTest })) app.quit();
});

let shutdownInProgress = false;

/**
 * What quitting stops, in order (`app-lifecycle.ts`). Each step is bounded (`runShutdown`), so a
 * sign-in, terminal or core that throws or hangs is logged and passed over, and the app still
 * exits; the harness is stopped first and, failing that, killed last.
 */
function quitSteps(): ShutdownStep[] {
  return shutdownSteps({ keepAwake, codexLogin, claudeLogin, terminals, core });
}

// Nothing drives the person's computer once the studio is going away.
app.on("will-quit", () => {
  void desktop?.stopAll();
});

app.on("before-quit", async (event) => {
  harnessLogBatch.flush();
  if (devRuntime) {
    event.preventDefault();
    await devRuntime.stop();
    return;
  }
  // A quit mid-run ends the run silently — it must be an explicit choice. preventDefault
  // lands before the first await, or the quit proceeds regardless. The dialog is async: a sync
  // dialog blocks the main-process event loop, and the harness's calls into main stall for as
  // long as the prompt sits unanswered — pausing the very run the prompt is protecting.
  // No parent window: the window may be hidden, and a sheet on a hidden window is invisible.
  // A paused build waiting to resume on its own is asked about too: the quit drops the resume.
  const prompt = quitPrompt(false);
  if (prompt) {
    event.preventDefault();
    if (quitDialogOpen) return;
    quitDialogOpen = true;
    try {
      const { response } = await dialog.showMessageBox({
        type: "warning",
        message: prompt.message,
        buttons: [MESSAGE.quit, prompt.keep],
        defaultId: 1,
        cancelId: 1,
      });
      if (response === 0) {
        quitConfirmed = true;
        app.quit();
      } else reviveCrashedWindow();
    } finally {
      quitDialogOpen = false;
    }
    return;
  }
  event.preventDefault();
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  // Every later Cmd+Q returns above, so this exit must be reached whatever a step does.
  try {
    await runShutdown(quitSteps(), { log: studioLog.write });
  } finally {
    studioLog.close();
    app.exit(0);
  }
});

void main();
