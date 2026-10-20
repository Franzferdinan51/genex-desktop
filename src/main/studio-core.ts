/**
 * Studio core — the substrate assembled.
 *
 * Everything the agent can reach goes through the method table built in {@link StudioCore.api}.
 * That table *is* the containment boundary: the harness has no filesystem authority beyond its
 * sandbox, no process spawning of its own, and no way to write the event log except through an
 * append that we head-check. The table's handlers live in `./harness-rpc/`, one module per
 * namespace; the work behind them lives in the services under `./core/` (previews, delegation,
 * recovery, self-improvement, plugin tools, conversation, assets, game threads), which the core
 * composes and hands its shared state through {@link CoreInternals}. This file keeps the
 * lifecycle (init, start, stop), the event log's front door, settings and the public surface.
 *
 * Deliberately free of Electron imports so the whole core can be exercised under plain node; the
 * preview is injected through {@link PreviewPort}.
 */
import type { ChildProcess } from "node:child_process";
import { cp, lstat, mkdtemp, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sandboxBesidePlugins } from "./core/boot-side-by-side.ts";
import { assistAvailable, coreAssistHost, engineAssist } from "./core/desktop-assist.ts";
import type { DesktopControl } from "./core/desktop-control.ts";
import type { MentionSources } from "./core/mention-tags.ts";
import type { BuildPreviewRequest } from "../shared/build-preview.ts";
import { deliveryFolderFor, ignoreLine, webFolderOf } from "../shared/project-workspace.ts";
import { DEFAULT_BUILDERS, LEAD_WINDOWS } from "../shared/builders.ts";
import type { ConnectionSnapshot } from "../shared/connections.ts";
import type { BackdropShaderRequest, BackdropShaderResult } from "../shared/backdrop-shader.ts";
import type { GameLocation, GameName, GameNameRequest, PlayEngine } from "../shared/game-project.ts";
import { StudioPlatform } from "../shared/boot.ts";
import type { GameSoundRequest } from "../shared/game-sound.ts";
import { latestRun } from "../shared/coordinator.ts";
import { validateCoverSurface } from "../shared/cover-shader.ts";
import { coverLookName, coverRecipeFromTool } from "../shared/cover-recipe.ts";
import { CustomEvent, customEventData } from "../shared/custom-events.ts";
import { MINUTE_MS, SECOND_MS } from "../shared/duration.ts";
import { EngineStatusCode } from "../shared/engine-descriptor.ts";
import { LocalServerKind } from "../shared/local-server.ts";
import { errorMessage } from "../shared/errors.ts";
import { EventKind, ThreadKind, SnapshotScope } from "../shared/event-log.ts";
import { assetKind, isAudioFile, type AssetDeliveredPayload } from "../shared/game-assets.ts";
import { coverFromBrief, replaceableCover, type GameUpdate } from "../shared/game-library.ts";
import type { HarnessHostHandlers, HarnessParams, HarnessResult, HostMethod } from "../shared/harness-api.ts";
import {
  type ExportReview,
  type PluginBinding,
  PluginCapability,
  type PluginClipAnswer,
  type PluginClipOrder,
  type PluginStillAnswer,
  type PluginStillOrder,
  PluginToolAudience,
  NativeRuntimeState,
} from "../shared/plugins.ts";
import { EngineHostAction, type EngineLinkUndo, type EngineUndoSetUpArgs } from "../shared/game-engine.ts";
import { viewStill, type ViewStillOptions } from "./core/view-still.ts";
import { viewClip, type ViewClipOptions } from "./core/view-clip.ts";
import { ToolPermissionBy } from "../shared/permissions.ts";
import { type JobRecord, JobScopeKind, JobStopper } from "../shared/jobs.ts";
import { recordJobEnded, recordJobStarted } from "./core/job-records.ts";
import {
  type BootNotice,
  BootReason,
  type DispatchAction,
  DispatchActionType,
  harnessRunEnv,
  HarnessCapability,
  HarnessState,
} from "../shared/protocol.ts";
import { EngineId } from "../shared/providers.ts";
import { ExecutionStatus, isExecutionEvent, JournalPhase, RunState } from "../shared/run-state.ts";
import { credentialEnvValues, redactTokens, secretRedactor } from "../shared/redact.ts";
import { ActivityIndex, feedsActivity, type StudioActivityItem } from "../shared/studio-activity.ts";
import {
  harnessUiEvent,
  isHostOnlyUiEvent,
  UiEvent,
  uiEvent,
  type UiEventMap,
  type UiEventType,
} from "../shared/ui-events.ts";
import { observeMediaPlayback } from "../substrate/audio-observation.ts";
import { BudgetLedger } from "../substrate/budget.ts";
import { readEngineBinding } from "../substrate/game-engine-binding.ts";
import { latestBuildPreview } from "../substrate/build-preview.ts";
import { ContextPreferences } from "../substrate/context-settings.ts";
import { BonsaiEngine } from "../substrate/engines/bonsai.ts";
import { OllamaEngine, OllamaSidecar } from "../substrate/engines/ollama.ts";
import { LocalServerEngine } from "../substrate/engines/local-server.ts";
import { serverSettings } from "../substrate/local-server/settings.ts";
import { LOCAL_SERVER_KEY_SECRET, secretKeyStore } from "../substrate/provider-keys.ts";
import { EngineRegistry } from "../substrate/engines/registry.ts";
import type { Engine, LiveToolResult } from "../substrate/engines/types.ts";
import { EventStore } from "../substrate/event-store.ts";
import { atomicWriteJson, ensureDir, readJsonIfExists } from "../substrate/fsx.ts";
import type { ExportResult } from "../substrate/game-export.ts";
import { GameCandidates } from "../substrate/game-candidate.ts";
import {
  GameWorkspaces,
  readProjectShape,
  type AdoptOptions,
  type CreateOptions,
  type FolderInspection,
  type GameProject,
} from "../substrate/game-workspace.ts";
import { HarnessHost, UpdateJournal, type UpdateRecord } from "../substrate/harness-host.ts";
import { shortId } from "../substrate/ids.ts";
import { ExportApprovals, sortedReview } from "./core/export-approvals.ts";
import { ImprovementJournal } from "../substrate/improvement-journal.ts";
import { McpRegistry } from "../substrate/mcp/registry.ts";
import { ensureFactIgnoreRules } from "../substrate/nested-repos.ts";
import { mcpSecretPort, type SecretPort } from "../substrate/mcp/store.ts";
import { isBelow, isInside } from "../substrate/paths.ts";
import { PluginNativeServices } from "../substrate/plugins/native.ts";
import { spawnNativeLongLived } from "../substrate/plugins/native-process.ts";
import { PluginRegistry } from "../substrate/plugins/registry.ts";
import { PluginServices } from "../substrate/plugins/services.ts";
import { createEngineLinks, type EngineLinks } from "../substrate/plugins/engine-links.ts";
import type { PreviewInputAction } from "../substrate/preview-input.ts";
import { DEFAULT_POOL_MAX } from "../substrate/preview-pool.ts";
import type { PreviewConsoleEntry, PreviewPixelStats, PreviewPort } from "../substrate/preview-port.ts";
import { SnapshotEngine, SnapshotIndex, HARNESS_WORKSPACE } from "../substrate/snapshots.ts";
import { gitMissingProblem, SandboxUnavailableError } from "../substrate/sandbox-unavailable.ts";
import { claudeFolderDenyWrites, ProcessSandbox } from "../substrate/spawn.ts";
import { ensureHostGit } from "../substrate/windows-sandbox.ts";
import { type JobProbe, JobService, type JobSpawn } from "../substrate/jobs.ts";
import { type AppLookPort, type ScreenAccess, unsupportedAppLook } from "../substrate/app-look.ts";
import { checkLinuxIsolation } from "../substrate/linux-isolation.ts";
import { toolchain } from "../substrate/toolchain.ts";
import { TurnFactory } from "../substrate/turns.ts";
import type { EventData, EventEnvelope } from "../substrate/types.ts";
import { AssetCheckpoints } from "./asset-checkpoints.ts";
import { AssetService } from "./core/assets.ts";
import { ChatPermissionService } from "./core/chat-permissions.ts";
import { ConnectionService } from "./core/connections.ts";
import { ConversationService } from "./core/conversation.ts";
import { DelegationService } from "./core/delegation.ts";
import { GameFileService } from "./core/game-files.ts";
import { nameFromIdea, nameGame } from "./core/game-naming.ts";
import { makeBackdropShader } from "./core/backdrop-generation.ts";
import { GENEX_PLUGIN_ID, GenexCliService, genexHostPreflight, genexHostTool } from "./core/genex-cli.ts";
import { GenexPackageService } from "./core/genex-package.ts";
import { assertPublishable } from "./core/genex-publish.ts";
import { GENEX_ACCOUNT_ACTIONS } from "../shared/genex.ts";
import { GameThreadService } from "./core/game-threads.ts";
import {
  type CoreInternals,
  freshImprovementState,
  idleWork,
  type RunPreview,
  unservedPreviews,
} from "./core/internals.ts";
import { layoutFor, type StudioLayout } from "./core/layout.ts";
import { createPlanReviews } from "./core/plan-drafts.ts";
import { CONSENT_TIMEOUT_MS, PluginToolService } from "./core/plugin-tools.ts";
import { LockService, type LockServiceOptions } from "./core/plugin-locks.ts";
import { HookService, type HookServiceOptions } from "./core/plugin-hooks.ts";
import { ObserverService, type ObserverServiceOptions } from "./core/observers.ts";
import { FinishReviews, finishHistory } from "./core/finish-review.ts";
import { PreviewService } from "./core/previews.ts";
import { AutoResumeService, type AutoResumeDeps } from "./core/auto-resume.ts";
import { availableMemory } from "../substrate/hardware.ts";
import { RecoveryService } from "./core/recovery.ts";
import { ChatRewindService } from "./core/rewind.ts";
import { StorageSpaceService } from "./core/storage-space.ts";
import type { StorageFreed, StorageSpace } from "../shared/storage-space.ts";
import { SelfEditGateService } from "./core/self-edit-gate.ts";
import { SelfImprovementService } from "./core/self-improvement.ts";
import { serial } from "./core/serial.ts";
import {
  clampAgents,
  clampBuilders,
  LEGACY_DEFAULT_BUILDERS,
  LEGACY_DEFAULT_POOL,
  type StudioSettings,
} from "./core/settings.ts";
import { SUBSCRIPTION_ENGINES } from "./core/subscription-engines.ts";
import { GameBuilds } from "./game-build.ts";
import { engineRpc } from "./harness-rpc/engine.ts";
import { eventsRpc } from "./harness-rpc/events.ts";
import { gameRpc } from "./harness-rpc/game.ts";
import { jobsRpc } from "./harness-rpc/jobs.ts";
import { optimizationRpc } from "./harness-rpc/optimization.ts";
import { pluginsRpc } from "./harness-rpc/plugins.ts";
import { previewRpc } from "./harness-rpc/preview.ts";
import { desktopRpc } from "./harness-rpc/desktop.ts";
import { judgeRpc } from "./harness-rpc/judge.ts";
import { runsRpc } from "./harness-rpc/runs.ts";
import { snapshotRpc } from "./harness-rpc/snapshot.ts";
import { hooksRpc } from "./harness-rpc/hooks.ts";
import { observersRpc } from "./harness-rpc/observers.ts";
import { finishRpc } from "./harness-rpc/finish.ts";
import { studioRpc } from "./harness-rpc/studio.ts";
import type { PlanReviewController } from "./plan-review.ts";
import { PluginConsent } from "./plugin-consent.ts";
import { assertOwnedProject } from "./project-policy.ts";
import { type BuildEndDeps, gameOfThread, noteBuildEnd } from "./core/build-ends.ts";
import { usesGenexMultiplayer } from "../substrate/genex-game-manifest.ts";
import { seedUpgradedPayload } from "./seed-upgrade-notice.ts";
import { SeedUpgradeMode } from "../substrate/seed-upgrade.ts";

export type { PreviewInputAction };
export type { PreviewConsoleEntry, PreviewPixelStats, PreviewPort };

export { SUBSCRIPTION_ENGINES, layoutFor, type StudioLayout, type StudioSettings };

/** A harness silent this long is wedged, and the watchdog restores it. */
const HARNESS_HEARTBEAT_TIMEOUT_MS = 10 * MINUTE_MS;
/** This many harness exits inside the window is a crash loop: the studio rewinds instead of restarting. */
const HARNESS_CRASH_LOOP = { count: 3, windowMs: 5 * MINUTE_MS } as const;
/** Where the folder chosen in Settings → Games is remembered, under userData. */
const GAMES_ROOT_FILE = "games-root.json";
/** The prefix of the scratch folder an engine's game runs with (its private home and temp files). */
const ENGINE_SCRATCH_PREFIX = "genex-play-";

/** How long after a boot the first full read of the log (for Activity) waits. */
const ACTIVITY_WARMUP_DELAY_MS = 5 * SECOND_MS;

/** What the core itself writes for people: thread titles, journal reasons, errors. */
const MESSAGE = {
  studioThreadTitle: "Studio",
  resetByUser: "reset to the shipped version by the user",
  updateRewound: "it did not boot; the studio rewound",
  updateUnhealthy: "healthcheck failed",
  stillBuilding: (project: string) => `a contractor is still building in "${project}" — wait for it to finish first`,
  protectedLocation: "Studio can't create games there. Choose another folder.",
  workStillRunning: "Wait for this game's work to finish before removing it.",
  buildStillRunning: "Stop this game's build before removing it.",
  gameNotFound: "Game not found",
  exportBuildFailed: "Current build failed; no stale output was exported",
  coverWrongGame: "Cover tool is bound to this conversation’s game.",
  notEnginePlugin: "That plugin doesn't link games to an engine.",
  noCoverRenderer: "GPU cover rendering is unavailable.",
  shaderCoverKept: "This game already has a custom cover. Its image was preserved.",
  shaderCoverRaced: "The cover changed while rendering. The newer image was preserved.",
  shaderCoverSaved: "Saved this game’s shader cover. The attached image is its rendered still.",
  coverLabel: "Game cover",
  recipeCoverKept: "This game already has a chosen cover. It was kept.",
  recipeCoverRaced: "The cover changed meanwhile. The newer one was kept.",
  recipeCoverSaved: (look: string) => `Saved this game’s cover: ${look}.`,
  queueNeedsHarness: "Queue editing needs the updated conversation harness. Your message is still queued.",
  resumeUnsupported:
    "This build of the studio can't pick a build back up yet — its own loop code predates timed builds.",
  runAlreadyFinished: (runId: string) => `run ${runId} already finished — nothing to resume`,
  noAutopilotJournal: (runId: string) => `no Autopilot journal found for run ${runId}`,
  notInLibrary: (project: string) => `refused: "${project}" is not a game in the library`,
  notOurRoot: (root: string, project: string) =>
    `refused: ${root} is not a studio worktree or the folder of "${project}"`,
  linkedPath: (target: string) => `refused: the worktree path runs through a symlink: ${target}`,
} as const;

/** The one lock every cover render takes: the GPU renderer draws one cover at a time. */
const COVER_RENDERER = "renderer";

/** settings.json as this build or an older one may have written it. */
type SavedSettings = Partial<StudioSettings> & {
  autoApplyImprovements?: boolean;
  /** The `DEFAULT_BUILDERS` in force when the file was written; older builds wrote none. */
  buildersDefault?: number;
};

/** Migration: installs that had the old auto-apply switch off chose caution — keep it. */
function savedSelfImproving(saved: SavedSettings): boolean {
  if (saved.selfImproving !== undefined) return Boolean(saved.selfImproving);
  if (saved.autoApplyImprovements !== undefined) return Boolean(saved.autoApplyImprovements);
  return false;
}

/** The worker default in force when `saved` was written: the file's own record, else the older builds' default. */
function savedBuildersDefault(saved: SavedSettings): number {
  return typeof saved.buildersDefault === "number" ? saved.buildersDefault : LEGACY_DEFAULT_BUILDERS;
}

