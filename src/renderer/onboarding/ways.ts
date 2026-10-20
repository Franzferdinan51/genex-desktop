/**
 * First launch's other ways to build, as pure decisions: the row under the subscriptions (local
 * models, OpenRouter, OpenCode), what each of its buttons says, and the step OpenRouter's and
 * OpenCode's screens are at. The screens render these; they never work them out again.
 */
import { EngineStatusCode } from "../../shared/engine-descriptor.ts";
import { EngineId } from "../../shared/providers.ts";
import { defaultModelKey } from "../model-choices.ts";
import { modelKey } from "../model-key.ts";
import { OpenCodeRowState } from "../panels/opencode-row.ts";
import type { EngineDescriptor } from "../types.ts";
import { ChipState, MarkState } from "./art.ts";

/** The row's three ways, in the order its buttons stand. */
export const OtherWay = {
  Local: "local",
  OpenRouter: "openrouter",
  OpenCode: "opencode",
} as const;
export type OtherWay = (typeof OtherWay)[keyof typeof OtherWay];
/**
 * The ways first launch offers. Local-only fork: local models are the only way — OpenRouter and
 * OpenCode are metered services, and this fork never sends a build to one. Their screens stay in
 * the tree, unreachable, beside the engines that are no longer registered.
 */
export const OTHER_WAYS: readonly OtherWay[] = [OtherWay.Local];

/** How a way's button looks: its offer, something under way, or ready to build with. */
export const WayState = { Idle: "idle", Busy: "busy", On: "on" } as const;
export type WayState = (typeof WayState)[keyof typeof WayState];

/** One way's button: its look, its words, and the line under the row while it is pointed at. */
export interface WayView {
  state: WayState;
  label: string;
  hint: string;
}

/** The row's and the two screens' words. */
export const WAYS_WORDS = {
  lead: "or use",
  local: {
    name: "Local models",
    hint: "Free and private. Runs on this Mac.",
    downloading: (model: string, percent: number) => `Downloading ${model} · ${percent}%`,
    ready: (model: string) => `${model} ready`,
  },
  openRouter: {
    name: "OpenRouter",
    hint: "One key for hundreds of models. Pay as you go.",
    signingIn: "OpenRouter · finish in your browser",
    on: "OpenRouter connected",
    onHint: "Billed to your OpenRouter credits.",
    title: "Connect OpenRouter",
    lede: "One account for hundreds of models. You pay OpenRouter for what you use.",
    connect: "Connect OpenRouter",
    connectNote: "Opens OpenRouter in your browser. Approve Genex there and you're back here.",
    pasteInstead: "Paste a key instead",
    browser: "Finish in your browser",
    browserNote: "Approve Genex on OpenRouter. This screen moves on by itself.",
    openAgain: "Open the page again",
    cancel: "Cancel sign-in",
    keyLabel: "OpenRouter API key",
    keyPlaceholder: "sk-or-…",
    save: "Connect",
    checking: "Checking the key…",
    getKey: "Get a key",
    keyNote: "The key is checked with OpenRouter, then kept on this Mac.",
    browserInstead: "Connect in the browser instead",
    refused: "OpenRouter didn't accept that key. Check it and paste it again.",
    connectedNote: "Billed to your OpenRouter credits. Pick any of its models in the model menu.",
  },
  openCode: {
    name: "OpenCode",
    hint: "Free models to start, or any provider you sign in to.",
    installing: "Setting up OpenCode…",
    ready: "OpenCode ready",
    readyHint: "Free models. Sign in to a provider for stronger ones.",
    on: "OpenCode connected",
    onHint: "Billed by each provider you use.",
    title: "Connect OpenCode",
    lede: "Start free with OpenCode's own models, or sign in to a provider you already use.",
    signInTitle: "Sign in to a provider",
    signInLede: "OpenCode asks a few questions below. Choose with ↑ ↓ and press Return.",
    setUp: "Set up OpenCode",
    setUpNote: "Installs OpenCode on this Mac. This can take a minute.",
    checkAgain: "Already installed? Check again",
    checking: "Checking…",
    readyStatus: "OpenCode ready · free models",
    readyNote: "Free models are smaller and slower. Sign in to a provider for stronger ones.",
    signIn: "Sign in to a provider",
    signedOutNote: "Sign in to a provider in OpenCode to run its models.",
    terminal: "OpenCode sign-in",
    cancelSignIn: "Cancel",
    openSignInPage: "Open sign-in page",
    signingInNote: "Free models keep working while you sign in. OpenCode keeps the sign-in.",
    connectedNote: "Billed by each provider you use. Free models stay in the model menu too.",
    another: "Sign in to another provider",
    unreachable: "OpenCode didn't answer. Check the installation, then try again.",
    tryAgain: "Try again",
    buildWith: "build with",
    freeModels: "Free model to build with",
    defaultName: "OpenCode default",
    defaultDetail: "Follows OpenCode",
  },
} as const;

