/**
 * Characterization of `StudioCore`'s public surface: the methods and accessors main, the IPC
 * layer and the tests reach it through, and the fields an initialized core exposes.
 *
 * Stage 2 splits this class. Until then any addition, rename or removal here must be a deliberate
 * edit of these lists, so a refactor that silently drops an entry point fails before it ships.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { StudioCore } from "../../src/main/studio-core.ts";
import { coreLite } from "../helpers/core-lite.ts";

const METHODS = [
  "_computerToolsFor",
  "_directorToolsFor",
  "_playtestToolsFor",
  "_runOfGame",
  "acceptStagedProposal",
  "activeBuilders",
  "activityEvents",
  "activityItems",
  "adoptProject",
  "agentScreens",
  "answerPermission",
  "answerPlan",
  "api",
  "append",
  "archiveGame",
  "askToolPermission",
  "assertProjectAllowed",
  "bindThreadToProject",
  "buildPreview",
  "buildProblem",
  "changeQueuedMessage",
  "chatFileTarget",
  "compactThread",
  "connectLocalServer",
  "connectionSnapshot",
  "createGame",
  "createGameThread",
  "defaultDelegatedEngine",
  "discardStagedProposal",
  "dispatchRun",
  "emit",
  "exportPublicCopy",
  "forgetPermission",
  // What freeing space deletes, and deleting it (studio:storage, studio:storage.free).
  "freeStorage",
  // Create game's location, checked before anything is written (studio:game.location.pick).
  "gameLocation",
  "init",
  "inspectFolder",
  "installPackages",
  "knownSecretValues",
  "landBuild",
  "listAllEvents",
  "liveState",
  "loadPreview",
  // Home's Make your own writes a live background on the model the user picked (backdrop-generation.ts).
  "makeBackdrop",
  "messageImages",
  // A game started from its first request is named before its folder is made (studio:game.name).
  "nameGame",
  // A game its first message left Untitled takes the name a later message gives it (conversation.ts).
  "nameFromIdea",
  "newRunId",
  "offerBuild",
  "offerLive",
  "permissionSettings",
  "playGameSnapshot",
  // The stage strip's Play/Stop (studio:preview.play, studio:preview.stop).
  "playLive",
  "pluginBinding",
  "presentProjectAssets",
  "previewProjectAsset",
  "projectAssets",
  "projectModelRigs",
  // Publish's file list, shown in Studio's dialog before anything is uploaded (studio:plugins.genex-publish-review).
  "publicCopyFiles",
  "readGameFile",
  "readProjectAsset",
  "readRunStill",
  "checkpointPreview",
  "previewStageVisible",
  "previewForeground",
  "previewSound",
  "reconcileSeedManifest",
  "recover",
  "referenceStills",
  "reloadLive",
  "reloadPreview",
  "removeGame",
  "renameThread",
  "requestConsent",
  "revealGameFile",
  "requestRunFinish",
  "requestSelfRestart",
  "resolveChatFiles",
  "resolveConsent",
  "resumeAutopilot",
  "retainedAssetFile",
  "retryMention",
  "rewindChat",
  "rewindPreview",
  "rollbackTo",
  "runFeedback",
  "runIdleCheckNow",
  "runPreviewIdentity",
  "saveReferenceFrames",
  "saveRunArtifact",
  // Whether a game is a remix whose setup scripts the person has not trusted (installs, genex__package).
  "scriptsGuarded",
  "selfChangeList",
  "sendUserMessage",
  "setGamesRoot",
  "setPermissionMode",
  "showBuild",
  "snapshot",
  "start",
  "startEngine",
  "stop",
  "stopJob",
  "stopLive",
  "stopRun",
  "stopThread",
  "storageSpace",
  "threadForGame",
  "undoEngineLink",
  "undoRewind",
  "undoSelfChange",
  "updateGame",
  "updateSettings",
  // The files the person approved in that dialog, approved for the one publish it starts.
  "withApprovedExport",
];
// `planReviews` is TypeScript-`private`, which is erased: it is still reachable at run time.
const ACCESSORS = ["assetCheckpoints", "autoResumeAt", "pendingUpdateId", "planReviews", "settings"];
/** Own enumerable fields after `init()` (true `#private` state is not visible and not listed). */
const FIELDS = [
  "appLook",
  "budget",
  "builds",
  "candidates",
  "contextPreferences",
  "engineLinks",
  "engines",
  "games",
  "hooks",
  "host",
  "improvements",
  "jobs",
  "journal",
  "layout",
  "locks",
  "mainThread",
  "mcp",
  "ollamaSidecar",
  "options",
  "pluginServices",
  "plugins",
  "sandbox",
  "screenAccess",
  "snapshotIndex",
  "snapshots",
  "store",
  "turns",
];

function prototypeSurface() {
  const methods: string[] = [];
  const accessors: string[] = [];
  for (const name of Object.getOwnPropertyNames(StudioCore.prototype)) {
    if (name === "constructor") continue;
    const descriptor = Object.getOwnPropertyDescriptor(StudioCore.prototype, name)!;
    if (descriptor.get || descriptor.set) accessors.push(name);
    else if (typeof descriptor.value === "function") methods.push(name);
  }
  return { methods: methods.sort(), accessors: accessors.sort() };
}

test("StudioCore prototype exposes exactly the golden public methods and accessors", () => {
  const surface = prototypeSurface();
  assert.deepEqual(
    surface.methods,
    [...METHODS].sort(),
    "a change to StudioCore's public methods must update this list deliberately",
  );
  assert.deepEqual(surface.accessors, [...ACCESSORS].sort());
  assert.deepEqual(
    Object.getOwnPropertyNames(StudioCore).filter((n) => !["length", "name", "prototype"].includes(n)),
    [],
    "no static members",
  );
});

test("an initialized StudioCore exposes exactly the golden public fields", async () => {
  const { core } = await coreLite();
  assert.deepEqual(Object.keys(core).sort(), [...FIELDS].sort());
});