/**
 * Settings are saved whole on any change, so a worker count equal to the default it was saved
 * under counts as untouched and becomes today's default; any other count was chosen and stays.
 * Before "Maximum workers" the file held only a pool size: the old untouched default becomes the
 * new default; a pool someone chose keeps its builders.
 */
function savedBuildersMax(saved: SavedSettings): number {
  if (typeof saved.buildersMax === "number") {
    if (saved.buildersMax === savedBuildersDefault(saved)) return DEFAULT_BUILDERS;
    return clampBuilders(saved.buildersMax);
  }
  if (typeof saved.agentsMax === "number" && saved.agentsMax !== LEGACY_DEFAULT_POOL) {
    return clampBuilders(clampAgents(saved.agentsMax) - LEAD_WINDOWS);
  }
  return DEFAULT_BUILDERS;
}

/** Events in log order: their ids are UUIDv7, which sort by time as plain strings. */
function byLogOrder(a: EventEnvelope, b: EventEnvelope): number {
  if (a.id < b.id) return -1;
  return a.id > b.id ? 1 : 0;
}

/** The game a thread is bound to, if any (`metadata.project`). */
function threadProject(record: { metadata?: unknown }): string | undefined {
  return (record.metadata as { project?: string } | undefined)?.project;
}

/** A thread's `metadata.kind`: the studio's own, a game's, or none for a thread from before kinds. */
function threadKind(record: { metadata?: unknown }): string | undefined {
  return (record.metadata as { kind?: string } | undefined)?.kind;
}

/** The boot notice: a self-update the durable journal still holds, else the caller's reason. */
function bootNotice(pending: UpdateRecord[], reason: BootReason): BootNotice {
  const [update] = pending;
  if (!update) return { reason };
  return { reason: BootReason.SelfUpdate, updateId: update.id, detail: update.reason };
}

/** Why a pending self-update failed, as its journal record says; none when it applied. */
function updateFailure(ok: boolean, rewound: boolean): string | undefined {
  if (ok) return undefined;
  return rewound ? MESSAGE.updateRewound : MESSAGE.updateUnhealthy;
}

/** A page script: which of `files` the page loaded (HTTP 200 or 304 in resource timing). */
function loadedFilesScript(files: string[]): string {
  return `(()=>{const loaded=new Set(performance.getEntriesByType('resource').filter(e=>e.responseStatus===200||e.responseStatus===304).map(e=>e.name));return ${JSON.stringify(files)}.filter(file=>loaded.has(new URL(file,location.href).href));})()`;
}

export interface StudioPaths {
  userData: string;
  /** Read-only app resources: harness seed, game template, vendored libraries, bootstrap. */
  resources: string;
}

export interface StudioCoreOptions {
  renderGameCover?: (surface: string, seed: number) => Promise<string>;
  /** Computer control (`desktop-control.ts`): absent where no desktop driver can be reached, and in tests. */
  desktop?: DesktopControl;
  /** Notes each boot step as it finishes (`main/performance.ts`); a launch without diagnostics passes nothing. */
  markBoot?: (step: string) => void;
  engines?: Engine[];
  executionPolicy?: { allowedProjectRoot?: string; runBackgroundImprovement?: boolean };
  paths: StudioPaths;
  preview?: PreviewPort;
  /**
   * Factory for headless observation ports (a hidden window on the same `game://` protocol).
   * Absent = the pool serves only the live view and `preview.acquire` refuses loudly.
   */
  createHeadlessPreview?: (options?: { purpose?: "optimization" }) => Promise<PreviewPort>;
  /** Max concurrent headless preview leases (default 4). */
  previewPoolMax?: number;
  /** Idle-architect pacing — overridable so tests need not wait ten real minutes. */
  improvementIdle?: { idleMs?: number; checkMs?: number; minGapMs?: number };
  /** `process.execPath`; in Electron this needs `runAsNode`. */
  execPath?: string;
  runAsNode?: boolean;
  /** The app's version, stamped into the harness seed manifest (substrate/seed-upgrade.ts `writer`). */
  appVersion?: string;
  /**
   * Where game folders live. The app passes `~/AI Games` so projects are plain visible folders
   * in Finder; tests and smoke runs leave it unset and get the default under userData.
   */
  gamesRoot?: string;
  ollamaHost?: string;
  /** Claude Code binary for the SDK to spawn (asar-unpacked in a packaged app); unset = SDK default. */
  claudeExecutable?: string;
  /** `codex` binary to spawn; unset = whatever is on PATH or in the usual install locations. */
  codexExecutable?: string;
  /** Disable the sandbox only in tests that assert the unsandboxed path. */
  sandbox?: boolean;
  /** The self-edit gate's type check (substrate/type-gate.ts); the time limit is a test seam. */
  typeGate?: { timeoutMs?: number };
  /**
   * How long an agent's request to run a confirmed plugin tool waits for the user's answer in
   * the chat before it is declined (default 9 minutes — under the Codex bridge's 10-minute tool
   * ceiling, so the engine hears "declined" rather than a timeout).
   */
  consentTimeoutMs?: number;
  /** How long a build's lead's permission card waits for the person (default 5 minutes); a test seam. */
  leadAskTimeoutMs?: number;
  /** The locks' clock and its timers, and an agent's call's wait (default four minutes); a test seam. */
  locks?: Pick<LockServiceOptions, "agentWaitMs" | "now" | "sleep" | "timeout">;
  /** The clock a moment's shared limit runs on (`HookServiceOptions`); a test seam. */
  hooks?: HookServiceOptions;
  /** The clock captures run on (the locks' by default) and how they shrink pictures (`ObserverServiceOptions`); a test seam. */
  observers?: ObserverServiceOptions;
  /**
   * Other Genex profiles' data, given by the app at start (the normal profile's folder, the
   * repository's development profiles): on every worker's never-touch list beside this profile's own.
   */
  neverTouch?: string[];
  /**
   * Other Genex profiles' game folders, given by the app at start (the normal profile's games when
   * this launch keeps its own elsewhere): on every worker's never-touch list as other games.
   */
  neverTouchGames?: string[];
  /** The most disk a worker's copy of a game may take (default `WRITER_COPY_MAX_BYTES`); tests lower it. */
  writerCopyMaxBytes?: number;
  /** How long Stop waits for a message still being sent to reach the chat's queue before it aborts anyway (default 5 s). */
  stopSendWaitMs?: number;
  /**
   * How long a rewind waits for the build it stopped to close (default 2 minutes), and the clock
   * it waits on; a test seam.
   */
  rewindBuildStop?: { timeoutMs?: number; now?: () => number; sleep?: (ms: number) => Promise<unknown> };
  /** The clock a game's asset folders are reused on by its previews and thumbnails; a test seam. */
  assetFolders?: { now?: () => number };
  /** How agent jobs are spawned (default: the sandbox's `spawnLongLived`); a test seam. */
  jobSpawn?: JobSpawn;
  /** How a left job's start time is read (default: `ps -o lstart=`); a test seam. */
  jobProbe?: JobProbe;
  /**
   * How agents look at app windows (`app_look`): the desktop app passes the macOS port, tests and
   * fixture profiles the stub; default: it answers that it works on macOS only for now.
   */
  appLook?: AppLookPort;
  /** macOS access for `app_look` (the desktop app on macOS); none: a look asks nothing first. */
  screenAccess?: ScreenAccess;
  /** The clock, timers and memory reading host auto-resume uses (`core/auto-resume.ts`); a test seam. */
  autoResume?: Partial<Pick<AutoResumeDeps, "now" | "setTimer" | "clearTimer" | "freeMb">>;
  /** A plugin still's budget (default one minute) and the clock it runs on (`core/view-still.ts`); a test seam. */
  pluginStill?: ViewStillOptions;
  /** A plugin clip's budget (default its seconds and a minute) and the clock it runs on (`core/view-clip.ts`); a test seam. */
  pluginClip?: ViewClipOptions;
  /** A planned automatic resume started (true) or stopped (false) waiting; main holds the Mac awake meanwhile. */
  onAutoResumePending?: (pending: boolean) => void;
  onUiEvent?: (event: UiEvent) => void;
  onLog?: (line: string, stream: "stdout" | "stderr") => void;
  /** Where a message's @ tags are fetched from: genex.games, the account and git (`core/mention-tags.ts`). */
  mentionSources?: MentionSources;
}

export type { CoreInternals };

/**
 * Which bundled plugin seeds start enabled. The Unreal, Unity, Godot and Roblox Studio plugins
 * are off until the user turns them on: each needs its editor, and Roblox an account for people
 * 18 and over. The Genex seed stays on: it carries the plugin-authoring guide and plugin_check,
 * which are local; its hosted generators stay inert without a Genex account, which this fork
 * never asks for, and each spend asks for consent first.
 */
function pluginSeedEnabled(settings: StudioSettings): Record<string, boolean> {
  return {
    blender: settings.blender,
    unreal: false,
    unity: false,
    godot: false,
    roblox: false,
  };
}

export class StudioCore {
  readonly options: StudioCoreOptions;
  readonly layout: StudioLayout;
  readonly snapshots: SnapshotEngine;
  readonly snapshotIndex = new SnapshotIndex();
  readonly candidates: GameCandidates;
  readonly engines = new EngineRegistry();
  readonly contextPreferences: ContextPreferences;
  readonly games: GameWorkspaces;
  readonly journal: UpdateJournal;
  readonly ollamaSidecar: OllamaSidecar;
  /** Token bookkeeping + improvement-class caps, enforced at the engine seam (A9). */
  readonly budget: BudgetLedger;
  /** Durable queued architect jobs, executed only when idle (A6, §6.5). */
  readonly improvements: ImprovementJournal;

  // Set by init().
  store!: EventStore;
  turns!: TurnFactory;
  sandbox!: ProcessSandbox;
  /**
   * The long processes the agents start: owned here, not by the harness, so they outlive a turn
   * and a harness restart; stopped when Genex quits.
   */
  jobs!: JobService;
  /** How agents look at app windows: the port the app was given, else the answer that it is macOS only. */
  readonly appLook: AppLookPort;
  /** macOS access for `app_look`; null where nothing is asked first. */
  readonly screenAccess: ScreenAccess | null;
  /** Builds a game that builds itself — never inside the folder the user owns. */
  builds!: GameBuilds;
  plugins!: PluginRegistry;
  pluginServices!: PluginServices;
  /** The plugins' native runtimes: detected for jobs, and for an engine a bridge game's play names. */
  #nativePlugins: PluginNativeServices | null = null;
  /** Each game's link to an engine project, kept for `game-engine` plugins (`game.engine.*`, Undo, the first call's link). */
  engineLinks!: EngineLinks;
  /**
   * The studio's own MCP client. Connectors the user configured reach every coding path through
   * the same `liveTools`/`onLiveTool` channel plugin tools ride, so there is one trust, consent
   * and observability model instead of one per engine. Agents can list and call; only the Studio
   * UI, over IPC, can change what is on the list.
   */
  mcp!: McpRegistry;
  host!: HarnessHost;
  /** The studio's own conversation: chat, runs and self-changes all land in one log. */
  mainThread!: string;