/** The local models button: the offer, the Best fit model downloading, or ready. */
export function localWay(chip: ChipState, model: string, percent: number): WayView {
  const words = WAYS_WORDS.local;
  if (chip === ChipState.Ready) return { state: WayState.On, label: words.ready(model), hint: words.hint };
  if (chip === ChipState.Downloading)
    return { state: WayState.Busy, label: words.downloading(model, percent), hint: words.hint };
  return { state: WayState.Idle, label: words.name, hint: words.hint };
}

/** The OpenRouter button: the offer, a browser sign-in waiting, or connected. */
export function openRouterWay(status: EngineStatusCode | undefined, signingIn: boolean): WayView {
  const words = WAYS_WORDS.openRouter;
  if (status === EngineStatusCode.Ready) return { state: WayState.On, label: words.on, hint: words.onHint };
  if (signingIn) return { state: WayState.Busy, label: words.signingIn, hint: words.browserNote };
  return { state: WayState.Idle, label: words.name, hint: words.hint };
}

/** The OpenCode button: the offer, setting up, ready on its free models, or a provider signed in. */
export function openCodeWay(row: OpenCodeRowState): WayView {
  const words = WAYS_WORDS.openCode;
  if (row === OpenCodeRowState.Installing) return { state: WayState.Busy, label: words.installing, hint: words.hint };
  if (row === OpenCodeRowState.FreeOnly) return { state: WayState.On, label: words.ready, hint: words.readyHint };
  if (row === OpenCodeRowState.Connected) return { state: WayState.On, label: words.on, hint: words.onHint };
  return { state: WayState.Idle, label: words.name, hint: words.hint };
}

/** Where OpenRouter's screen is: the offer, waiting on the browser, the key box, checking a key, or connected. */
export const RouterStep = {
  Offer: "offer",
  Browser: "browser",
  Key: "key",
  Checking: "checking",
  On: "on",
} as const;
export type RouterStep = (typeof RouterStep)[keyof typeof RouterStep];

/** What the OpenRouter screen is doing on its own, beside the engine's status. */
export interface RouterLocal {
  signingIn: boolean;
  pasting: boolean;
  saving: boolean;
}

/** The OpenRouter screen's step. A connected engine wins over anything left under way. */
export function routerStep(status: EngineStatusCode | undefined, local: RouterLocal): RouterStep {
  if (status === EngineStatusCode.Ready) return RouterStep.On;
  if (local.saving) return RouterStep.Checking;
  if (local.signingIn) return RouterStep.Browser;
  if (local.pasting) return RouterStep.Key;
  return RouterStep.Offer;
}

/** How OpenRouter's mark looks at each step. */
export function routerMark(step: RouterStep): MarkState {
  if (step === RouterStep.On) return MarkState.On;
  if (step === RouterStep.Browser || step === RouterStep.Checking) return MarkState.Busy;
  return MarkState.Idle;
}

/** How OpenCode's mark looks: missing until installed, lit once its models run (free ones count). */
export function openCodeMark(row: OpenCodeRowState, checking: boolean): MarkState {
  if (row === OpenCodeRowState.FreeOnly || row === OpenCodeRowState.Connected) return MarkState.On;
  const working = row === OpenCodeRowState.Installing || row === OpenCodeRowState.SigningIn;
  if (checking || working) return MarkState.Busy;
  if (row === OpenCodeRowState.NotInstalled) return MarkState.Missing;
  return MarkState.Idle;
}

/** One row of the OpenCode screen's free models. */
export interface FreeModelOption {
  key: string;
  name: string;
  detail: string | null;
}

/**
 * The free models OpenCode's screen offers to build with: OpenCode's own default first, which
 * names no model and so follows OpenCode when it changes its default, then each free model it lists.
 */
export function freeModelOptions(
  models: readonly Pick<EngineDescriptor["models"][number], "id" | "label" | "free">[],
): FreeModelOption[] {
  const words = WAYS_WORDS.openCode;
  return [
    { key: defaultModelKey(EngineId.OpenCode), name: words.defaultName, detail: words.defaultDetail },
    ...models
      .filter((model) => model.free)
      .map((model) => ({ key: modelKey(EngineId.OpenCode, model.id), name: model.label, detail: null })),
  ];
}

/** The row the list shows picked: the person's, while OpenCode still offers it, else OpenCode's default. */
export function pickedFreeModel(options: readonly FreeModelOption[], key: string): string {
  if (options.some((option) => option.key === key)) return key;
  return defaultModelKey(EngineId.OpenCode);
}

/** Does first launch pick the first model with the person: OpenCode's free models are all they can build with? */
export const picksFreeModel = (row: OpenCodeRowState, othersOn: boolean): boolean =>
  row === OpenCodeRowState.FreeOnly && !othersOn;