  /** What the extracted services and RPC groups reach inside the core; see {@link CoreInternals}. */
  readonly #x: CoreInternals;
  readonly #connections: ConnectionService;
  readonly #previews: PreviewService;
  readonly #delegation: DelegationService;
  readonly #recovery: RecoveryService;
  /** Resumes a paused build on its own once its limit resets or its loop runs again. */
  readonly #autoResume: AutoResumeService;
  readonly #selfImprovement: SelfImprovementService;
  readonly #selfEditGate: SelfEditGateService;
  readonly #pluginTools: PluginToolService;
  readonly #conversation: ConversationService;
  readonly #assets: AssetService;
  readonly #threads: GameThreadService;
  readonly #gameFiles: GameFileService;
  readonly #rewind: ChatRewindService;
  readonly #storage: StorageSpaceService;
  /** Questions an agent's plugin tool is waiting on the user for (`plugin_consent` cards in the chat). */
  readonly #consent: PluginConsent;
  /** The locks plugin tools and connectors wait their turn for, the person first. */
  readonly locks: LockService;
  /** Genex's moments: checkpoints, restores and the rest, and the plugin steps each runs. */
  readonly hooks: HookService;
  /** A game's observers inside a run, and the pictures they keep with it. */
  readonly #observers: ObserverService;
  readonly #finishReviews: FinishReviews;
  /** Claude Code permissions in game chats: modes, the Allow / Deny cards, saved grants. */
  readonly #permissions: ChatPermissionService;
  /** The same port the registry reads, kept so a plugin server's `secret:<name>` can be resolved. */
  #mcpSecrets: SecretPort | null = null;
  #started = false;
  #settings: StudioSettings = {
    learning: true,
    selfImproving: false,
    architect: false,
    buildersMax: DEFAULT_BUILDERS,
    agentsMax: DEFAULT_POOL_MAX,
    blender: true,
    autoResume: true,
    computerControl: false,
  };
  #assetCheckpointStore?: AssetCheckpoints;
  #planReviews?: PlanReviewController;

  // One at a time, keyed by what they touch: a game's thread, a game's shown build, the cover renderer.
  readonly #gameThreadOperations = new Map<string, Promise<unknown>>();
  readonly #showOperations = new Map<string, Promise<unknown>>();
  readonly #coverOperations = new Map<string, Promise<unknown>>();
  readonly #showRequests = new Map<string, Promise<{ dir: string; commit: string }>>();
  /** File lists approved in Studio's Publish dialog, each waiting for its export. */
  readonly #exportApprovals = new ExportApprovals();

  /**
   * The whole log across every thread, in one global (UUIDv7) order. The chat shows one
   * thread; Review and the builds ledger see everything the studio did, whichever chat it
   * happened in.
   */
  readonly #activity = new Map<string, string | null>();
  #activityIndex = new ActivityIndex();
  #activityTurn: Promise<unknown> = Promise.resolve();
  #activityWarmup: NodeJS.Timeout | null = null;

  constructor(options: StudioCoreOptions) {
    this.options = options;
    this.contextPreferences = new ContextPreferences(path.join(options.paths.userData, "context-settings.json"));
    this.#consent = new PluginConsent({ timeoutMs: options.consentTimeoutMs ?? CONSENT_TIMEOUT_MS });
    this.locks = this.#createLocks();
    this.layout = layoutFor(options.paths.userData);
    this.appLook = options.appLook ?? unsupportedAppLook();
    this.screenAccess = options.screenAccess ?? null;
    if (options.gamesRoot) this.layout.gamesRoot = options.gamesRoot;
    this.snapshots = new SnapshotEngine([{ name: HARNESS_WORKSPACE, dir: this.layout.harnessWs }]);
    this.candidates = new GameCandidates(this.snapshots, path.join(this.layout.scratch, "optimization"));
    this.games = new GameWorkspaces({
      root: this.layout.gamesRoot,
      templateDir: path.join(options.paths.resources, "game-template"),
      vendorDir: path.join(options.paths.resources, "vendor"),
      indexFile: path.join(options.paths.userData, "projects.json"),
      userData: options.paths.userData,
      // The registry comes later in construction; until it exists only the core table detects.
      factRules: () => this.plugins?.detectRules() ?? [],
      // Likewise: until the registry exists only Genex's own table places ignore rules.
      workspaceSections: () => this.plugins?.workspaceSections() ?? [],
      // Likewise: until the registry exists no plugin hooks a moment.
      hookEvents: (game) => this.plugins?.hookEvents(game) ?? [],
      // Likewise: until the registry exists no engine is declared, so no link holds.
      engines: () => this.plugins?.engines() ?? new Map(),
    });
    // Every save point and rescue snapshot of a game follows the rules for what it holds then,
    // and a restore never cleans away what those rules ignore.
    this.snapshots.beforeCommit = (workspace) =>
      this.games.ensureWorkspaceRules(workspace.dir).then(
        (rules) => rules.map(ignoreLine),
        (err) => {
          this.options.onLog?.(
            `[core] ignore rules for ${workspace.name} not topped up: ${errorMessage(err)}`,
            "stderr",
          );
          return [];
        },
      );
    // A restore keeps what those rules ignore on disk, and in the restored ignore file.
    this.snapshots.keepIgnoring = (workspace, lines) =>
      ensureFactIgnoreRules(workspace.dir, lines).catch((err) => {
        this.options.onLog?.(`[core] ignore rules for ${workspace.name} not kept: ${errorMessage(err)}`, "stderr");
      });
    this.journal = new UpdateJournal(this.layout.updates);
    this.ollamaSidecar = new OllamaSidecar({ ...(options.ollamaHost ? { host: options.ollamaHost } : {}) });
    this.budget = new BudgetLedger({ file: path.join(options.paths.userData, "budget-ledger.json") });
    this.improvements = new ImprovementJournal(path.join(options.paths.userData, "improvements"));
    this.#connections = new ConnectionService(this, (threadId) => this.#threadBusy(threadId));
    this.#x = this.#createInternals();
    this.hooks = new HookService(this, this.#x, options.hooks ?? {});
    this.#observers = new ObserverService(this, this.#x, {
      ...(options.locks?.now ? { now: options.locks.now } : {}),
      ...(options.locks?.timeout ? { timeout: options.locks.timeout } : {}),
      ...options.observers,
    });
    this.#previews = new PreviewService(this, this.#x);
    this.#delegation = new DelegationService(this, this.#x);
    this.#finishReviews = this.#createFinishReviews();
    this.#recovery = new RecoveryService(this, this.#x);
    this.#autoResume = this.#createAutoResume();
    this.#selfImprovement = new SelfImprovementService(this, this.#x);
    this.#selfEditGate = new SelfEditGateService(this, this.#x);
    this.#pluginTools = new PluginToolService(this, this.#x);
    this.#conversation = new ConversationService(this, this.#x);
    this.#assets = new AssetService(this, undefined, options.assetFolders?.now, this.#x.assetCalls);
    this.#threads = new GameThreadService(this);
    this.#gameFiles = new GameFileService(this);
    this.#rewind = new ChatRewindService(this, this.#x);
    this.#storage = new StorageSpaceService(this, this.#x);
    this.#permissions = new ChatPermissionService(this);
  }

  /**
   * The lock table: a lock's `personFirst` tool is asked straight through the registry as the
   * harness's own step (never through a call that holds locks itself), and a wait on the person is
   * told to the chat, as is, once, an agent going ahead of them where the plugin lets it.
   */
  #createLocks(): LockService {
    return new LockService({
      ...this.options.locks,
      probe: (plugin, lock, binding, signal) =>
        this.plugins.tool(`${plugin}__${lock.personFirst}`, {}, binding, signal, PluginToolAudience.Harness),
      onPersonFirst: (notice) => this.emit(UiEvent.PersonFirst, notice),
      onWentAhead: ({ threadId, project, label, plugin }) => {
        if (!threadId) return;
        const payload = { project, pluginId: plugin, label };
        void this.append([customEventData(CustomEvent.AgentWentAhead, payload)], threadId).catch(() => undefined);
      },
    });
  }

  /** A Loop's finish checks: the host seats the reviewer and writes the verdict (`core/finish-review.ts`). */
  #createFinishReviews(): FinishReviews {
    return new FinishReviews({
      runningChat: (project, runId) => this.#delegation.chatOfRunningGameRun(project, runId),
      history: async (threadId, runId) => finishHistory(await this.store.listEvents(threadId), runId),
      append: (threadId, payload) => this.append([customEventData(CustomEvent.FinishCheck, { ...payload })], threadId),
      delegate: (params) => this.#delegation.delegate(params),
    });
  }

  #createAutoResume(): AutoResumeService {
    const seam: NonNullable<StudioCoreOptions["autoResume"]> = this.options.autoResume ?? {};
    return new AutoResumeService({
      ...seam,
      enabled: () => this.#settings.autoResume,
      harnessReady: () => this.host?.state === HarnessState.Ready,
      freeMb: seam.freeMb ?? (async () => (await availableMemory()).freeMb),
      events: (threadId) => this.store.listEvents(threadId),
      record: async (threadId, payload) => {
        await this.append([customEventData(CustomEvent.RunAutoResumed, { ...payload })], threadId);
      },
      resume: (runId) => this.#resumeAutopilot(runId),
      onLog: (line) => this.options.onLog?.(line, "stderr"),
      onPendingChange: (pending) => this.options.onAutoResumePending?.(pending),
    });
  }

  /** When the soonest planned automatic resume is due (ms), or null when none waits; a quit names it. */
  get autoResumeAt(): number | null {
    return this.#autoResume.nextResumeAt();
  }

  /**
   * The object the services share with the core: the state itself, plus live views of what the
   * core owns and its checks. Services are read through getters: they are built from this object.
   */
  #createInternals(): CoreInternals {
    const core = this;
    return {
      ...idleWork(),
      ...unservedPreviews(),
      ...freshImprovementState(),
      get planReviews() {
        return core.planReviews;
      },
      assertHarnessRoot: (...args) => core.#assertHarnessRoot(...args),
      assertNoLinkBelow: (...args) => core.#assertNoLinkBelow(...args),
      cancelConnectorCalls: (...args) => core.#cancelConnectorCalls(...args),
      capabilityFacts: (...args) => core.#connections.capabilityFacts(...args),
      get consent() {
        return core.#consent;
      },
      indexEvent: (...args) => core.#indexEvent(...args),
      get mcpSecrets() {
        return core.#mcpSecrets;
      },
      readyProject: (...args) => core.#readyProject(...args),
      recordToolRevision: (...args) => core.#connections.recordApplied(...args),
      recordDeliveredTools: (...args) => core.#connections.recordDelivered(...args),
      lastAppliedTools: (...args) => core.#connections.lastApplied(...args),
      setGameCover: (...args) => core.#setGameCover(...args),
      setGameCoverShader: (...args) => core.#setGameCoverShader(...args),
      get settings() {
        return core.#settings;
      },
      get started() {
        return core.#started;
      },
      get toolRegistryRevision() {
        return core.#connections.revision;
      },
      get previews() {
        return core.#previews;
      },
      get delegation() {
        return core.#delegation;
      },
      get recovery() {
        return core.#recovery;
      },
      get selfImprovement() {
        return core.#selfImprovement;
      },
      get selfEditGate() {
        return core.#selfEditGate;
      },
      get pluginTools() {
        return core.#pluginTools;
      },
      get locks() {
        return core.locks;
      },
      get hooks() {
        return core.hooks;
      },
      get observers() {
        return core.#observers;
      },
      get finishReviews() {
        return core.#finishReviews;
      },
      get conversation() {
        return core.#conversation;
      },
      get assets() {
        return core.#assets;
      },
      get rewind() {
        return core.#rewind;
      },
      get permissions() {
        return core.#permissions;
      },
      planning: (threadId) => core.#permissions.planning(threadId),
      chatMode: (threadId) => core.#permissions.modeOf(threadId),
    };
  }

  // ── boot ─────────────────────────────────────────────────────────────────────────────────
  async init(): Promise<void> {
    const mark = (step: string): void => this.options.markBoot?.(`core:${step}`);
    // The host runs git itself (snapshots, the harness workspace) before the sandbox looks for Git
    // Bash, so Windows settles which Git first: an installed one, else the app's own. Without any (a
    // development build on a PC without Git) the setup screen opens here, not `spawn git ENOENT`.
    if (process.platform === StudioPlatform.Windows && !(await ensureHostGit())) {
      throw new SandboxUnavailableError(gitMissingProblem());
    }
    await this.#restoreGamesRoot();
    for (const dir of Object.values(this.layout)) await ensureDir(dir);
    await this.#loadSettings();
    await this.budget.load();
    const migrated = await this.#migrateGamesRoot();
    mark("settings");
    await this.#recovery.seedHarnessWorkspace();
    mark("seed");
    await this.#openStore();
    await this.#adoptStudioThread();
    await this.#recovery.noteSeedMoves();
    if (migrated.length > 0) {
      await this.append([customEventData(CustomEvent.GamesMigrated, { moved: migrated, to: this.layout.gamesRoot })]);
    }
    await this.#recovery.rebuildSnapshotIndex();
    await this.#takeSeedUpgradeBaseline();
    mark("events");
    const listed = await this.#registerGames();
    mark("games");
    // Ask the login shell for its PATH now, in parallel with the rest of the boot: the answer
    // takes a second or two and the first sandboxed process would otherwise wait for it.
    void toolchain().catch(() => {});
    // Side by side: the sandbox reads only the layout and the games, and plugin setup reaches the
    // sandbox only when a tool runs later.
    const sandbox = await sandboxBesidePlugins(
      this.#createSandbox(listed).finally(() => mark("sandbox")),
      this.#wirePluginServices().finally(() => mark("plugins")),
    );
    // Linux: a sandbox that cannot start a process (AppArmor's user-namespace restriction) is a
    // setup problem the window shows, not a harness that never boots.
    await checkLinuxIsolation(sandbox).catch(async (error: unknown) => {
      await sandbox.dispose();
      throw error;
    });
    this.sandbox = sandbox;
    await this.#openJobs();
    mark("jobs");
    await this.#wireMcp();
    this.builds = this.#createBuilds();
    this.#registerEngines();
    this.host = this.#createHarnessHost();
    mark("engines");
  }

  /** The job registry, and what an earlier app left running closed as interrupted. */
  async #openJobs(): Promise<void> {
    this.jobs = new JobService({
      root: this.layout.jobs,
      spawn: this.options.jobSpawn ?? ((request) => this.sandbox.spawnLongLived(request)),
      probe: this.options.jobProbe,
      onStarted: (record) => recordJobStarted(this, record),
      onEnded: (record) => recordJobEnded(this, record),
    });
    await this.jobs
      .reconcile()
      .catch((error) => this.options.onLog?.(`[core] closing left jobs failed: ${errorMessage(error)}`, "stderr"));
  }

  /** Stop a settled run's jobs, in every game; the run stays in `runJobStops` until their ends are recorded. */
  #stopRunJobs(runId: string): void {
    if (!this.jobs) return;
    this.#x.runJobStops.add(runId);
    void this.jobs
      .stopScope(undefined, { kind: JobScopeKind.Run, runId }, JobStopper.ScopeEnded)
      .catch((error) => this.options.onLog?.(`[core] stopping a run's jobs failed: ${errorMessage(error)}`, "stderr"))
      .finally(() => this.#x.runJobStops.delete(runId));
  }

  /**
   * Stop every agent job: they are sandboxed process groups of this app and go with it. Apps a
   * person can see, such as the editor a plugin opened, are not jobs and stay open.
   */
  async #stopJobs(): Promise<void> {
    await this.jobs
      ?.stopAll(JobStopper.Quit)
      .catch((error) => this.options.onLog?.(`[core] stopping jobs failed: ${errorMessage(error)}`, "stderr"));
  }

  async #openStore(): Promise<void> {
    // Every append path (core, harness RPC, turns, delegations) writes through this store, so the
    // one redactor here keeps a credential an agent printed out of the durable log (SEC-1). Held
    // values plus unmistakable token shapes only: the log is replayed as the agent's context, so
    // prose and code that merely look like a credential field stay as written.
    this.store = await EventStore.open(this.layout.exoharness, "studio", {
      redact: secretRedactor(() => this.knownSecretValues(), redactTokens),
    });
    this.turns = new TurnFactory(this.store);
  }

  /**
   * The oldest thread is the studio's own — chat with the studio, runs and self-changes. Game
   * threads (metadata.kind === "game") come and go around it; it is never one of them.
   */
  async #adoptStudioThread(): Promise<void> {
    const threads = await this.store.listThreads();
    const studioThread =
      threads.find((t) => threadKind(t) === ThreadKind.Studio) ?? threads.find((t) => threadKind(t) === undefined);
    const metadata = { kind: ThreadKind.Studio };
    this.mainThread =
      studioThread?.id ?? (await this.store.createThread({ title: MESSAGE.studioThreadTitle, metadata }));
    if (studioThread && threadKind(studioThread) !== ThreadKind.Studio) {
      await this.store.updateThread(this.mainThread, {
        title: studioThread.title ?? MESSAGE.studioThreadTitle,
        metadata,
      });
    }
  }

  #gamesRootFile(): string {
    return path.join(this.options.paths.userData, GAMES_ROOT_FILE);
  }

  /** The folder chosen in Settings → Games replaces the default while the disk holding it is there. */
  async #restoreGamesRoot(): Promise<void> {
    const saved = (await readJsonIfExists<{ dir?: unknown }>(this.#gamesRootFile()).catch(() => null))?.dir;
    if (typeof saved !== "string" || !path.isAbsolute(saved)) return;
    // An unplugged drive keeps the choice for the next launch; this one uses the default.
    if (
      !(await stat(path.dirname(saved)).then(
        (info) => info.isDirectory(),
        () => false,
      ))
    )
      return;
    this.layout.gamesRoot = saved;
    this.games.root = saved;
  }

  /** Settings → Games: new games are created in `dir` from now on. Existing games stay where they are. */
  async setGamesRoot(dir: string): Promise<void> {
    if (path.resolve(dir) === path.resolve(this.games.root)) return;
    await this.assertProjectAllowed(dir);
    await this.games.changeRoot(dir);
    this.layout.gamesRoot = this.games.root;
    this.sandbox.allowWrite(this.games.root);
    this.sandbox.denyWrite(claudeFolderDenyWrites(this.games.root, []));
    await atomicWriteJson(this.#gamesRootFile(), { dir: this.games.root });
    this.emit(UiEvent.GameChanged, {});
  }

  /**
   * Games used to live under `~/Library/Application Support` — technically fine, invisible in
   * Finder, and the source of a whole morning of "where is my game?" confusion. When the app
   * points the root somewhere visible, existing projects follow it once, folder by folder.
   */
  async #migrateGamesRoot(): Promise<string[]> {
    const oldRoot = path.join(this.options.paths.userData, "workspaces", "games");
    if (path.resolve(oldRoot) === path.resolve(this.layout.gamesRoot)) return [];
    const entries = await readdir(oldRoot, { withFileTypes: true }).catch(() => []);
    const moved: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const from = path.join(oldRoot, entry.name);
      const to = path.join(this.layout.gamesRoot, entry.name);
      const alreadyThere = await readdir(to).catch(() => null);
      if (alreadyThere !== null) continue; // never overwrite a folder the user may have touched
      try {
        await rename(from, to);
      } catch {
        await cp(from, to, { recursive: true });
        await rm(from, { recursive: true, force: true });
      }
      moved.push(entry.name);
    }
    return moved;
  }

  /**
   * An applied seed moves the workspace past every existing healthy snapshot, and the
   * watchdog rewinds to the newest healthy one — without a fresh baseline here, the first
   * wedge of the run lands the harness back on a weeks-old promotion instead of the seed
   * that just shipped. Failure is logged, never fatal: a boot matters more than a baseline.
   * Healthy by the usual rules, not by being taken: at once when its code is an already-healthy
   * snapshot's (a skill or prompt fix), else once start() has booted exactly it. The workspace it
   * pins may hold a last-session code edit that never ran, and a baseline vouched for here made
   * a rewind land on that edit and reseed instead of returning to the agent's last good self.
   */
  async #takeSeedUpgradeBaseline(): Promise<void> {
    if (this.#x.seedReport?.mode !== SeedUpgradeMode.Upgraded) return;
    try {
      await this.#recovery.inheritHealth(await this.snapshot(SnapshotScope.Harness, "seed upgrade baseline"));
    } catch (err) {
      this.options.onLog?.(`[core] seed upgrade baseline snapshot failed: ${errorMessage(err)}`, "stderr");
    }
  }

  /** The library's games, each checked against the policy and registered for snapshots. */
  async #registerGames(): Promise<GameProject[]> {
    await this.games.loadIndex();
    const listed = await this.games.list();
    for (const game of listed) {
      await this.assertProjectAllowed(game.dir);
      this.snapshots.register({ name: game.name, dir: game.dir });
    }
    return listed;
  }

  /** What no agent process may read: the studio's secrets, the engines' homes and the Genex login. */
  #protectedPaths(): string[] {
    return [this.layout.secrets, this.layout.engineHomes, path.join(os.homedir(), ".genex")];
  }

  #createSandbox(games: GameProject[]): Promise<ProcessSandbox> {
    return ProcessSandbox.create({
      writableRoots: [
        this.layout.workspaces,
        this.layout.runs,
        this.layout.exports,
        this.layout.gamesRoot,
        ...games.map((game) => game.dir),
      ],
      scratchDir: this.layout.scratch,
      secretPaths: this.#protectedPaths(),
      // R4 enforced: the judge rubrics are readable but frozen — no agent process, however
      // evolved, rewrites the yardstick it is measured by. Nor does one plant Claude Code's
      // settings or hooks in a game, which the person's own session there would load.
      // B7: prompts and skills are the agent's operating rules; it changes them only through
      // the host (`guardian.write_self`), which tries, snapshots and records every change.
      denyWrite: [
        path.join(this.layout.harnessWs, "judge"),
        path.join(this.layout.harnessWs, "prompts"),
        path.join(this.layout.harnessWs, "skills"),
        ...claudeFolderDenyWrites(
          this.layout.gamesRoot,
          games.map((game) => game.dir),
        ),
      ],
      readableRoots: [this.options.paths.resources],
      enabled: this.options.sandbox ?? true,
      // Windows: the window opens on the games while the network check and folder grants finish.
      startInBackground: true,
      log: (line) => this.options.onLog?.(`[sandbox] ${line}`, "stderr"),
      // A Finder-launched app has no npm on its PATH; every build the studio ever ran exited 127.
      toolPath: async () => (await toolchain()).path,
    });
  }

  /** The plugin registry and the host services its plugins call, wired to the core and started. */
  async #wirePluginServices(): Promise<void> {
    this.pluginServices = new PluginServices(
      path.join(this.layout.engineHomes, "plugins", "data"),
      { genex: path.join(this.layout.engineHomes, "genex") },
      (binding, files, still, clip) => {
        if (clip) return this.#observeClip(binding, clip);
        return still ? this.#observeStill(binding, still) : this.#observeAssets(binding, files);
      },
    );
    this.pluginServices.onEvent = (id, event, binding) =>
      this.emit(UiEvent.PluginEvent, { id, event, project: binding?.project, threadId: binding?.threadId });
    this.pluginServices.onDelivered = (id, delivered, binding) => this.#recordDelivery(id, delivered, binding);
    this.engineLinks = createEngineLinks({
      root: (id) => this.pluginServices.root(id),
      gameDir: (project) => this.games.dirFor(project),
      append: async (record, threadId) => {
        await this.append([record], threadId);
      },
      changed: (project) => this.emit(UiEvent.GameChanged, { project }),
      gameThread: (project) => this.threadForGame(project),
      now: () => new Date(),
      catalog: () => this.plugins.engines(),
      // A link that set its project up: Undo has the plugin take the set-up back, unasked (the Undo is the person's).
      undoSetUp: async (pluginId, game, project) => {
        const args: EngineUndoSetUpArgs = { project, ifSetUp: true };
        await this.plugins.action(pluginId, EngineHostAction.UndoSetUp, args, await this.pluginBinding(game));
      },
    });
    this.pluginServices.engineLinks = this.engineLinks;
    // `game.snapshot`: an ordinary game snapshot, in Rewind under the plugin's reason.
    this.pluginServices.gameSnapshot = async (binding, reason) => ({
      snapshotId: (await this.snapshot(SnapshotScope.Game, reason, binding.project)).snapshot_id,
    });
    // `game.create`: an ordinary new game, as the library makes one, for a project made with none open.
    this.pluginServices.gameCreate = async (title) => {
      const game = await this.createGame(title);
      return { project: game.name, directory: game.dir };
    };
    // `game.engine.runs`: the games whose run is going, so an engine plugin never quits an editor a Loop uses.
    this.pluginServices.runningGames = () => this.#runningGames();
    // `game.engine.assist`: Do it for me, a setup task handed to the game's chat (`desktop-assist.ts`).
    this.pluginServices.engineAssist = (pluginId, binding, task, call) =>
      engineAssist(coreAssistHost(this), { pluginId, binding, task, ...call });
    // `game.engine.canAssist`: whether that can run here, so a plugin shows its click path instead.
    this.pluginServices.engineCanAssist = (pluginId) => assistAvailable(coreAssistHost(this), pluginId);
    this.plugins = new PluginRegistry(
      path.join(this.layout.engineHomes, "plugins"),
      path.join(this.options.paths.resources, "plugins"),
      path.join(this.options.paths.resources, "plugin-sdk/backend.mjs"),
      (id, method, args, binding, invocation) => this.pluginServices.call(id, method, args, binding, invocation),
    );
    const nativePlugins = new PluginNativeServices(this.options.paths.userData, [this.layout.secrets]);
    this.#nativePlugins = nativePlugins;
    this.plugins.nativeService = (manifest, directory, method, args, binding, invocation) =>
      nativePlugins.call(
        manifest,
        directory,
        this.pluginServices.root(manifest.id),
        method,
        args,
        binding,
        invocation,
        (event) => this.pluginServices.onEvent?.(manifest.id, event, binding),
      );
    this.pluginServices.assetLimits = (id) =>
      this.plugins.list().find((p) => p.manifest.id === id)?.manifest.assetLimits;
    this.pluginServices.assetRoot = async (binding) => {
      const own = deliveryFolderFor(await this.games.factsOf(binding.project).catch(() => []));
      if (own) return path.join(binding.directory, own);
      const shape = await readProjectShape(binding.directory);
      return shape.build ? path.join(binding.directory, "public") : binding.directory;
    };
    this.plugins.seedEnabled = pluginSeedEnabled(this.#settings);
    // The Genex account is the app's: Genex off takes the agent's tools, never the sign-in or Publish.
    this.plugins.appAccount = { id: GENEX_PLUGIN_ID, actions: GENEX_ACCOUNT_ACTIONS };
    this.plugins.onChange = (c) => {
      this.emit(UiEvent.PluginsChanged, c);
      this.#connections.changed();
    };
    this.plugins.consent = (id, tool, args, binding, signal, options) =>
      this.requestConsent(id, tool, args, binding, signal, undefined, options);
    this.plugins.agentWritable = (directory) => this.#agentWritable(directory);
    // A Finder-launched app has a bare PATH: Genex's publish found no git-lfs from Homebrew there.
    this.plugins.toolPath = async () => (await toolchain()).path;
    this.plugins.hostTool = genexHostTool({ cli: this.#genexCli(), packages: this.#genexPackages() });
    this.plugins.hostToolConsent = genexHostPreflight(this.#genexPackages());
    this.pluginServices.exportStage = async (binding, target, pluginId) => {
      // A panel's or toolbar's own publish reaches only here: refused as the dialog and agent tool refuse it.
      await assertPublishable(this, binding.project);
      const result = await this.exportPublicCopy(binding.project, target);
      // The person saw and approved exactly these files in Studio's Publish dialog moments ago.
      if (!this.#exportApprovals.take(pluginId, binding.project, result))
        await this.#pluginTools.reviewExport(pluginId, binding, result);
      return result;
    };
    await this.plugins.init();
  }

  /**
   * `genex__cli`: Studio's pinned Genex CLI, run in the sandbox in a folder under userData that no
   * agent can write, never in a game, which it may not write either.
   */
  #genexCli(): GenexCliService {
    return new GenexCliService({
      run: (request) => this.sandbox.run(request),
      credentialFile: () => this.plugins.hostCredentialFile(GENEX_PLUGIN_ID),
      heldCredentials: () => this.plugins.heldCredentials(),
      runsRoot: path.join(this.options.paths.userData, "genex-cli"),
      resources: this.options.paths.resources,
      genexStorage: this.pluginServices.root(GENEX_PLUGIN_ID),
      protectedWrites: async () => [this.games.root, ...(await this.games.list()).map((game) => game.dir)],
      ...(this.options.execPath ? { execPath: this.options.execPath } : {}),
    });
  }

  /** `genex__package`: a pinned Genex SDK install into the bound game or its Studio worktree. */
  #genexPackages(): GenexPackageService {
    return new GenexPackageService({
      // The builds are made after the plugins; a tool call only ever comes later.
      addPackages: async (source, names) =>
        this.builds.addPackages({ ...source, guarded: await this.scriptsGuarded(source.project) }, names),
      gameDir: (project) => this.games.dirFor(project),
      scratch: this.layout.scratch,
    });
  }

  /**
   * How delivered files look in the game: served headless, which of them the page loaded, how
   * its audio played, and a screenshot.
   */
  async #observeAssets(binding: PluginBinding, files: string[]) {
    const project = binding.project,
      root = binding.directory;
    const session = this.#previews.sessionPortFor({ label: `asset:${project}` });
    try {
      const port = await session.get();
      // HTTP exposes responseStatus in resource timing; the private game:// scheme may not.
      const loaded = await this.#previews.loadServed(port, project, root, undefined, true);
      if (loaded.problem) throw new Error(loaded.problem);

      const observed = (await port.evaluate(loadedFilesScript(files))) as unknown;
      const audioFiles = files.filter(isAudioFile);
      const audio = audioFiles.length
        ? await port.evaluate(`(${observeMediaPlayback.toString()})(${JSON.stringify(audioFiles)})`)
        : undefined;

      return {
        audio: Array.isArray(audio) ? (audio as Awaited<ReturnType<typeof observeMediaPlayback>>) : undefined,
        image: await port.screenshot(),
        loadedFiles: Array.isArray(observed) ? files.filter((file) => observed.includes(file)) : [],
        consoleAvailable: port.status().consoleAvailable === true,
      };
    } finally {
      await session.release();
    }
  }

  /**
   * A plugin's still of one named view (`observe` with `still`): on a hidden window of its own at
   * the asked size, never Live, given back however it ends (`core/view-still.ts`).
   */
  #observeStill(binding: PluginBinding, still: PluginStillOrder): Promise<PluginStillAnswer> {
    return viewStill(this.#previews, binding, still, this.options.pluginStill);
  }

  /**
   * A plugin's clip of a moment a demo stages (`observe` with `clip`): recorded on a hidden window
   * of its own at the asked size, never Live, given back however it ends (`core/view-clip.ts`).
   */
  #observeClip(binding: PluginBinding, clip: PluginClipOrder): Promise<PluginClipAnswer> {
    return viewClip(this.#previews, binding, clip, this.options.pluginClip);
  }

  /**
   * The delivery record is the host's, not the plugin's: it is written after the files have
   * landed, so a plugin can neither forge one nor stay quiet about a delivery it made.
   */
  async #recordDelivery(
    id: string,
    { jobId, files }: { jobId: string; files: string[] },
    binding: PluginBinding,
  ): Promise<void> {
    const root = binding.directory;
    await this.assetCheckpoints.record(binding.project, root, id, jobId, files);
    const landed: AssetDeliveredPayload["files"] = [];
    for (const raw of files) {
      const file = raw.split(path.sep).join("/");
      const size = (await stat(path.join(root, ...file.split("/"))).catch(() => null))?.size ?? 0;
      landed.push({ file, bytes: size, kind: assetKind(file) });
    }
    const asked = this.#x.pluginCallAttribution.get(binding);
    // A Loop run delivers into its own worktree; those files reach the game only when it lands.
    const game = await realpath(this.games.dirFor(binding.project)).catch(() => null);
    const workspace: AssetDeliveredPayload["workspace"] =
      game && (await realpath(root).catch(() => root)) === game ? "game" : "build";
    const payload: AssetDeliveredPayload = {
      project: binding.project,
      source: id,
      pluginId: id,
      jobId,
      files: landed,
      at: new Date().toISOString(),
      workspace,
      ...(binding.threadId ? { threadId: binding.threadId } : {}),
      ...(asked?.runId ? { runId: asked.runId } : {}),
      ...(asked?.facetId ? { facetId: asked.facetId } : {}),
      ...(asked?.iteration !== undefined ? { iteration: asked.iteration } : {}),
    };
    await this.append(
      [customEventData(CustomEvent.AssetDelivered, { ...payload })],
      binding.threadId ?? this.mainThread,
    ).catch(() => {});
    this.emit(UiEvent.AssetDelivered, payload);
  }

  /**
   * Beside the plugins, and for the same reason: a connector is a tool source the host owns.
   * The list is a plain file under engine-homes (names only, 0o600); the values its names point
   * at live in the OS secret store, and a profile without one simply has no secrets to give.
   */
  async #wireMcp(): Promise<void> {
    const secrets = await mcpSecretPort(path.join(this.layout.engineHomes, "mcp", "secrets"));
    this.#mcpSecrets = secrets.port;
    this.mcp = new McpRegistry({
      file: path.join(this.layout.engineHomes, "mcp", "connectors.json"),
      secrets: secrets.port,
      secretsLocked: secrets.locked,
      resolveProject: async (project) => {
        const dir = this.games.dirFor(project);
        await this.assertProjectAllowed(dir);
        return dir;
      },
      onChange: (change) => {
        this.emit(UiEvent.McpChanged, change);
        this.#connections.changed();
      },
    });
    await this.mcp.init();
    // A plugin may ship MCP servers of its own. They are connectors the plugin owns: published
    // here when it is enabled, withdrawn the moment it is not, and trusted by the install dialog
    // the user already answered rather than by the connector trust dialog a typed-in one needs.
    this.plugins.mcpHost = {
      register: (pluginId, servers, launch) => this.#pluginTools.registerPluginMcpServers(pluginId, servers, launch),
      unregister: (pluginId) => this.mcp.unregisterPlugin(pluginId),
      erase: (pluginId, serverIds) => this.mcp.erasePluginSecrets(pluginId, serverIds),
    };
    await this.plugins.syncMcpServers();
  }

  #createBuilds(): GameBuilds {
    return new GameBuilds({
      root: path.join(this.layout.scratch, "builds"),
      run: (request) => this.sandbox.run(request),
      // A worktree the app made is already ours: it is built where it stands. Anything else is
      // a folder the user owns, and the studio does not write build output into those.
      ours: (dir) => isInside(this.layout.scratch, dir),
    });
  }

  /** The engines the options name, or the app's own local three. */
  #registerEngines(): void {
    const engines = this.options.engines ?? this.#defaultEngines();
    for (const engine of engines) this.engines.register(engine);
    // This fork runs entirely on the person's own hardware: the local server (their LM Studio,
    // llama.cpp or TabbyAPI) is the engine of first resort, then the managed Bonsai runtime,
    // then their Ollama. No subscription or metered engine is registered, so no run can leave
    // the machine or spend anything.
    this.engines.setPreferredOrder([EngineId.LocalServer, EngineId.Bonsai, EngineId.Ollama]);
  }

  #defaultEngines(): Engine[] {
    return [
      new BonsaiEngine({
        scratchRoot: path.join(this.layout.scratch, EngineId.Bonsai),
        root: path.join(this.layout.engineHomes, EngineId.Bonsai),
        protectedPaths: this.#protectedPaths(),
        toolPath: async () => (await this.sandbox.toolPath()) ?? process.env.PATH ?? "",
      }),
      new OllamaEngine({ ...(this.options.ollamaHost ? { host: this.options.ollamaHost } : {}) }),
      // The person's own model server (LM Studio, llama.cpp, TabbyAPI, …), once connected in Settings.
      new LocalServerEngine({
        root: path.join(this.layout.engineHomes, EngineId.LocalServer),
        scratchRoot: path.join(this.layout.scratch, EngineId.LocalServer),
        protectedPaths: this.#protectedPaths(),
        toolPath: async () => (await this.sandbox.toolPath()) ?? process.env.PATH ?? "",
        settings: serverSettings(path.join(this.layout.engineHomes, EngineId.LocalServer, "server.json")),
        keys: secretKeyStore(path.join(this.layout.secrets, "providers"), LOCAL_SERVER_KEY_SECRET),
        ...(this.options.ollamaHost ? { ollamaHost: this.options.ollamaHost } : {}),
        onModelsChanged: () => this.emit(UiEvent.EnginesChanged, { engine: EngineId.LocalServer }),
      }),
      // Local-only fork: the cloud engines (Claude Code, Codex, OpenCode, OpenRouter) are not
      // registered. Their implementations stay in the tree (and smoke/acceptance can still name
      // them through options.engines), so the app has no way to reach a subscription or a
      // metered API: every run happens on the person's own hardware.
    ];
  }

  /**
   * Local-only fork: connect the person's own model server without being asked. When no server
   * is saved yet, probe the usual ports and keep the best that answers — LM Studio first, then
   * the one listing the most models — so the studio opens ready to build on this machine's
   * models. A server the person saved always wins, and a probe that finds nothing changes
   * nothing: Settings keeps the manual connect. Never awaited at startup; a slow or absent
   * server must not hold the app open.
   */
  async connectLocalServer(): Promise<void> {
    if (!this.engines.has(EngineId.LocalServer)) return;
    const engine = this.engines.get(EngineId.LocalServer) as LocalServerEngine;
    const status = await engine.status().catch(() => null);
    if (status?.code !== EngineStatusCode.NotInstalled) return;
    const found = await engine.find().catch(() => []);
    const usable = found.filter((server) => !server.needsKey && server.models > 0);
    const pick =
      usable.find((server) => server.kind === LocalServerKind.LmStudio) ??
      usable.sort((a, b) => b.models - a.models)[0];
    if (!pick) return;
    const result = await engine.connect({ url: pick.url }).catch(() => null);
    if (result?.ok) this.emit(UiEvent.EnginesChanged, { engine: EngineId.LocalServer });
  }

  #createHarnessHost(): HarnessHost {
    return new HarnessHost({
      workspace: this.layout.harnessWs,
      bootstrap: path.join(this.options.paths.resources, "harness-boot", "bootstrap.mjs"),
      execPath: this.options.execPath ?? process.execPath,
      ...(this.options.runAsNode ? { runAsNode: true } : {}),
      sandbox: this.sandbox,
      api: this.api(),
      updatesDir: this.layout.updates,
      // The harness's environment is an allow-list: the run overrides are handed on by name.
      env: harnessRunEnv(process.env),
      heartbeatTimeoutMs: HARNESS_HEARTBEAT_TIMEOUT_MS,
      crashLoop: HARNESS_CRASH_LOOP,
      onNotify: (type, payload) => this.#onHarnessNotify(type, payload),
      ...(this.options.onLog ? { onLog: this.options.onLog } : {}),
      onStateChange: (state) => {
        // A loop that stops (a planned restart too) never ends the turns it began.
        if (state !== HarnessState.Ready) {
          this.#x.openTurns.clear();
          this.#x.harnessGeneration++;
        }
        this.emit(UiEvent.HarnessState, { state });
      },
      onUnexpectedExit: async () => {
        const died = await this.#recovery.onHarnessDied();
        // A pause the reborn loop writes for one of these runs came from this crash.
        this.#autoResume.noteCrash(died.openRuns);
        return died;
      },
      onCrashLoop: (exits) => this.recover(`harness crashed ${exits.length}× in a row`),
      onWedged: (silenceMs) => this.recover(`harness stopped responding for ${Math.round(silenceMs / SECOND_MS)}s`),
    });
  }

  // ── lifecycle ────────────────────────────────────────────────────────────────────────────
  /**
   * `resetHarness`: the user's "Reset harness to shipped version" after a start that could not
   * recover — the shipped seed is copied over the harness before it boots.
   */
  async start(bootReason: BootReason = BootReason.ColdStart, options: { resetHarness?: boolean } = {}): Promise<void> {
    await this.snapshots.init();
    await this.#threads.adoptOrphanedGameThreads().catch(() => {}); // a repair must never block the boot
    await this.#recovery
      .closeInterruptedWork()
      .catch((err) => this.options.onLog?.(`[core] closing interrupted work failed: ${errorMessage(err)}`, "stderr"));
    // If a self-update was in flight when the app died, the durable record says so.
    const pending = await this.journal.pending();
    await this.#announceSeedUpgrade();
    const rewound = await this.#bootHarness(bootNotice(pending, bootReason), options.resetHarness === true);
    this.#started = true;
    // The first read of the whole log is the slow one; take it once the boot has settled rather
    // than on the first Activity open or Studio message.
    this.#activityWarmup = setTimeout(() => void this.activityItems().catch(() => {}), ACTIVITY_WARMUP_DELAY_MS);
    this.#activityWarmup.unref?.();
    void this.#probeSubscriptions();

    // Self-improving background (A6): requeue any job the last shutdown interrupted, then
    // watch for idle windows. No clock scheduling — "nightly" is dead.
    await this.improvements.sweep().catch(() => {});
    if (this.options.executionPolicy?.runBackgroundImprovement !== false) this.#selfImprovement.startIdleWatch();
    await this.#settlePendingUpdates(pending, rewound);
  }

  /** The reborn agent (and the morning report) can see that the app updated parts of its self. */
  async #announceSeedUpgrade(): Promise<void> {
    const upgraded = seedUpgradedPayload(this.#x.seedReport);
    if (!upgraded) return;
    await this.append([customEventData(CustomEvent.SeedUpgraded, { ...upgraded })]);
    this.emit(UiEvent.SeedUpgraded, { ...upgraded });
  }

  /**
   * PROD-1: a self that cannot boot at launch is rewound here, the way the watchdog would have
   * done it had the app stayed up. The host leaves this boot's failure to us (no background
   * crash restart racing the rewind); the error surfaces only if the rewound self fails too.
   * A workspace still on the JavaScript layout moves to TypeScript here, before it boots, and
   * only once a fork of it has booted migrated (RecoveryService.migrateHarnessLayout).
   * Resolves whether the self that booted was rewound (or reset) rather than the one on disk.
   */
  async #bootHarness(notice: BootNotice, resetHarness: boolean): Promise<boolean> {
    if (!resetHarness) await this.#recovery.migrateHarnessLayout();
    let rewound = false;
    const bootedCode = resetHarness ? null : await this.#recovery.codeAboutToBoot();
    if (resetHarness) {
      await this.#resetHarnessToShipped();
      rewound = true;
    }
    try {
      await this.host.start({ type: DispatchActionType.BootNotice, notice }, { callerRecovers: true });
    } catch (err) {
      await this.#rewindFailedBoot(err);
      rewound = true;
    }
    if (rewound || !bootedCode) return rewound;
    if (await this.host.healthcheck().catch(() => false)) this.#recovery.vouchForBootedSelf(bootedCode);
    return false;
  }

  async #resetHarnessToShipped(): Promise<void> {
    await this.host.stop().catch(() => {});
    await this.#recovery.reseedFromApp();
    await this.append([customEventData(CustomEvent.HarnessReseeded, { reason: MESSAGE.resetByUser })]);
  }

  /** Rewind a self that could not boot; rethrows when the rewound self does not come up either. */
  async #rewindFailedBoot(err: unknown): Promise<void> {
    const message = errorMessage(err);
    this.options.onLog?.(`[core] the harness could not boot at startup: ${message}`, "stderr");
    await this.host.stop().catch(() => {});
    // A self the layout migration just moved to TypeScript, which booted in its trial copy but
    // not here: the rewind below goes back past it, and the migration is not retried unchanged.
    await this.#recovery.migratedSelfDidNotBoot(message);
    await this.recover(`boot failed at startup: ${message}`);
    if (this.host.state !== HarnessState.Ready) throw err;
  }

  /** Close the self-updates the last session left in flight, now that the harness answered (or not). */
  async #settlePendingUpdates(pending: UpdateRecord[], rewound: boolean): Promise<void> {
    for (const record of pending) {
      // After a rewind the self that answers is not the update's: it failed, and its snapshot
      // must not be marked healthy.
      const ok = !rewound && (await this.host.healthcheck());
      await this.journal.complete(record.id, ok ? "applied" : "failed", updateFailure(ok, rewound));
      // The reborn agent learns about its own restart by reading its own log.
      await this.append([
        customEventData(CustomEvent.RebuildAndRestartStudio, { updateId: record.id, ok, reason: record.reason }),
      ]);
      if (ok && record.snapshot_id) this.#recovery.markHealthy(record.snapshot_id);
    }
  }

  async stop(): Promise<void> {
    this.#planReviews?.stop();
    // A pause appended before `start()` may have planned a resume: it, and the hold on the Mac
    // awake that it asked for, end with the core either way.
    this.#autoResume.dispose();
    // `init()` opened the sandbox and the job registry, so a core that never started still stops
    // the jobs it was handed and gives the sandbox back.
    if (!this.#started) {
      await this.#stopJobs();
      return this.sandbox?.dispose();
    }
    this.#started = false;
    this.plugins?.cancel();
    this.#consent.cancel({}, "stop");
    this.#permissions.cancel({}, ToolPermissionBy.Stop);
    if (this.#x.idleTimer) clearInterval(this.#x.idleTimer);
    this.#x.idleTimer = null;
    if (this.#activityWarmup) clearTimeout(this.#activityWarmup);
    // No orphan contractors: a delegation must not outlive the studio that briefed it. (The
    // first live build's contractor survived an app restart and collided with its successor.)
    for (const delegation of this.#x.activeDelegations.values()) delegation.abort.abort();
    this.#x.activeDelegations.clear();
    for (const set of this.#x.activeCompletions.values()) for (const controller of set) controller.abort();
    this.#x.activeCompletions.clear();
    // The harness first: it runs detached, so it is the one thing the app's exit would leave
    // running, and nothing below (a lease release, previews, slow connectors) may use up its time.
    await this.host.stop().catch(() => {});
    // Jobs next: detached process groups too, and nothing below may keep them running.
    await this.#stopJobs();
    // A release that fails (a pending plugin update that cannot activate) is logged, never allowed
    // to skip the previews and connectors below it. It runs before the connectors close, so a
    // server an activated update starts is closed with them.
    for (const release of this.#x.pluginTurnLeases.values())
      await release().catch((error) =>
        this.options.onLog?.(`[core] plugin lease release failed on stop: ${errorMessage(error)}`, "stderr"),
      );
    this.#x.pluginTurnLeases.clear();
    await this.#x.previewPool?.disposeAll().catch(() => {});
    // A connector's child process belongs to this studio, not to the Mac: it goes when we go.
    await this.mcp?.close().catch(() => {});
    await this.ollamaSidecar.stop().catch(() => {});
    await Promise.all(this.engines.all().map((engine) => engine.dispose?.().catch(() => {})));
    await this.budget.flush().catch(() => {});
    // Last: everything above that ran sandboxed has stopped.
    await this.sandbox?.dispose();
  }

  /**
   * The subscription the studio would hire if nobody said which: the first one signed in, in
   * preference order. Falls back to the first registered so the error a caller gets names an
   * engine that exists.
   */
  async defaultDelegatedEngine(): Promise<string> {
    for (const id of SUBSCRIPTION_ENGINES) {
      if (!this.engines.has(id)) continue;
      const status = await this.engines
        .get(id)
        .status()
        .catch(() => ({ code: EngineStatusCode.Error }));
      if (status.code === EngineStatusCode.Ready) return id;
    }
    // Local-only fork: no subscription is registered, so name the first engine that exists
    // rather than one the registry would refuse as unknown.
    return this.engines.ids()[0] ?? SUBSCRIPTION_ENGINES[0];
  }

  /**
   * Ask every subscription engine whether its session is actually alive. Credential *files*
   * outlive dead logins, so the cheap `status()` can say ready for an account that will refuse
   * the first brief of the run.
   */
  async #probeSubscriptions(): Promise<void> {
    for (const id of SUBSCRIPTION_ENGINES) {
      const engine = this.engines.has(id) ? (this.engines.get(id) as { probeAuth?: () => Promise<unknown> }) : null;
      if (!engine?.probeAuth) continue;
      await engine.probeAuth().catch(() => {});
      this.emit(UiEvent.EnginesChanged, { engine: id });
    }
  }

  // ── the event log ────────────────────────────────────────────────────────────────────────
  async append(batch: EventData[], threadId = this.mainThread): Promise<string> {
    const result = await this.store.appendEvents(threadId, batch);
    const changedRuns = new Set<string>();
    for (const event of result.events) {
      this.#indexEvent(event);
      const runId =
        event.data.type === EventKind.Custom ? (event.data.payload as { runId?: string })?.runId : undefined;
      if (runId) changedRuns.add(runId);
      // A run that starts, pauses or closes ends any finish check it had under way.
      if (runId && event.data.type === EventKind.Custom && isExecutionEvent(event.data))
        this.#finishReviews.drop(runId);
      const leaseTurn =
        event.data.type === EventKind.TurnStarted && this.plugins && !this.#x.pluginTurnLeases.has(threadId);
      if (leaseTurn) this.#x.pluginTurnLeases.set(threadId, this.plugins.lease());
      if (event.data.type === EventKind.TurnEnded) {
        this.#cancelConnectorCalls({ threadId }, "turn");
        const release = this.#x.pluginTurnLeases.get(threadId);
        this.#x.pluginTurnLeases.delete(threadId);
        await release?.();
        // A turn that ended took its unanswered questions and its connector calls with it — the
        // card says so. A build's lead's go on: it is not that turn.
        this.#consent.cancel({ threadId }, "turn");
        this.#permissions.cancel({ threadId }, ToolPermissionBy.Turn);
      }
    }
    for (const runId of changedRuns) this.emit(UiEvent.RunSummaryChanged, { runId });
    this.#autoResume.observe(threadId, result.events);
    // Off the append's path: reading the game's folder never holds up the log.
    void noteBuildEnd(this.#buildEnds, threadId, result.events).catch(() => {});
    return result.latestEventId;
  }

  /** How `append` tells the game list what a build's end changed (`core/build-ends.ts`). */
  readonly #buildEnds: BuildEndDeps = {
    gameOf: async (threadId) => gameOfThread((await this.store.getRecord(threadId).catch(() => null))?.metadata),
    awaiting: async (project) => (await this.games.presentation(project)).awaitingFirstBuild === true,
    kindOf: (project) => this.games.kindOf(project),
    markBuilt: (project) => this.games.markBuilt(project),
    multiplayer: (project) => usesGenexMultiplayer(this.games.dirFor(project)),
    toldMultiplayer: new Map(),
    changed: (project) => this.emit(UiEvent.GameChanged, { project }),
  };

  #indexEvent(event: EventEnvelope): void {
    if (event.data.type === EventKind.SnapshotCreated) {
      this.snapshotIndex.add({
        snapshot_id: event.data.snapshot_id,
        scope: event.data.scope,
        git: event.data.git,
        created_at: event.created_at,
        reason: event.data.reason ?? "",
        healthy: event.data.healthy ?? false,
        ...(event.data.harness_healthy === false ? { harness_healthy: false as const } : {}),
      });
    }
    if (event.data.type === EventKind.Custom && event.data.event_type === CustomEvent.SnapshotHealthy) {
      const payload = event.data.payload as { snapshot_id?: string };
      if (payload?.snapshot_id) this.snapshotIndex.markHealthy(payload.snapshot_id);
    }
  }

  /** Announce a UI event to the renderer (`shared/ui-events.ts`); the payload is checked against the map. */
  emit<K extends UiEventType>(type: K, payload: UiEventMap[K]): void {
    const event = uiEvent(type, payload);
    if (event.type === UiEvent.GameChanged && event.payload.project) {
      const { project } = event.payload;
      this.#x.gameChanges.set(project, (this.#x.gameChanges.get(project) ?? 0) + 1);
    }
    this.options.onUiEvent?.(event);
  }

  /**
   * The credential values this process holds right now: credential-named environment variables,
   * connector and OAuth values unlocked this session, and unlocked plugin account tokens (the
   * Genex token among them). The log redactor and the public export check use this one set.
   */
  knownSecretValues(): string[] {
    return [
      ...credentialEnvValues(process.env),
      ...(this.mcp?.secretValues() ?? []),
      ...(this.plugins?.heldCredentials() ?? []),
    ];
  }

  /**
   * The events Activity and Studio's context read, kept current by reading only what each
   * thread appended since the last call. Reading the whole log instead took about fifteen
   * seconds on a real install (77k events, 60 MB), and Activity asked again after every event
   * while it was open — during a run, loads piled up faster than they finished.
   */
  async activityEvents(): Promise<EventEnvelope[]> {
    await this.#readActivity();
    return this.#activityIndex.records();
  }

  /**
   * The games whose run is going now: held awake by the harness, and running by its records. Asks
   * nothing while no run holds the studio awake, so an engine plugin's frequent status stays cheap.
   */
  async #runningGames(): Promise<Array<{ project: string; directory: string; title: string }>> {
    if (this.#x.activeRunIds.size === 0) return [];
    const running = new Set<string>();
    for (const item of await this.activityItems()) {
      const going = item.runId !== undefined && this.#x.activeRunIds.has(item.runId);
      if (going && item.project && item.runOutcome?.state === ExecutionStatus.Running) running.add(item.project);
    }
    const games = running.size ? await this.games.list() : [];
    return games
      .filter((game) => running.has(game.name))
      .map((game) => ({ project: game.name, directory: game.dir, title: game.title || game.name }));
  }

  /** Incrementally folded Activity rows without retaining the run's raw event history. */
  async activityItems(): Promise<StudioActivityItem[]> {
    await this.#readActivity();
    return this.#activityIndex.items();
  }

  #readActivity(): Promise<void> {
    const turn = this.#activityTurn.then(() => this.#refreshActivity());
    this.#activityTurn = turn.catch(() => undefined);
    return turn;
  }

  async #refreshActivity(): Promise<void> {
    const threads = await this.store.listThreads();
    const live = new Set(threads.map((thread) => thread.id));
    const removed = [...this.#activity.keys()].some((id) => !live.has(id));
    const rewound = threads.some((thread) => {
      const cursor = this.#activity.get(thread.id);
      return (
        cursor !== undefined && cursor !== null && (thread.latest_event_id === null || thread.latest_event_id < cursor)
      );
    });
    if (removed || rewound) this.#resetActivity();
    const read = async (all: boolean) => {
      const batches = await Promise.all(
        threads.map(async (thread) => {
          const cursor = all ? null : this.#activity.get(thread.id);
          if (cursor === thread.latest_event_id) return [];
          const fresh = await this.store.listEvents(thread.id, {
            ...(cursor ? { after: cursor } : {}),
            ...(thread.latest_event_id ? { upToInclusive: thread.latest_event_id } : {}),
          });
          this.#activity.set(thread.id, thread.latest_event_id);
          return fresh.filter(feedsActivity);
        }),
      );
      return batches.flat().sort(byLogOrder);
    };
    if (!this.#activityIndex.append(await read(false))) {
      // A newly imported thread may contain older records: rebuild from durable logs once.
      this.#resetActivity();
      this.#activityIndex.append(await read(true));
    }
  }

  #resetActivity(): void {
    this.#activity.clear();
    this.#activityIndex = new ActivityIndex();
  }

  /**
   * Every thread's events after `after`. A caller that follows the log with a cursor uses
   * `store.listAllSince` and its returned cursor, never the last event's id: an event appended to
   * an earlier thread during the read sorts before a later thread's newest one.
   */
  async listAllEvents(after?: string, limit?: number): Promise<EventEnvelope[]> {
    return (await this.store.listAllSince(after, limit)).events;
  }

  /** A harness notification: forwarded to the renderer as it came, and read for idleness and auto-apply. */
  #onHarnessNotify(type: string, payload: unknown): void {
    if (isHostOnlyUiEvent(type)) return;
    const event = harnessUiEvent(type, payload);
    this.options.onUiEvent?.(event);
    // Idle detection: a run holding keep-awake means the studio is working, not idle. The harness
    // is agent-editable, so its payload may be missing: read it optionally.
    if (event.type === UiEvent.RunKeepawake) {
      const runId = event.payload?.runId;
      if (runId) this.#x.activeRunIds.add(runId);
      this.#previews.refreshVisibility();
    }
    if (event.type === UiEvent.RunSettled) {
      const runId = event.payload?.runId;
      if (runId) this.#x.activeRunIds.delete(runId);
      // The run's own settle ends its jobs (its lead's and its workers'); a harness that dies
      // settles runs without this notice, and its runs' jobs go on until they end or Genex quits.
      if (runId) this.#stopRunJobs(runId);
      this.#previews.refreshVisibility();
    }
    // Auto-mode: an improvement that won its blind gate lands the moment it is staged. The same
    // path as the Apply button — snapshot first, logged, reversible — just without the wait.
    if (event.type === UiEvent.SkilloptStaged && this.#autoApplies()) {
      void this.#selfImprovement.autoApplyStaged().catch((err) => {
        this.emit(UiEvent.SkilloptAutoApplyFailed, { error: errorMessage(err) });
      });
    }
  }

  // ── settings ─────────────────────────────────────────────────────────────────────────────
  get settings(): StudioSettings {
    return { ...this.#settings };
  }

  async updateSettings(patch: Partial<StudioSettings>): Promise<StudioSettings> {
    const next = { ...this.#settings, ...patch };
    // Builders are the user's number and the pool follows; a pool size alone still works.
    if (patch.buildersMax === undefined && patch.agentsMax !== undefined) {
      next.agentsMax = clampAgents(patch.agentsMax);
      next.buildersMax = clampBuilders(next.agentsMax - LEAD_WINDOWS);
    } else {
      next.buildersMax = clampBuilders(next.buildersMax);
      next.agentsMax = next.buildersMax + LEAD_WINDOWS;
    }
    // Only an explicit true turns the computer over; anything else the page sends reads as off.
    next.computerControl = next.computerControl === true;
    const computerOff = this.#settings.computerControl && !next.computerControl;
    this.#settings = next;
    // Turning computer control off stops every desktop session's driver now, as ⌃⌥⌘Esc does.
    if (computerOff) await this.options.desktop?.stopAll();
    // Atomic (CQ-3): a torn write would read back as defaults at the next start. The default goes
    // beside the settings so the next start can tell a worker count someone chose from one never touched.
    const saved: SavedSettings = { ...this.#settings, buildersDefault: DEFAULT_BUILDERS };
    await atomicWriteJson(this.#settingsFile(), saved);
    // The pool follows the setting at once; a run already going sizes its next round to it.
    if (this.#x.previewPool && this.options.previewPoolMax === undefined)
      this.#x.previewPool.max = this.#settings.agentsMax;
    this.emit(UiEvent.SettingsChanged, this.settings);
    // Turning automatic apply (or learning itself) on sweeps anything already waiting.
    if (this.#autoApplies()) void this.#selfImprovement.autoApplyStaged().catch(() => {});
    return this.settings;
  }

  /** Learning and self-improving both on: a staged improvement applies itself. */
  #autoApplies(): boolean {
    return this.#settings.learning && this.#settings.selfImproving;
  }

  #settingsFile(): string {
    return path.join(this.options.paths.userData, "settings.json");
  }

  async #loadSettings(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.#settingsFile(), "utf8")) as SavedSettings;
      const buildersMax = savedBuildersMax(parsed);
      this.#settings = {
        learning: parsed.learning !== false,
        selfImproving: savedSelfImproving(parsed),
        architect: parsed.architect === true,
        buildersMax,
        agentsMax: buildersMax + LEAD_WINDOWS,
        blender: parsed.blender !== false,
        autoResume: parsed.autoResume !== false,
        // Off unless the person turned it on: a file from before the switch reads as off.
        computerControl: parsed.computerControl === true,
      };
    } catch {
      /* first launch — defaults stand */
    }
  }

  // ── threads ──────────────────────────────────────────────────────────────────────────────
  /**
   * The canonical chat for a game. Existing histories choose their most recent conversation
   * once; subsequent sidebar visits reuse that selection without creating another chat.
   */
  async threadForGame(project: string): Promise<string> {
    return serial(this.#gameThreadOperations, project, () => this.#threads.threadForGame(project));
  }

  createGameThread(
    ...args: Parameters<GameThreadService["createGameThread"]>
  ): ReturnType<GameThreadService["createGameThread"]> {
    return this.#threads.createGameThread(...args);
  }

  renameThread(...args: Parameters<GameThreadService["renameThread"]>): ReturnType<GameThreadService["renameThread"]> {
    return this.#threads.renameThread(...args);
  }

  bindThreadToProject(
    ...args: Parameters<GameThreadService["bindThreadToProject"]>
  ): ReturnType<GameThreadService["bindThreadToProject"]> {
    return this.#threads.bindThreadToProject(...args);
  }

  // ── games ────────────────────────────────────────────────────────────────────────────────
  async createGame(title: string, options: CreateOptions = {}): Promise<GameProject> {
    // The library root is host-configured. The reserved child is checked by #readyProject;
    // the root itself is intentionally not an adoptable project in fixture profiles. A chosen
    // folder is checked before the library writes, so a refused one is left with nothing in it.
    const allowed = (real: string) => this.#assertLocationAllowed(real);
    const where = options.parent === undefined ? {} : { parent: options.parent, allowed };
    const waiting = options.provisional === true ? { provisional: true } : {};
    const ready = await this.#readyProject(await this.games.create(title, { ...where, ...waiting }));
    // The folder as it was made, once its repository exists: the chat's first build reads
    // "nothing built yet" from it (the engine question, harness-seed `delegated-turn.ts`).
    const game = await this.games.rememberScaffold(ready.name);
    await this.threadForGame(game.name);
    return game;
  }

  /** A name for a game started from its first request, before its folder is made (`core/game-naming.ts`). */
  nameGame(request: GameNameRequest): Promise<GameName> {
    return nameGame({ engines: this.engines, budget: this.budget }, request);
  }

  /** A live background for home from a description (`core/backdrop-generation.ts`). */
  makeBackdrop(request: BackdropShaderRequest): Promise<BackdropShaderResult> {
    return makeBackdropShader({ engines: this.engines, budget: this.budget }, request);
  }

  /** Games being named from an idea now: a second message while the first names it waits its turn. */
  #namingFromIdea = new Set<string>();

  /** A game whose title waits for an idea takes the name this message gives it, in place (`nameFromIdea`). */
  async nameFromIdea(project: string, request: GameNameRequest): Promise<void> {
    if (this.#namingFromIdea.has(project)) return;
    this.#namingFromIdea.add(project);
    try {
      await nameFromIdea(
        {
          games: this.games,
          name: (asked) => this.nameGame(asked),
          changed: (named) => this.emit(UiEvent.GameChanged, { project: named }),
        },
        project,
        request,
      );
    } finally {
      this.#namingFromIdea.delete(project);
    }
  }

  /**
   * A folder the user chose for a new game, checked as creating there will be: the library's
   * rules, then this launch's policy and the folders no agent may reach. The games folder itself
   * is the ordinary library.
   */
  async gameLocation(dir: string): Promise<GameLocation> {
    const real = await this.games.location(dir, (checked) => this.#assertLocationAllowed(checked));
    return { dir: real, pathLabel: this.games.pathLabel(real) };
  }

  /** This launch's rules for a chosen folder's real path: its policy, and no folder agents may not read. */
  async #assertLocationAllowed(real: string): Promise<void> {
    await this.assertProjectAllowed(real);
    for (const guarded of this.#protectedPaths()) {
      // Compared real path to real path: the Genex folder may itself be a link.
      const resolved = await realpath(guarded).catch(() => path.resolve(guarded));
      if (isInside(resolved, real)) throw new Error(MESSAGE.protectedLocation);
    }
  }

  async updateGame(project: string, patch: GameUpdate): Promise<GameProject> {
    const game = await this.games.update(project, patch);
    this.emit(UiEvent.GameChanged, { project });
    return game;
  }

  /**
   * Legacy archive callers still mark threads as recoverable history and hide the game.
   * Folder files remain on disk; a building project cannot be archived under its contractor.
   * The sidebar uses removeGame instead, preserving the active state of its conversations.
   */
  /** The person's Stop on a job's chat line: the job's record, or null for a job this game never had. */
  async stopJob(project: string, jobId: string): Promise<JobRecord | null> {
    return this.jobs.stop(project, jobId, JobStopper.Person);
  }

  /**
   * Starts the engine a bridge game's play names for the build at `root` (`EngineLauncher`): the
   * runtime an enabled plugin declares by that id, found where the plugin says, in the native-job
   * sandbox with a window and the GPU (an engine draws), reading and writing only the build, its
   * stdio open for the Play Protocol. Null off a Mac, or when no enabled plugin has it ready: the
   * play's own command runs then.
   */
  async startEngine(engine: PlayEngine, root: string): Promise<{ child: ChildProcess } | null> {
    const native = this.#nativePlugins;
    if (!native || process.platform !== StudioPlatform.Mac) return null;
    const owner = this.plugins
      .list()
      .find(
        (p) => this.plugins.enabled(p.manifest.id) && p.manifest.nativeRuntimes?.some((r) => r.id === engine.runtime),
      );
    const runtime = owner?.manifest.nativeRuntimes?.find((r) => r.id === engine.runtime);
    if (!owner || !runtime) return null;
    const found = await native.detect(runtime, this.pluginServices.root(owner.manifest.id));
    if (found.state !== NativeRuntimeState.Ready || !found.path) return null;
    const scratch = await mkdtemp(path.join(os.tmpdir(), ENGINE_SCRATCH_PREFIX));
    // A game linked to an engine project outside its folder plays that project: the engine reaches it too.
    const linked = await readEngineBinding(root, this.plugins.engines()).catch(() => undefined);
    const reach = [root, ...(linked ? [path.dirname(linked.project)] : [])];
    const child = await spawnNativeLongLived({
      binary: found.path,
      args: engine.args,
      cwd: root,
      scratch,
      reads: reach,
      writes: reach,
      denyRead: [this.layout.secrets],
      gpu: true,
    });
    child.once("close", () => void rm(scratch, { recursive: true, force: true }));
    return { child };
  }

  /**
   * The chat line's Undo of a game's engine link (`engineLinks.undo`); a link that changed since is
   * refused, and one that set its project up is refused with the plugin's reason while that set-up
   * can't be taken back.
   */
  async undoEngineLink(request: EngineLinkUndo): Promise<boolean> {
    const { project, pluginId, linkedAt, threadId } = request;
    const plugin = this.plugins.list().find((p) => p.manifest.id === pluginId);
    if (!plugin?.manifest.capabilities.includes(PluginCapability.GameEngine)) throw new Error(MESSAGE.notEnginePlugin);
    await this.assertProjectAllowed(this.games.dirFor(project));
    // The chat line belongs to this game's chat; a line from another chat says nothing there.
    const own = threadId ? threadProject(await this.store.getRecord(threadId)) === project : false;
    await this.engineLinks.undo(pluginId, project, String(linkedAt), own ? threadId : undefined);
    return true;
  }

  async archiveGame(project: string): Promise<{ dir: string; trash: boolean }> {
    if (this.#building(project)) throw new Error(MESSAGE.stillBuilding(project));
    const threads = await this.store.listThreads();
    for (const thread of threads) {
      if (threadProject(thread) === project) {
        await this.store.updateThread(thread.id, { metadata: { archived: true } });
      }
    }
    const forgotten = await this.games.forget(project);
    await this.append([customEventData(CustomEvent.GameArchived, { project, trash: forgotten.trash })]);
    this.emit(UiEvent.GameArchived, { project, trash: forgotten.trash });
    return forgotten;
  }

  /** The sidebar removal is reversible by re-adding the folder. No files or logs are changed. */
  async removeGame(project: string): Promise<void> {
    const threads = (await this.store.listThreads()).filter((thread) => threadProject(thread) === project);
    const threadWorking = threads.some(
      (thread) => this.#x.activeCompletions.has(thread.id) || this.#x.pluginTurnLeases.has(thread.id),
    );
    if (this.#building(project) || threadWorking) throw new Error(MESSAGE.workStillRunning);
    for (const thread of threads) {
      const run = latestRun(await this.store.listEvents(thread.id));
      if (run?.state === RunState.Running) throw new Error(MESSAGE.buildStillRunning);
    }
    await this.games.forget(project);
    this.emit(UiEvent.GameChanged, { project });
  }

  /** Whether a contractor is building in this game (or holds one of its folders). */
  #building(project: string): boolean {
    return [...this.#x.activeDelegations.values()].some((work) => work.project === project);
  }

  /** Builders working right now, by game: how many in each (the bootstrap's `activeDelegations`). */
  activeBuilders(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const { project } of this.#x.activeDelegations.values()) counts[project] = (counts[project] ?? 0) + 1;
    return counts;
  }

  /**
   * What a picked folder holds — every game in it and one level down, how each runs, and what
   * would stop a run. Read-only on purpose: the Open Game sheet shows this *before* the user
   * consents to anything being written (a folder used to be scaffolded the moment it was picked).
   */
  async inspectFolder(dir: string): Promise<FolderInspection> {
    await this.assertProjectAllowed(dir);
    return this.games.inspect(dir);
  }

  /**
   * Open a folder as a game, with what the user consented to in the Open Game sheet: which game
   * inside it (`subdir` — the nested game is offered as *the* game), and whether the
   * studio may write a starter game there. Adoption is the first moment anything is written.
   */
  async adoptProject(dir: string, options: AdoptOptions = {}): Promise<GameProject> {
    await this.assertProjectAllowed(dir);
    const project = await this.games.adopt(dir, options);
    return await this.#readyProject(project);
  }

  async #readyProject(project: GameProject): Promise<GameProject> {
    await this.assertProjectAllowed(project.dir);
    await this.games.touch(project.name);
    this.sandbox.allowWrite(project.dir);
    this.sandbox.denyWrite(claudeFolderDenyWrites(this.layout.gamesRoot, [project.dir]));
    this.snapshots.register({ name: project.name, dir: project.dir });
    await this.snapshots.init();
    this.emit(UiEvent.GameChanged, { project: project.name });
    return project;
  }

  async assertProjectAllowed(projectDir: string): Promise<void> {
    await assertOwnedProject(this.options.executionPolicy?.allowedProjectRoot, projectDir);
  }

  /** The files a public copy of `project` holds now: exported into scratch, listed and removed. */
  async publicCopyFiles(project: string): Promise<ExportReview> {
    const target = path.join(this.layout.scratch, "publish-review", shortId("export"));
    try {
      return sortedReview(await this.exportPublicCopy(project, target));
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  }

  /**
   * Run `publish` with `review`, the files the person approved in Studio's Publish dialog, approved
   * for `pluginId`'s export of `project`; an approval the publish did not spend ends with it.
   */
  async withApprovedExport<T>(
    pluginId: string,
    project: string,
    review: ExportReview,
    publish: () => Promise<T>,
  ): Promise<T> {
    this.#exportApprovals.approve(pluginId, project, review);
    try {
      return await publish();
    } finally {
      this.#exportApprovals.withdraw(pluginId, project);
    }
  }

  /**
   * The public copy of a game: built first when its shape builds, then staged into `targetDir`
   * by the same audited exporter the Export button uses. Plugins reach it as `export.stage`.
   */
  async exportPublicCopy(project: string, targetDir: string): Promise<ExportResult> {
    const game = (await this.games.list()).find((g) => g.name === project);
    if (!game) throw new Error(MESSAGE.gameNotFound);
    // A game whose web game is in a folder of it (an engine's web export) publishes that folder.
    const folder = webFolderOf(game);
    let output: string | undefined = folder ? path.join(game.dir, folder) : undefined;
    if (!folder && game.shape?.build) {
      const built = await this.builds.ensure({ project: game.name, dir: game.dir, shape: game.shape });
      if (!built.ok || !built.output) throw new Error(MESSAGE.exportBuildFailed);
      output = built.output;
    }
    return this.games.export(project, targetDir, output, { secretValues: this.knownSecretValues() });
  }

  async #setGameCoverShader(
    project: string,
    surface: unknown,
    threadId?: string,
    signal?: AbortSignal,
  ): Promise<LiveToolResult> {
    validateCoverSurface(surface);
    await this.assertProjectAllowed(this.games.dirFor(project));
    await this.#assertCoverThread(project, threadId);
    return serial(this.#coverOperations, COVER_RENDERER, async () => {
      signal?.throwIfAborted();
      const before = (await this.games.presentation(project)).cover;
      if (!replaceableCover(before)) return MESSAGE.shaderCoverKept;
      if (!this.options.renderGameCover) throw new Error(MESSAGE.noCoverRenderer);
      const seed = before && "seed" in before ? before.seed : coverFromBrief(project).seed;
      const poster = await this.options.renderGameCover(surface, seed);
      signal?.throwIfAborted();
      const saved = await this.games.saveGeneratedCover(project, before, {
        kind: "shader",
        version: 2,
        surface,
        seed,
        poster,
        custom: true,
      });
      if (!saved) return MESSAGE.shaderCoverRaced;
      this.emit(UiEvent.GameChanged, { project });
      await this.append(
        [customEventData(CustomEvent.GameCoverCreated, { project, kind: "shader" })],
        threadId ?? this.mainThread,
      );
      return {
        text: MESSAGE.shaderCoverSaved,
        images: [{ mimeType: "image/png", data: poster.slice(poster.indexOf(",") + 1), label: MESSAGE.coverLabel }],
      };
    });
  }

  /** A cover tool writes only the game its conversation is bound to. */
  async #assertCoverThread(project: string, threadId: string | undefined): Promise<void> {
    if (!threadId) return;
    const record = await this.store.getRecord(threadId);
    if (threadProject(record) !== project) throw new Error(MESSAGE.coverWrongGame);
  }

  /**
   * The builder's one cover choice: a recipe the host draws, in the family it named and a look no
   * other game has. An unknown look keeps the current cover.
   */
  async #setGameCover(
    project: string,
    args: Record<string, unknown>,
    threadId?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    coverRecipeFromTool(args); // An unknown look is refused before anything else.
    await this.assertProjectAllowed(this.games.dirFor(project));
    await this.#assertCoverThread(project, threadId);
    return serial(this.#coverOperations, COVER_RENDERER, async () => {
      signal?.throwIfAborted();
      const before = (await this.games.presentation(project)).cover;
      if (!replaceableCover(before)) return MESSAGE.recipeCoverKept;
      const recipe = coverRecipeFromTool(args, await this.games.coverLooksInUse(project));
      if (!(await this.games.saveGeneratedCover(project, before, recipe))) return MESSAGE.recipeCoverRaced;
      this.emit(UiEvent.GameChanged, { project });
      await this.append(
        [customEventData(CustomEvent.GameCoverCreated, { project, kind: "recipe" })],
        threadId ?? this.mainThread,
      );
      return MESSAGE.recipeCoverSaved(coverLookName(recipe));
    });
  }

  // ── the substrate API exposed to the harness ─────────────────────────────────────────────
  api(): HarnessHostHandlers {
    // The harness-facing allowlist: every method the harness may call, and nothing else. Host code
    // that needs the same work calls the service or core method directly, never this table.
    const table: HarnessHostHandlers = {
      ...gameRpc(this, this.#x),
      ...eventsRpc(this, this.#x),
      ...optimizationRpc(this, this.#x),
      ...snapshotRpc(this, this.#x),
      ...hooksRpc(this, this.#x),
      ...observersRpc(this, this.#x),
      ...finishRpc(this, this.#x),
      ...pluginsRpc(this, this.#x),
      ...runsRpc(this, this.#x),
      ...jobsRpc(this, this.#x),
      ...engineRpc(this, this.#x),
      ...studioRpc(this, this.#x),
      ...previewRpc(this, this.#x),
      ...desktopRpc(this, this.#x),
      ...judgeRpc(this),
    };
    return table;
  }

  /**
   * A folder the harness names over RPC (ARCH-1). The harness is agent-editable code, so the host
   * accepts only what it hands out itself: a game in the library (never a link someone put in the
   * library folder), and a root whose realpath is inside scratch — worktrees, candidates, builds —
   * or is that game's own folder. Checked before anything reads, builds or serves it.
   */
  /**
   * The real path of `root` once it is checked (null when none was named). Callers serve and build
   * in that path, never in `root` re-resolved later: the folder a name points at can change
   * between the check and the use (M1).
   */
  async #assertHarnessRoot(project: string, root: string | null | undefined): Promise<string | null> {
    const game = (await this.games.list()).find((listed) => listed.name === project);
    if (!game) throw new Error(MESSAGE.notInLibrary(project));
    if (root === undefined || root === null) return null;
    const real = await realpath(path.resolve(String(root))).catch(() => null);
    if (real) {
      const scratch = await realpath(this.layout.scratch);
      if (isBelow(scratch, real)) return real;
      if (real === (await realpath(game.dir).catch(() => null))) return real;
    }
    throw new Error(MESSAGE.notOurRoot(String(root), project));
  }

  /** A host-side rm follows a symlinked parent out of scratch: refuse any link on the way down. */
  async #assertNoLinkBelow(base: string, target: string): Promise<void> {
    let current = base;
    for (const part of path.relative(base, target).split(path.sep)) {
      current = path.join(current, part);
      const stats = await lstat(current).catch(() => null);
      if (!stats) return;
      if (stats.isSymbolicLink()) throw new Error(MESSAGE.linkedPath(target));
    }
  }

  // ── plugins and connectors ───────────────────────────────────────────────────────────────
  /** Every tool source the settings and the composer show, with the thread's applied revision. */
  async connectionSnapshot(threadId?: string, project?: string | null): Promise<ConnectionSnapshot> {
    return this.#connections.snapshot(threadId, project);
  }

  /** Whether a thread has work in flight: a plugin turn, a direct completion or a delegation. */
  #threadBusy(threadId: string): boolean {
    return (
      this.#x.pluginTurnLeases.has(threadId) ||
      !!this.#x.activeCompletions.get(threadId)?.size ||
      [...this.#x.activeDelegations.values()].some((d) => d.threadId === threadId)
    );
  }

  /** Whether agents write in `directory`: the games folder, a game's own folder or the scratch where workers' copies live. */
  async #agentWritable(directory: string): Promise<boolean> {
    const real = async (dir: string) => realpath(dir).catch(() => path.resolve(dir));
    const target = await real(directory);
    const games = await this.games.list().catch(() => []);
    const roots = [this.games.root, this.layout.scratch, ...games.map((game) => game.dir)];
    for (const root of roots) if (isInside(await real(root), target)) return true;
    return false;
  }

  /** Trusted UI project binding; agent inputs do not select an output root. */
  async pluginBinding(project?: string, threadId?: string): Promise<PluginBinding | undefined> {
    if (!project) return undefined;
    const directory = this.games.dirFor(project);
    await this.assertProjectAllowed(directory);
    return { project, directory, threadId };
  }

  requestConsent(
    ...args: Parameters<PluginToolService["requestConsent"]>
  ): ReturnType<PluginToolService["requestConsent"]> {
    return this.#pluginTools.requestConsent(...args);
  }

  /** The user's click on a consent card, with their edit of its field (Studio UI over IPC only — never an RPC method). */
  resolveConsent(consentId: string, approved: boolean, always = false, input?: string): boolean {
    return this.#consent.resolve(consentId, approved, always, input);
  }

  // ── tool permissions in game chats (Studio UI over IPC only — never an RPC method) ─────────
  /** The mode new chats start in, saved "always allow" rules by game, and where Auto is unavailable. */
  permissionSettings(): ReturnType<ChatPermissionService["settings"]> {
    return this.#permissions.settings();
  }

  /** The composer's picker: the chat's mode (a running reply switches now), and the mode new chats start in. */
  setPermissionMode(threadId: string | null, mode: unknown): ReturnType<ChatPermissionService["setMode"]> {
    const settings = this.#permissions.setMode(threadId, mode);
    // A connector's card that the chat's new mode would not have asked goes on: the mode answers it.
    const answers = () => {
      if (threadId !== null && typeof mode === "string") this.#consent.approveForMode(threadId, mode);
    };
    return settings.then(
      (view) => {
        answers();
        return view;
      },
      (error: unknown) => {
        // The chat's mode was set even when a running session could not switch to it.
        answers();
        throw error;
      },
    );
  }

  /** The person's answer to a `tool_permission` card; false once it is no longer waiting. */
  answerPermission(requestId: unknown, answer: unknown): boolean {
    return this.#permissions.answer(requestId, answer);
  }

  /** Stop allowing a saved "always allow" rule for a game. */
  forgetPermission(project: unknown, rule: unknown): ReturnType<ChatPermissionService["forget"]> {
    return this.#permissions.forget(project, rule);
  }

  /**
   * Ask the person in a chat as a Claude session would: the development fixtures' way in, so a card
   * is exercised on the real ledger and IPC without a model. Engines reach it only through the
   * permissions of a session the person is answering.
   */
  askToolPermission(
    project: string,
    threadId: string,
    ask: Parameters<ChatPermissionService["askFor"]>[2],
    signal: AbortSignal = new AbortController().signal,
  ): ReturnType<ChatPermissionService["askFor"]> {
    return this.#permissions.askFor(project, threadId, ask, signal);
  }

  #cancelConnectorCalls(binding: { project?: string; threadId?: string } = {}, by: "stop" | "turn" = "stop") {
    for (const [controller, call] of this.#x.activeConnectorCalls)
      if (
        (!binding.project || binding.project === call.project) &&
        (!binding.threadId || binding.threadId === call.threadId) &&
        !(by === "turn" && call.outlivesTurn)
      )
        controller.abort();
  }

  // ── previews and builds ──────────────────────────────────────────────────────────────────
  runPreviewIdentity(): RunPreview {
    return { ...this.#x.runPreview };
  }

  /** Reflect stage visibility (and whether the person watches a game in Live) while preserving active observations. */
  previewStageVisible(visible: boolean, watching = visible): Promise<void> {
    return this.#previews.setStageVisible(visible, watching);
  }

  /** The Live game's sound switch, as the user left it. */
  previewSound(request: GameSoundRequest): void {
    this.#previews.setSound(request);
  }

  /** The studio window came to the front or went behind: a game in the background is not heard. */
  previewForeground(foreground: boolean): void {
    this.#previews.setForeground(foreground);
  }

  /** A builder's checkpoint, offered to Live's Reload (never loaded into Live on its own). */
  checkpointPreview(project: string, cwd: string, note: string | null): Promise<void> {
    return this.#previews.checkpointPreview(project, cwd, note);
  }

  /** Serve a game (or a checked worktree of it) into a preview — what `preview.load` does, for host callers. */
  loadPreview(p: HarnessParams<typeof HostMethod.PreviewLoad>): Promise<string> {
    return this.#previews.loadPreview(p);
  }

  /** Reload a preview from what is on disk now — what `preview.reload` does, for host callers. */
  reloadPreview(
    p: HarnessParams<typeof HostMethod.PreviewReload>,
  ): Promise<HarnessResult<typeof HostMethod.PreviewReload>> {
    return this.#previews.reloadPreview(p);
  }

  /** The person's Reload on the stage: what waits for Live, else what is on disk now (`live-gate.ts`). */
  reloadLive(p: { retry?: boolean } = {}): Promise<void> {
    return this.#previews.reloadLive(p);
  }

  /** The stage's Stop: Live's game stops running until Play. */
  stopLive(): Promise<void> {
    return this.#previews.stopLive();
  }

  /** The stage's Play on a stopped game. */
  playLive(): Promise<void> {
    return this.#previews.playLive();
  }

  /** Something would have changed Live: it waits for the person's Reload instead (`live.behind`). */
  offerLive(...args: Parameters<PreviewService["offerLive"]>): ReturnType<PreviewService["offerLive"]> {
    return this.#previews.offerLive(...args);
  }

  /** A build nobody on the stage asked to see: offered to Live's Reload, never loaded (`PreviewService.offerBuild`). */
  offerBuild(...args: Parameters<PreviewService["offerBuild"]>): ReturnType<PreviewService["offerBuild"]> {
    return this.#previews.offerBuild(...args);
  }

  /** What waits for this game's Live and the build Live shows: the stage reads it on mount (`live.behind`). */
  liveState(...args: Parameters<PreviewService["liveState"]>): ReturnType<PreviewService["liveState"]> {
    return this.#previews.liveState(...args);
  }

  buildProblem(...args: Parameters<PreviewService["buildProblem"]>): ReturnType<PreviewService["buildProblem"]> {
    return this.#previews.buildProblem(...args);
  }

  installPackages(
    ...args: Parameters<PreviewService["installPackages"]>
  ): ReturnType<PreviewService["installPackages"]> {
    return this.#previews.installPackages(...args);
  }

  /** Whether `project` is someone else's game whose setup scripts the person has not trusted (`guardScripts`). */
  async scriptsGuarded(project: string): Promise<boolean> {
    return (await this.games.presentation(project)).guardScripts === true;
  }

  async buildPreview(request: BuildPreviewRequest) {
    return latestBuildPreview(this.layout.runs, request);
  }

  /**
   * Show a build the game's repo holds (a run's integration head, any commit) in the user's
   * window, from a worktree of its own: the game folder is untouched. A run that finished or
   * paused without landing leaves its build on `refs/studio/runs/<run>/integration`; this is
   * how the user plays it before deciding.
   */
  async showBuild(project: string, commit: string): Promise<{ dir: string; commit: string }> {
    const key = JSON.stringify([project, commit]);
    const pending = this.#showRequests.get(key);
    if (pending) return pending;
    const request = serial(this.#showOperations, project, () => this.#previews.showBuild(project, commit));
    this.#showRequests.set(key, request);
    try {
      return await request;
    } finally {
      if (this.#showRequests.get(key) === request) this.#showRequests.delete(key);
    }
  }

  landBuild(...args: Parameters<PreviewService["landBuild"]>): ReturnType<PreviewService["landBuild"]> {
    return this.#previews.landBuild(...args);
  }

  playGameSnapshot(
    ...args: Parameters<PreviewService["playGameSnapshot"]>
  ): ReturnType<PreviewService["playGameSnapshot"]> {
    return this.#previews.playGameSnapshot(...args);
  }

  readProjectAsset(
    ...args: Parameters<PreviewService["readProjectAsset"]>
  ): ReturnType<PreviewService["readProjectAsset"]> {
    return this.#previews.readProjectAsset(...args);
  }

  readRunStill(...args: Parameters<PreviewService["readRunStill"]>): ReturnType<PreviewService["readRunStill"]> {
    return this.#previews.readRunStill(...args);
  }

  referenceStills(
    ...args: Parameters<PreviewService["referenceStills"]>
  ): ReturnType<PreviewService["referenceStills"]> {
    return this.#previews.referenceStills(...args);
  }

  agentScreens(...args: Parameters<PreviewService["agentScreens"]>): ReturnType<PreviewService["agentScreens"]> {
    return this.#previews.agentScreens(...args);
  }

  // ── assets and game files ────────────────────────────────────────────────────────────────
  get assetCheckpoints() {
    if (!this.#assetCheckpointStore) {
      this.#assetCheckpointStore = new AssetCheckpoints(path.join(this.layout.engineHomes, "asset-deliveries.json"));
    }
    return this.#assetCheckpointStore;
  }

  projectAssets(...args: Parameters<AssetService["projectAssets"]>): ReturnType<AssetService["projectAssets"]> {
    return this.#assets.projectAssets(...args);
  }

  retainedAssetFile(
    ...args: Parameters<AssetService["retainedAssetFile"]>
  ): ReturnType<AssetService["retainedAssetFile"]> {
    return this.#assets.retainedAssetFile(...args);
  }

  previewProjectAsset(
    ...args: Parameters<AssetService["previewProjectAsset"]>
  ): ReturnType<AssetService["previewProjectAsset"]> {
    return this.#assets.previewProjectAsset(...args);
  }

  presentProjectAssets(
    ...args: Parameters<AssetService["presentProjectAssets"]>
  ): ReturnType<AssetService["presentProjectAssets"]> {
    return this.#assets.presentProjectAssets(...args);
  }

  projectModelRigs(
    ...args: Parameters<AssetService["projectModelRigs"]>
  ): ReturnType<AssetService["projectModelRigs"]> {
    return this.#assets.projectModelRigs(...args);
  }

  saveReferenceFrames(
    ...args: Parameters<AssetService["saveReferenceFrames"]>
  ): ReturnType<AssetService["saveReferenceFrames"]> {
    return this.#assets.saveReferenceFrames(...args);
  }

  saveRunArtifact(...args: Parameters<AssetService["saveRunArtifact"]>): ReturnType<AssetService["saveRunArtifact"]> {
    return this.#assets.saveRunArtifact(...args);
  }

  async runFeedback(...args: Parameters<AssetService["runFeedback"]>): ReturnType<AssetService["runFeedback"]> {
    this.#rewind.assertNotRewinding(args[0].threadId);
    return this.#assets.runFeedback(...args);
  }

  readGameFile(...args: Parameters<GameFileService["readGameFile"]>): ReturnType<GameFileService["readGameFile"]> {
    return this.#gameFiles.readGameFile(...args);
  }

  revealGameFile(
    ...args: Parameters<GameFileService["revealGameFile"]>
  ): ReturnType<GameFileService["revealGameFile"]> {
    return this.#gameFiles.revealGameFile(...args);
  }

  messageImages(...args: Parameters<GameFileService["messageImages"]>): ReturnType<GameFileService["messageImages"]> {
    return this.#gameFiles.messageImages(...args);
  }

  /** Which names a chat wrote are files on this computer, and how each opens (`main/chat-files.ts`). */
  resolveChatFiles(
    ...args: Parameters<GameFileService["resolveChatFiles"]>
  ): ReturnType<GameFileService["resolveChatFiles"]> {
    return this.#gameFiles.resolveChatFiles(...args);
  }

  /** The path a click on a chat's file opens, resolved again, and how it opens. */
  chatFileTarget(
    ...args: Parameters<GameFileService["chatFileTarget"]>
  ): ReturnType<GameFileService["chatFileTarget"]> {
    return this.#gameFiles.chatFileTarget(...args);
  }

  // ── delegation tools ─────────────────────────────────────────────────────────────────────
  _computerToolsFor(
    ...args: Parameters<DelegationService["_computerToolsFor"]>
  ): ReturnType<DelegationService["_computerToolsFor"]> {
    return this.#delegation._computerToolsFor(...args);
  }

  /** Whether the host's own records say this run is this game's (`preview.computer`'s run check). */
  _runOfGame(project: string, runId: string): Promise<boolean> {
    return this.#delegation.runOfGame(project, runId);
  }

  _directorToolsFor(
    ...args: Parameters<DelegationService["_directorToolsFor"]>
  ): ReturnType<DelegationService["_directorToolsFor"]> {
    return this.#delegation._directorToolsFor(...args);
  }

  _playtestToolsFor(
    ...args: Parameters<DelegationService["_playtestToolsFor"]>
  ): ReturnType<DelegationService["_playtestToolsFor"]> {
    return this.#delegation._playtestToolsFor(...args);
  }

  // ── recovery ─────────────────────────────────────────────────────────────────────────────
  recover(...args: Parameters<RecoveryService["recover"]>): ReturnType<RecoveryService["recover"]> {
    // A loop the watchdog has to rewind crashed in a loop: its runs are the user's to resume.
    this.#autoResume.forgetCrashes();
    return this.#recovery.recover(...args);
  }

  rollbackTo(...args: Parameters<RecoveryService["rollbackTo"]>): ReturnType<RecoveryService["rollbackTo"]> {
    return this.#recovery.rollbackTo(...args);
  }

  reconcileSeedManifest(
    ...args: Parameters<RecoveryService["reconcileSeedManifest"]>
  ): ReturnType<RecoveryService["reconcileSeedManifest"]> {
    return this.#recovery.reconcileSeedManifest(...args);
  }

  snapshot(...args: Parameters<RecoveryService["snapshot"]>): ReturnType<RecoveryService["snapshot"]> {
    return this.#recovery.snapshot(...args);
  }

  requestSelfRestart(
    ...args: Parameters<RecoveryService["requestSelfRestart"]>
  ): ReturnType<RecoveryService["requestSelfRestart"]> {
    return this.#recovery.requestSelfRestart(...args);
  }

  get pendingUpdateId(): string | null {
    return this.#x.pendingUpdateId;
  }

  // ── conversation and runs ────────────────────────────────────────────────────────────────
  sendUserMessage(
    ...args: Parameters<ConversationService["sendUserMessage"]>
  ): ReturnType<ConversationService["sendUserMessage"]> {
    return this.#conversation.sendUserMessage(...args);
  }

  retryMention(
    ...args: Parameters<ConversationService["retryMention"]>
  ): ReturnType<ConversationService["retryMention"]> {
    return this.#conversation.retryMention(...args);
  }

  stopThread(...args: Parameters<ConversationService["stopThread"]>): ReturnType<ConversationService["stopThread"]> {
    this.#autoResume.userStopped(args[0]);
    return this.#conversation.stopThread(...args);
  }

  /**
   * Stop one run through the run controls (`studio:run.stop`): the user's word, so the run never
   * resumes on its own afterwards, then the harness is asked to settle and close it.
   */
  async stopRun(runId: string, timeoutMs?: number): Promise<void> {
    this.#autoResume.userStoppedRun(runId);
    await this.host.dispatch({ type: DispatchActionType.RunStop, runId }, timeoutMs);
  }

  async changeQueuedMessage(
    threadId: string,
    messageId: string,
    operation: "hold" | "edit" | "remove",
    text?: string,
  ): Promise<void> {
    if (!this.host.hasCapability(HarnessCapability.MessageQueue)) throw new Error(MESSAGE.queueNeedsHarness);
    this.#rewind.assertNotRewinding(threadId);
    await this.store.getRecord(threadId);
    await this.host.dispatch({ type: DispatchActionType.QueueMessage, threadId, messageId, operation, text });
  }

  /** Manual "/compact": the harness summarises the thread's past into the log, visibly. */
  async compactThread(threadId: string, options: { engine?: string; model?: string } = {}): Promise<void> {
    this.#rewind.assertNotRewinding(threadId);
    await this.host.dispatch({
      type: DispatchActionType.Compact,
      threadId,
      ...(options.engine ? { engine: options.engine } : {}),
      ...(options.model ? { model: options.model } : {}),
    });
  }

  requestRunFinish(
    ...args: Parameters<ConversationService["requestRunFinish"]>
  ): ReturnType<ConversationService["requestRunFinish"]> {
    return this.#conversation.requestRunFinish(...args);
  }

  async dispatchRun(run: Extract<DispatchAction, { type: typeof DispatchActionType.RunStart }>["run"]): Promise<void> {
    this.#selfImprovement.touchActivity();
    // A run is that game's story: its briefs, iterations and verdict belong in its own chat.
    const threadId = await this.threadForGame(run.project);
    this.#rewind.assertNotRewinding(threadId);
    await this.host.dispatch({ type: DispatchActionType.RunStart, threadId, run });
  }

  /** What rewinding a chat to a message would do to the game files (`core/rewind.ts`). */
  rewindPreview(...args: Parameters<ChatRewindService["preview"]>): ReturnType<ChatRewindService["preview"]> {
    return this.#rewind.preview(...args);
  }

  /** Rewind a game chat to just before one of its messages (`core/rewind.ts`). */
  rewindChat(...args: Parameters<ChatRewindService["rewind"]>): ReturnType<ChatRewindService["rewind"]> {
    return this.#rewind.rewind(...args);
  }

  /** Bring back the game files the chat's newest rewind replaced; the chat stays rewound (`core/rewind.ts`). */
  undoRewind(...args: Parameters<ChatRewindService["undo"]>): ReturnType<ChatRewindService["undo"]> {
    return this.#rewind.undo(...args);
  }

  /** What freeing space deletes now, in `project` or in every game (`core/storage-space.ts`). */
  storageSpace(project?: string): Promise<StorageSpace> {
    return this.#storage.space(project);
  }

  /** Free space in `project`, refused while it works, or in every game not working (`core/storage-space.ts`). */
  freeStorage(project?: string): Promise<StorageFreed> {
    return this.#storage.free(project);
  }

  /**
   * Resume a paused Autopilot run — the user's click, never a boot side effect (A4); host
   * auto-resume (`core/auto-resume.ts`) takes the same path. The run is found by its journal
   * artifact; completed facets replay from it, unfinished work restarts.
   */
  async resumeAutopilot(runId: string): Promise<void> {
    // The user's own Resume: a resume the studio planned for this run is no longer needed.
    this.#autoResume.cancelRun(runId);
    await this.#resumeAutopilot(runId);
  }

  async #resumeAutopilot(runId: string): Promise<void> {
    this.#selfImprovement.touchActivity();
    const loopPredatesResume =
      this.host.state === HarnessState.Ready && !this.host.hasCapability(HarnessCapability.Autopilot);
    if (loopPredatesResume) throw new Error(MESSAGE.resumeUnsupported);
    for (const thread of await this.store.listThreads()) {
      const journal = (await this.store.readArtifact(thread.id, `autopilot_${runId}`).catch(() => null)) as {
        phase?: string;
      } | null;
      if (!journal) continue;
      if (journal.phase === JournalPhase.Done) throw new Error(MESSAGE.runAlreadyFinished(runId));
      // A rewind stopping this chat's build waits for it to close: a Resume must not restart it.
      this.#rewind.assertNotRewinding(thread.id);
      await this.host.dispatch({ type: DispatchActionType.AutopilotResume, threadId: thread.id, runId });
      return;
    }
    throw new Error(MESSAGE.noAutopilotJournal(runId));
  }

  newRunId(): string {
    return shortId("run");
  }

  // ── plan review ──────────────────────────────────────────────────────────────────────────
  private get planReviews(): PlanReviewController {
    if (!this.#planReviews) this.#planReviews = createPlanReviews(this, this.#x);
    return this.#planReviews;
  }

  async answerPlan(thread: string, id: string, approved: boolean): Promise<boolean> {
    this.#rewind.assertNotRewinding(thread);
    return this.planReviews.answer(thread, id, approved);
  }

  // ── self-improvement ─────────────────────────────────────────────────────────────────────
  runIdleCheckNow(
    ...args: Parameters<SelfImprovementService["runIdleCheckNow"]>
  ): ReturnType<SelfImprovementService["runIdleCheckNow"]> {
    return this.#selfImprovement.runIdleCheckNow(...args);
  }

  /**
   * Apply a staged SkillOpt proposal. By default this is the human-review path;
   * with the auto-apply setting on it is also called with `approvedBy: "auto"` the moment a
   * proposal is staged. Snapshot before and after, keep a `best_skill` copy, and record the
   * approval in the log so the accepted-edit history is inspectable either way. `key` names
   * the suggestion the person saw; the index is only a fallback for callers without one.
   */
  async acceptStagedProposal(
    index: number,
    approvedBy: "human" | "auto" = "human",
    key?: { at?: string; skill?: string },
  ): Promise<{ skill: string }> {
    // One change at a time: with self-improving ON, the auto-sweep and a human Apply click can
    // land together, and two concurrent snapshots fight over the same git index.lock.
    return this.#selfImprovement.selfChangeTurn(() =>
      this.#selfImprovement.acceptStagedProposal(index, approvedBy, key),
    );
  }

  discardStagedProposal(
    ...args: Parameters<SelfImprovementService["discardStagedProposal"]>
  ): ReturnType<SelfImprovementService["discardStagedProposal"]> {
    return this.#selfImprovement.discardStagedProposal(...args);
  }

  /**
   * Undo one learned change and nothing else. Its own diff is reversed on the file it wrote,
   * so later changes, the per-game lessons and the app's own updates stay where they are —
   * "Undo this change" used to rewind the whole harness to before it, and restart it mid-run.
   */
  async undoSelfChange(snapshotId: string): Promise<{ file: string }> {
    return this.#selfImprovement.selfChangeTurn(() => this.#selfImprovement.undoSelfChange(snapshotId));
  }

  selfChangeList(
    ...args: Parameters<SelfImprovementService["selfChangeList"]>
  ): ReturnType<SelfImprovementService["selfChangeList"]> {
    return this.#selfImprovement.selfChangeList(...args);
  }
}
