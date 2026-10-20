/**
 * First launch: one welcome screen in two states, then the subscription to build with.
 *
 * Welcome: a prompt types itself into a copy of the composer (Loop on) and the pointer sends
 * it; the prompt lands on the Planner's sheet, then the Workers and Reviewers join (art.ts).
 * Clicking the composer takes the person's own idea, which waits in the real composer afterwards.
 * Connect: Claude Code and ChatGPT sign in through the same flows as Settings → Model Providers.
 * Each has one button that hugs its words and changes them as the sign-in moves on. Under them,
 * "or use" offers local models (the Best fit for this Mac downloads), OpenRouter (browser sign-in
 * or a pasted key) and OpenCode (installs, then its free models run), each on its own screen. The
 * first connection turns Skip into Start building.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type JSX,
  type KeyboardEvent,
  type RefObject,
} from "react";
import type { EngineDescriptor } from "../types.ts";
import { SECOND_MS } from "../../shared/duration.ts";
import type { CodexLoginState } from "../../shared/codex-login.ts";
import { EngineStatusCode } from "../../shared/engine-descriptor.ts";
import type { ModelInstallJob } from "../../shared/model-install.ts";
import { EngineId } from "../../shared/providers.ts";
import { type ModelPullProgress, UiEvent } from "../../shared/ui-events.ts";
import { preloadHomeBackdrop } from "../home-backdrop/preload.ts";
import { Button } from "../ui/Button.tsx";
import { GenexLogo } from "../ui/GenexLogo.tsx";
import { Icon } from "../ui/icons.tsx";
import { LoaderGrid } from "../ui/LoadingState.tsx";
import { CODE_FALLBACK_LABEL, useCodeFallback } from "../ui/SignInCard.tsx";
import { useClaudeLogin, useSubscriptionAuth } from "../subscription-auth.ts";
import { useCliInstall } from "../cli-install.ts";
import { LOCAL_SERVER_WORDS, problemWords } from "../words.ts";
import { openSettings, SettingsSection } from "../settings-navigation.ts";
import { SHOW_TERMINAL_EVENT } from "../panels/terminal-events.ts";
import { prefersReducedMotion, REDUCED_MOTION_QUERY } from "../ui/media-queries.ts";
import { ArtCanvas, type Draw } from "./ArtCanvas.tsx";
import { OpenCodeScreen, useFreeModel, useOpenCode } from "./OpenCodeScreen.tsx";
import { OpenRouterScreen, useOpenRouter } from "./OpenRouterScreen.tsx";
import { OtherWays } from "./OtherWays.tsx";
import { Check, Hug, OnboardingAction, StartBuilding, TopBar, useHeadingFocus } from "./parts.tsx";
import { localWay, openCodeWay, openRouterWay, OtherWay, RouterStep, type WayView } from "./ways.ts";
import {
  CHIP,
  ChipState,
  GRAPH_MS,
  MARK_PROVIDERS,
  MARKS,
  PROMPT_ORIGIN,
  Provider,
  ROLE_AT,
  STAGE,
  WELCOME_STILL,
  drawChip,
  drawMarks,
  drawWelcome,
  type MarkState,
  type TextStyle,
} from "./art.ts";
import {
  DEMO_IDEA,
  SUBSCRIPTIONS,
  canonicalModel,
  ConnectAction,
  connectView,
  ConnectViewKind,
  installsCli,
  markState,
  startTrouble,
  type ConnectView,
  type Subscription,
} from "./state.ts";

/** The onboarding screens: the welcome, Connect, and one for each of Connect's other ways. */
const Screen = {
  Welcome: "welcome",
  Connect: "connect",
  Local: "local",
  OpenRouter: "openrouter",
  OpenCode: "opencode",
} as const;
type Screen = (typeof Screen)[keyof typeof Screen];
type Hardware = Awaited<ReturnType<typeof window.studio.hardware>>;

/** The composer copy on the welcome stage, in stage pixels; the send button's centre is where the pointer clicks. */
const COMPOSER = { left: 120, top: 130, width: 520 } as const;
const SEND = { x: COMPOSER.left + COMPOSER.width - 26, y: COMPOSER.top + 62 } as const;
const ROLES = [
  { name: "Plan your game", does: "the idea becomes tasks", left: 7, at: ROLE_AT.planner },
  { name: "Build with workers", does: "every piece at once", left: 260, at: ROLE_AT.workers },
  { name: "Reviewers test it", does: "and approve each build", left: 513, at: ROLE_AT.reviewers },
] as const;
/** The welcome's typing: a calm start while the caret blinks, then each letter. */
const TYPE_START_MS = 1400;
const LETTER_MS = 50;
/** From the last letter: a beat to read it, the pointer moves to Send and rests, the press. */
const POINTER_AFTER_TYPING_MS = 1100;
const SEND_AFTER_TYPING_MS = 2900;
const SENT_BEAT_MS = 600;
/** The fade out of the whole welcome when it finishes. */
const LEAVE_MS = 260;

/** Each of Connect's other ways opens its own screen. */
const WAY_SCREEN: Record<OtherWay, Screen> = {
  [OtherWay.Local]: Screen.Local,
  [OtherWay.OpenRouter]: Screen.OpenRouter,
  [OtherWay.OpenCode]: Screen.OpenCode,
};
/** The engines besides OpenCode that, once ready, are something to build with. */
const BUILDS_WITH: readonly string[] = [EngineId.ClaudeCode, EngineId.Codex, EngineId.LocalServer, EngineId.OpenRouter];

/** Each subscription's mark on the connect art. */
const MARK_OF: Record<Subscription, Provider> = {
  [EngineId.ClaudeCode]: Provider.Claude,
  [EngineId.Codex]: Provider.Codex,
};

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    const media = matchMedia(REDUCED_MOTION_QUERY);
    const change = () => setReduced(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  return reduced;
}

/** Scales a fixed-size stage to the room its box has: down to half, up to 1.2 on a big window. */
function useFit(width: number, height: number): [RefObject<HTMLDivElement | null>, number] {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const measure = () =>
      setScale(Math.max(0.5, Math.min(1.2, element.clientWidth / width, element.clientHeight / height)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [width, height]);
  return [box, scale];
}

/** The composer's text style, read once, so the streamed letters leave exactly where the typed ones stood. */
function useComposerTextStyle(input: RefObject<HTMLInputElement | null>): RefObject<TextStyle> {
  const textStyle = useRef<TextStyle>({ font: "15px sans-serif", spacing: "0px" });
  useLayoutEffect(() => {
    const element = input.current;
    if (!element) return;
    const style = getComputedStyle(element);
    textStyle.current = {
      font: `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`,
      spacing: style.letterSpacing === "normal" ? "0px" : style.letterSpacing,
    };
  }, []);
  return textStyle;
}

interface ScriptSteps {
  setTyped: (text: string) => void;
  setPhase: (phase: number) => void;
  setBeat: (beat: 0 | 1) => void;
}

/**
 * The first beat's timeline: type the prompt a letter at a time, point at Send, press, and the bar
 * lets go of the words. A sent idea skips the typing.
 */
function scheduleTyping(at: (ms: number, step: () => void) => void, text: string, sent: boolean, s: ScriptSteps) {
  let t = 0;
  if (sent) s.setTyped(text);
  else {
    s.setTyped("");
    s.setPhase(0);
    t = TYPE_START_MS;
    for (let i = 1; i <= text.length; i++) {
      const part = text.slice(0, i);
      at(t, () => {
        s.setTyped(part);
        s.setPhase(1);
      });
      t += LETTER_MS;
    }
    at(t + POINTER_AFTER_TYPING_MS, () => s.setPhase(2));
    t += SEND_AFTER_TYPING_MS;
  }
  at(t, () => s.setPhase(3));
  at(t + 170, () => s.setPhase(4));
  at(t + 230, () => s.setPhase(5));
  at(t + SENT_BEAT_MS, () => {
    s.setPhase(0);
    s.setBeat(1);
  });
}

/** Where the welcome's pointer is: off, over Send, or gone once it has pressed it. */
function pointerAt(phase: number, still: boolean): "off" | "on" | "gone" {
  if (still) return "off";
  if (phase >= 2 && phase <= 4) return "on";
  return phase === 5 ? "gone" : "off";
}

function welcomeCaption(beat: 0 | 1, writing: boolean): string {
  if (beat === 1) return "Multi-agent workflows. Custom plugins. Assets for games.";
  if (writing) return "Type your own idea. It waits for you after setup.";
  return "Open source AI harness for game development";
}

/** The welcome's two beats, its script, and what the person does to it: write an idea, send it, jump a beat. */
function useWelcome(idea: string, onIdea: (text: string) => void) {
  const reduced = useReducedMotion();
  const prompt = idea || DEMO_IDEA;
  const [beat, setBeat] = useState<0 | 1>(0);
  const [phase, setPhase] = useState(0);
  const [typed, setTyped] = useState(() => (reduced ? prompt : ""));
  const [writing, setWriting] = useState(false);
  const [draft, setDraft] = useState("");
  const [sent, setSent] = useState(false);
  const [run, setRun] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const beatAt = useRef(performance.now());
  const beatNow = useRef(beat);
  const promptNow = useRef(prompt);
  promptNow.current = prompt;
  const textStyle = useComposerTextStyle(input);

  // The art's clock starts with the state it draws, before the frame that first shows it.
  useLayoutEffect(() => {
    beatNow.current = beat;
    beatAt.current = performance.now();
  }, [beat, run]);

  // The script: type, point at Send, press, the bar lets go of the words, then the roles play
  // for 15 s and it starts again.
  useEffect(() => {
    if (reduced) {
      setTyped(promptNow.current);
      setPhase(0);
      return;
    }
    if (writing) return;
    const timers: number[] = [];
    const at = (ms: number, step: () => void) => {
      timers.push(window.setTimeout(step, ms));
    };
    if (beat === 1)
      at(GRAPH_MS, () => {
        setSent(false);
        setBeat(0);
      });
    else scheduleTyping(at, promptNow.current, sent, { setTyped, setPhase, setBeat });
    return () => timers.forEach((id) => window.clearTimeout(id));
  }, [beat, run, writing, reduced, sent]);

  const drawStage = useCallback<Draw>((ctx, palette, now) => {
    if (beatNow.current !== 1) return;
    const t = now === null ? WELCOME_STILL : Math.max(0, (now - beatAt.current) / SECOND_MS);
    drawWelcome(ctx, t, promptNow.current, textStyle.current, palette, now === null);
  }, []);

  const actions = welcomeActions({
    idea,
    onIdea,
    reduced,
    prompt,
    writing,
    draft,
    input,
    promptNow,
    set: { setWriting, setSent, setPhase, setBeat, setRun, setTyped, setDraft },
  });
  const view = {
    value: writing ? draft : typed,
    /** The empty bar waits for the demo to type: its caret blinks. */
    waiting: beat === 0 && phase === 0 && !writing && !sent && !reduced && typed === "",
    composerOn: beat === 0 && phase < 5,
    /** The bar has let go of the typed words, which now stream into the art. */
    letGo: beat === 0 && phase >= 4 && !writing,
  };
  return { reduced, prompt, beat, phase, writing, draft, sent, run, input, drawStage, ...view, ...actions };
}

interface WelcomeSetters {
  setWriting: (writing: boolean) => void;
  setSent: (sent: boolean) => void;
  setPhase: (phase: number) => void;
  setBeat: (beat: 0 | 1) => void;
  setRun: (next: (n: number) => number) => void;
  setTyped: (text: string) => void;
  setDraft: (text: string) => void;
}

/** Jump to a beat, start writing an idea, send it, and let go of an empty one. */
function welcomeActions(w: {
  idea: string;
  onIdea: (text: string) => void;
  reduced: boolean;
  prompt: string;
  writing: boolean;
  draft: string;
  input: RefObject<HTMLInputElement | null>;
  promptNow: RefObject<string>;
  set: WelcomeSetters;
}) {
  const { set, writing, draft } = w;
  const jump = (next: 0 | 1) => {
    set.setWriting(false);
    set.setSent(false);
    set.setPhase(0);
    set.setBeat(next);
    set.setRun((n) => n + 1);
  };
  const startWriting = () => {
    if (writing) return;
    set.setWriting(true);
    set.setSent(false);
    set.setBeat(0);
    set.setPhase(0);
    set.setTyped("");
    set.setDraft(w.idea);
  };
  const send = () => {
    const text = (writing ? draft : w.prompt).trim();
    if (!text) return;
    if (writing) {
      w.onIdea(text);
      w.promptNow.current = text;
      set.setWriting(false);
      w.input.current?.blur();
    }
    if (w.reduced) {
      set.setBeat(1);
      return;
    }
    set.setSent(true);
    set.setPhase(0);
    set.setBeat(0);
    set.setRun((n) => n + 1);
  };
  const leave = () => {
    if (writing && !draft.trim()) {
      set.setWriting(false);
      set.setRun((n) => n + 1);
    }
  };
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  };
  return { jump, startWriting, send, leave, keyDown, setDraft: set.setDraft };
}

type WelcomeModel = ReturnType<typeof useWelcome>;

/** The composer copy on the stage: the idea, the composer's icons and Send. */
function WelcomeComposer({ w }: { w: WelcomeModel }): JSX.Element {
  const { beat, phase, writing, draft, value, composerOn, run } = w;
  const pressing = beat === 0 && phase === 3;
  const nothingToSend = writing && !draft.trim();
  return (
    <div
      className="onboarding-composer composer-panel"
      data-shown={composerOn}
      style={{ left: COMPOSER.left, top: COMPOSER.top, width: COMPOSER.width }}
    >
      <input
        ref={w.input}
        className="onboarding-idea text-composer"
        aria-label="Describe a game"
        placeholder="Describe a game…"
        value={value}
        data-let-go={w.letGo || undefined}
        disabled={!composerOn}
        onFocus={w.startWriting}
        onChange={(event) => w.setDraft(event.target.value)}
        onBlur={w.leave}
        onKeyDown={w.keyDown}
      />
      {w.waiting && <span className="onboarding-caret" aria-hidden="true" />}
      <div className="flex min-w-0 items-center gap-1" aria-hidden="true">
        <span className="composer-icon composer-add">
          <Icon name="plus" />
        </span>
        {/* A new key each time the bar comes back, so the Loop's ∞ draws itself once more. */}
        <span key={`${run}:${beat}`} className="onboarding-loop composer-text-button">
          <Icon name="infinity" />
          <span className="onboarding-loop-label">Loop</span>
        </span>
        <span className="min-w-0 flex-1" />
      </div>
      <button
        type="button"
        className="composer-send onboarding-send"
        aria-label="Send idea"
        data-state={value.trim() ? "ready" : "idle"}
        data-pressed={pressing || undefined}
        disabled={!composerOn || nothingToSend}
        onClick={w.send}
      >
        <span className="composer-send-glyph" data-glyph="send">
          <Icon name="send" />
        </span>
      </button>
      {beat === 0 && phase >= 4 && <span className="onboarding-ripple" aria-hidden="true" />}
    </div>
  );
}

/** The welcome stage: the art, the composer copy, the letters it lets go of, the roles and the pointer. */
function WelcomeStage({ w, scale }: { w: WelcomeModel; scale: number }): JSX.Element {
  const { beat, phase, writing, letGo } = w;
  const pointerStill = w.reduced || beat !== 0 || writing || w.sent;
  return (
    <div className="onboarding-stage" style={{ transform: `scale(${scale})` }}>
      <ArtCanvas width={STAGE.width} height={STAGE.height} draw={w.drawStage} still={`${beat}:${scale}`} />
      <WelcomeComposer w={w} />
      <div
        aria-hidden="true"
        className="onboarding-letters text-composer"
        data-shown={letGo}
        style={{ left: PROMPT_ORIGIN.x, top: PROMPT_ORIGIN.y - 10 }}
      >
        {w.prompt}
      </div>
      {beat === 1 &&
        ROLES.map((role) => (
          <div
            key={role.name}
            className="onboarding-role"
            style={{ left: role.left, animationDelay: w.reduced ? undefined : `${role.at * SECOND_MS}ms` }}
          >
            <p className="onboarding-role-name">{role.name}</p>
            <p className="onboarding-role-does">{role.does}</p>
          </div>
        ))}
      <div
        aria-hidden="true"
        className="onboarding-pointer"
        data-at={pointerAt(phase, pointerStill)}
        data-pressed={phase === 3 || undefined}
        style={{ left: SEND.x - 3, top: SEND.y - 2 }}
      >
        <svg width="22" height="28" viewBox="0 0 22 28">
          <path d="M3 2 L3 22 L8 17.5 L11.5 25 L15 23.5 L11.6 16.2 L18 16 Z" />
        </svg>
      </div>
    </div>
  );
}

/** The two step bars: the first fills over the typing (or, for a sent idea, the send alone), the second over the roles. */
function WelcomeSteps({ w }: { w: WelcomeModel }): JSX.Element {
  const { beat, run, writing, sent } = w;
  const typing = TYPE_START_MS + w.prompt.length * LETTER_MS + SEND_AFTER_TYPING_MS + SENT_BEAT_MS;
  const durations = [sent ? SENT_BEAT_MS : typing, GRAPH_MS];
  return (
    <div className="onboarding-steps">
      {([0, 1] as const).map((step) => (
        <button
          key={step}
          type="button"
          className="onboarding-step"
          aria-label={`Show step ${step + 1} of 2`}
          aria-current={step === beat ? "step" : undefined}
          onClick={() => w.jump(step)}
        >
          <span className="onboarding-step-track">
            {step < beat && <span className="onboarding-step-fill" />}
            {step === beat && (
              <span
                key={`${run}-${beat}-${writing}-${sent}`}
                className="onboarding-step-fill"
                data-running={(!w.reduced && !writing) || undefined}
                style={{ animationDuration: `${durations[step]}ms` }}
              />
            )}
          </span>
        </button>
      ))}
    </div>
  );
}

function Welcome({
  idea,
  back,
  onIdea,
  onNext,
}: {
  idea: string;
  back: boolean;
  onIdea: (text: string) => void;
  onNext: (draft: string) => void;
}): JSX.Element {
  const w = useWelcome(idea, onIdea);
  const [fit, scale] = useFit(STAGE.width, STAGE.height);
  const caption = welcomeCaption(w.beat, w.writing);
  return (
    <section className={`onboarding-screen onboarding-welcome ${back ? "onboarding-enter-back" : ""}`}>
      <header className="onboarding-hello">
        <p>welcome to</p>
        <GenexLogo className="onboarding-wordmark" />
      </header>
      <div ref={fit} className="onboarding-fit">
        <div style={{ width: STAGE.width * scale, height: STAGE.height * scale }}>
          <WelcomeStage w={w} scale={scale} />
        </div>
      </div>
      <p key={caption} className="onboarding-caption onboarding-rise">
        {caption}
      </p>
      <Button
        variant="default"
        size="lg"
        className="onboarding-cta"
        data-onboarding-action={OnboardingAction.Next}
        onClick={() => onNext(w.writing ? w.draft.trim() : "")}
      >
        Next
      </Button>
      <WelcomeSteps w={w} />
    </section>
  );
}

function useCodexLogin(): CodexLoginState | null {
  const [state, setState] = useState<CodexLoginState | null>(null);
  useEffect(() => {
    let live = true;
    const update = (next: CodexLoginState) => {
      if (live) setState((old) => (!old || next.revision >= old.revision ? next : old));
    };
    const unsubscribe = window.studio.onCodexLogin(update);
    void window.studio
      .codexLoginState()
      .then(update)
      .catch(() => {});
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);
  return state;
}

type ModelPick = NonNullable<Hardware["recommendation"]>["picks"][number];

/** The model the recommendation calls Best fit, or its first pick when it names none. */
function bestFit(hardware: Hardware | null): ModelPick | null {
  const recommendation = hardware?.recommendation;
  if (!recommendation) return null;
  return recommendation.picks.find((p) => p.model === recommendation.defaultModel) ?? recommendation.picks[0] ?? null;
}

/** A pick's name as the row shows it, with its variant when it has one. */
function pickName(pick: ModelPick | null): string {
  if (!pick) return "";
  return pick.variant ? `${pick.name} ${pick.variant}` : pick.name;
}

function chipState(installed: boolean, pulling: string | null): ChipState {
  if (installed) return ChipState.Ready;
  return pulling ? ChipState.Downloading : ChipState.Idle;
}

interface DownloadSetters {
  setPulling: (model: string | null) => void;
  setProgress: (share: number) => void;
  setError: (error: string | null) => void;
}

/** A local pull's progress: it failed, it finished (the engines are read again), or it is still coming. */
function followPull(
  { model, progress }: { model: string; progress: ModelPullProgress },
  { setPulling, setProgress, setError }: DownloadSetters,
  onEnginesRefresh: () => void,
) {
  if (progress.status === "error") {
    setPulling(null);
    setError(progress.error ?? "Download failed");
    return;
  }
  if (progress.status === "success") {
    setPulling(null);
    onEnginesRefresh();
  } else setPulling(model);
  if (progress.total) setProgress((progress.completed ?? 0) / progress.total);
}

/** Follow the download: the install job's own reports, and a local pull's progress. */
function useDownloadEvents(onEnginesRefresh: () => void, setters: DownloadSetters) {
  useEffect(() => {
    let alive = true;
    const apply = (job: ModelInstallJob | null) => {
      if (!job || !alive) return;
      setters.setPulling(job.active ? job.model : null);
      setters.setError(job.error ?? null);
      if (job.total) setters.setProgress(job.completed / job.total);
    };
    void window.studio
      .modelInstallStatus()
      .then(apply)
      .catch(() => {});
    const unsubscribe = window.studio.onEvent((event) => {
      if (event.type === UiEvent.ModelInstall) {
        apply(event.payload);
        return;
      }
      if (event.type === UiEvent.ModelPull && alive) followPull(event.payload, setters, onEnginesRefresh);
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [onEnginesRefresh]);
}

/** The Best fit local model: what this Mac is, the download's progress and whether it is installed. */
function useLocalModel(engines: EngineDescriptor[], onEnginesRefresh: () => void) {
  const [hardware, setHardware] = useState<Hardware | null>(null);
  const [hardwareError, setHardwareError] = useState<string | null>(null);
  const [pulling, setPulling] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const asked = useRef(false);
  useDownloadEvents(onEnginesRefresh, { setPulling, setProgress, setError });

  const load = useCallback(() => {
    if (asked.current) return;
    asked.current = true;
    void window.studio
      .hardware()
      .then(setHardware)
      .catch((err) => setHardwareError(problemWords(err)));
  }, []);
  const pick = bestFit(hardware);
  const installed = Boolean(
    pick &&
      engines.some((engine) => engine.models.some((model) => canonicalModel(model.id) === canonicalModel(pick.model))),
  );
  const download = async () => {
    if (!pick) return;
    setPulling(pick.model);
    setProgress(0);
    setError(null);
    try {
      await window.studio.pullModel(pick.model);
      onEnginesRefresh();
    } catch (err) {
      setError(problemWords(err));
    } finally {
      setPulling(null);
    }
  };
  const cancel = () => {
    void window.studio.cancelModelDownload().catch(() => {});
  };
  return {
    load,
    hardware,
    hardwareError,
    pick,
    name: pickName(pick),
    installed,
    state: chipState(installed, pulling),
    percent: Math.round(progress * 100),
    error,
    download,
    cancel,
  };
}
type LocalModel = ReturnType<typeof useLocalModel>;

/** The box a Claude Code sign-in asks for: the code the sign-in page shows. */
function CodeForm({
  code,
  codeError,
  onCode,
  onSubmit,
}: {
  code: string;
  codeError: string | null;
  onCode: (code: string) => void;
  onSubmit: (event: FormEvent) => void;
}): JSX.Element {
  return (
    <form className="onboarding-code" onSubmit={onSubmit}>
      <input
        autoFocus
        aria-label="Code from the sign-in page"
        placeholder="Paste the code"
        value={code}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={Boolean(codeError)}
        onChange={(event) => onCode(event.target.value)}
      />
      <Button type="submit" variant="default" disabled={!code.trim()}>
        Continue
      </Button>
    </form>
  );
}

/** What a subscription's button shows for everything but the code box. */
function ConnectContent({
  id,
  view,
  onAct,
  onCancel,
}: {
  id: Subscription;
  view: Exclude<ConnectView, { kind: typeof ConnectViewKind.Code }>;
  onAct: (id: Subscription, view: ConnectView) => void;
  onCancel: (id: Subscription) => void;
}): JSX.Element {
  if (view.kind === ConnectViewKind.Action)
    return (
      <Button variant="accent-tint" size="lg" className="onboarding-connect-action" onClick={() => onAct(id, view)}>
        {view.label}
      </Button>
    );
  if (view.kind === ConnectViewKind.Busy)
    return (
      <div role="status" className="onboarding-status">
        <LoaderGrid />
        {view.label}
        {view.cancel && (
          <button
            type="button"
            className="onboarding-status-cancel"
            aria-label="Cancel sign-in"
            onClick={() => onCancel(id)}
          >
            <Icon name="close" size={14} />
          </button>
        )}
      </div>
    );
  return (
    <div role="status" className="onboarding-status" data-on>
      <Check />
      {view.label}
    </div>
  );
}

function ConnectButton({
  id,
  view,
  slot,
  onAct,
  onCancel,
  onPasteCode,
}: {
  id: Subscription;
  view: ConnectView;
  slot: RefObject<HTMLDivElement | null>;
  onAct: (id: Subscription, view: ConnectView) => void;
  onCancel: (id: Subscription) => void;
  /** Show the code box: the sign-in page showed a code instead of finishing on its own. */
  onPasteCode: () => void;
}): JSX.Element {
  // The code and its problem outlive the steps around it: a code that failed is still there to fix.
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!code.trim()) return;
    setCodeError(null);
    void window.studio
      .claudeLoginCode(code.trim())
      .then(() => setCode(""))
      .catch((err: Error) => setCodeError(problemWords(err)));
  };
  const typed = (next: string) => {
    setCode(next);
    setCodeError(null);
  };
  const asksForCode = view.kind === ConnectViewKind.Code;
  return (
    <div ref={slot} className="onboarding-choice">
      <Hug swap={asksForCode ? ConnectViewKind.Code : `${view.kind}:${view.label}`}>
        {asksForCode ? (
          <CodeForm code={code} codeError={codeError} onCode={typed} onSubmit={submit} />
        ) : (
          <ConnectContent id={id} view={view} onAct={onAct} onCancel={onCancel} />
        )}
      </Hug>
      {view.kind === ConnectViewKind.Busy && view.offersCode && (
        <button type="button" className="onboarding-link" data-state="idle" onClick={onPasteCode}>
          {CODE_FALLBACK_LABEL}
        </button>
      )}
      {codeError && asksForCode && (
        <p role="alert" className="onboarding-problem">
          {codeError}
        </p>
      )}
    </div>
  );
}

/** Both subscriptions' sign-in state, the button each shows, and the actions behind them. */
function useSubscriptions(engines: EngineDescriptor[], onEnginesRefresh: () => void, onTerminal: () => void) {
  const claudeAuth = useSubscriptionAuth(engines, onEnginesRefresh, EngineId.ClaudeCode);
  const codexAuth = useSubscriptionAuth(engines, onEnginesRefresh, EngineId.Codex);
  const claudeLogin = useClaudeLogin(EngineId.ClaudeCode);
  const codexLogin = useCodexLogin();
  const codeFallback = useCodeFallback(claudeLogin?.phase);
  const claudeInstall = useCliInstall(EngineId.ClaudeCode);
  const codexInstall = useCliInstall(EngineId.Codex);
  const [checking, setChecking] = useState<Partial<Record<Subscription, boolean>>>({});
  const [problem, setProblem] = useState<string | null>(null);

  const views: Record<Subscription, ConnectView> = {
    [EngineId.ClaudeCode]: connectView(EngineId.ClaudeCode, {
      engine: claudeAuth.engine,
      claude: claudeLogin?.phase,
      pastingCode: codeFallback.pasting,
      checking: checking[EngineId.ClaudeCode],
      installing: claudeInstall.installing,
    }),
    [EngineId.Codex]: connectView(EngineId.Codex, {
      engine: codexAuth.engine,
      codexActive: codexAuth.waiting,
      codex: codexLogin?.phase,
      checking: checking[EngineId.Codex],
      installing: codexInstall.installing,
    }),
  };
  const auth = (id: Subscription) => (id === EngineId.Codex ? codexAuth : claudeAuth);
  const installer = (id: Subscription) => (id === EngineId.Codex ? codexInstall : claudeInstall);
  const recheck = async (id: Subscription) => {
    setChecking((current) => ({ ...current, [id]: true }));
    try {
      // A CLI that is signed in but did not start is looked at by starting it again.
      await Promise.all([auth(id).refresh(), window.studio.refreshModels(id).catch(() => false)]);
    } finally {
      setChecking((current) => ({ ...current, [id]: false }));
    }
  };
  const step = (id: Subscription, view: Extract<ConnectView, { kind: typeof ConnectViewKind.Action }>) => {
    if (view.action === ConnectAction.Connect) return auth(id).signIn();
    if (installsCli(view)) return installer(id).install();
    if (view.action === ConnectAction.Recheck) return recheck(id);
    return Promise.resolve(onTerminal());
  };
  const act = (id: Subscription, view: ConnectView) => {
    if (view.kind !== ConnectViewKind.Action) return;
    setProblem(null);
    void Promise.resolve(step(id, view)).catch((err) => setProblem(problemWords(err)));
  };
  const cancel = (id: Subscription) => {
    const cancelled = id === EngineId.Codex ? window.studio.codexLoginCancel() : window.studio.claudeLoginCancel();
    void cancelled.catch((err) => setProblem(problemWords(err)));
  };
  const trouble = (id: Subscription): string | null | undefined => {
    if (views[id].kind === ConnectViewKind.On) return null;
    const notStarting = startTrouble(id, auth(id).engine);
    if (notStarting) return notStarting;
    const installProblem = installer(id).problem;
    if (installProblem) return installProblem;
    if (id === EngineId.ClaudeCode)
      return (claudeLogin?.phase === "failed" ? claudeLogin.error : null) ?? claudeAuth.error;
    return (codexLogin?.phase === "failed" ? codexLogin.error : null) ?? codexAuth.error;
  };
  const shown = problem ?? trouble(EngineId.ClaudeCode) ?? trouble(EngineId.Codex);
  return { views, recheck, act, cancel, shown, claudeAuth, codexAuth, claudeLogin, codexLogin, codeFallback };
}

type Subscriptions = ReturnType<typeof useSubscriptions>;

/** Look again when the person comes back from installing a CLI by hand, and as soon as a sign-in finishes. */
function useRecheckOnReturn(s: Subscriptions) {
  const installing = SUBSCRIPTIONS.filter((id) => installsCli(s.views[id]));
  const installingKey = installing.join();
  useEffect(() => {
    if (!installingKey) return;
    const ids = installingKey.split(",") as Subscription[];
    const onFocus = () => {
      for (const id of ids) void s.recheck(id);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [installingKey]);
  // A finished sign-in is confirmed by the engine itself; ask for it at once rather than on the next poll.
  useEffect(() => {
    if (s.claudeLogin?.phase === "connected") void s.claudeAuth.refresh();
  }, [s.claudeLogin?.phase]);
  useEffect(() => {
    if (s.codexLogin?.phase === "connected") void s.codexAuth.refresh();
  }, [s.codexLogin?.phase]);
}

/** When each mark connected here (not one that was already connected on arrival), in performance.now() time. */
function useConnectedAt(views: Record<Subscription, ConnectView>): RefObject<Record<Provider, number>> {
  const on = {
    [Provider.Claude]: views[EngineId.ClaudeCode].kind === ConnectViewKind.On,
    [Provider.Codex]: views[EngineId.Codex].kind === ConnectViewKind.On,
  };
  const connectedAt = useRef<Record<Provider, number>>({ [Provider.Claude]: -1, [Provider.Codex]: -1 });
  const seen = useRef<Record<Provider, boolean> | null>(null);
  useEffect(() => {
    const before = seen.current;
    seen.current = on;
    if (!before) return;
    for (const id of MARK_PROVIDERS) if (on[id] && !before[id]) connectedAt.current[id] = performance.now();
  }, [on.claude, on.codex]);
  return connectedAt;
}

/** Each mark stands over its own button, wherever the row puts it: the buttons' centres on the art. */
function useMarkPlaces() {
  const area = useRef<HTMLDivElement>(null);
  const slots = { [Provider.Claude]: useRef<HTMLDivElement>(null), [Provider.Codex]: useRef<HTMLDivElement>(null) };
  const markX = useRef<Record<Provider, number>>({
    [Provider.Claude]: MARKS.width / 2 - 128,
    [Provider.Codex]: MARKS.width / 2 + 128,
  });
  const [placed, setPlaced] = useState(0);
  useLayoutEffect(() => {
    const measure = () => {
      const box = area.current?.getBoundingClientRect();
      if (!box) return;
      for (const id of MARK_PROVIDERS) {
        const rect = slots[id].current?.getBoundingClientRect();
        if (rect) markX.current[id] = rect.left + rect.width / 2 - box.left;
      }
      setPlaced((n) => n + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const element of [area.current, slots.claude.current, slots.codex.current])
      if (element) observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { area, slots, markX, placed };
}

/** The connect art: both marks in their buttons' states, popping as they connect. */
function useMarksArt(views: Record<Subscription, ConnectView>, markX: RefObject<Record<Provider, number>>) {
  const connectedAt = useConnectedAt(views);
  const marks: Record<Provider, MarkState> = {
    [Provider.Claude]: markState(views[EngineId.ClaudeCode]),
    [Provider.Codex]: markState(views[EngineId.Codex]),
  };
  const marksNow = useRef(marks);
  marksNow.current = marks;
  const born = useRef(performance.now());
  const drawArt = useCallback<Draw>((ctx, palette, now) => {
    const age = (id: Provider) =>
      now === null || connectedAt.current[id] < 0 ? -1 : (now - connectedAt.current[id]) / SECOND_MS;
    drawMarks(
      ctx,
      marksNow.current,
      now === null ? 0 : (now - born.current) / SECOND_MS,
      { [Provider.Claude]: age(Provider.Claude), [Provider.Codex]: age(Provider.Codex) },
      markX.current,
      palette,
    );
  }, []);
  return { marks, drawArt };
}

function Connect({
  engines,
  onEnginesRefresh,
  ways,
  anyOn,
  back,
  onBack,
  onWay,
  onSkip,
  onStart,
  onTerminal,
}: {
  engines: EngineDescriptor[];
  onEnginesRefresh: () => void;
  /** The row's buttons under the subscriptions: local models, OpenRouter and OpenCode. */
  ways: Record<OtherWay, WayView>;
  anyOn: boolean;
  back: boolean;
  onBack: () => void;
  onWay: (way: OtherWay) => void;
  onSkip: () => void;
  onStart: () => void;
  onTerminal: () => void;
}): JSX.Element {
  const subscriptions = useSubscriptions(engines, onEnginesRefresh, onTerminal);
  const { views, act, cancel, shown, codeFallback } = subscriptions;
  const heading = useHeadingFocus();
  useRecheckOnReturn(subscriptions);
  const { area, slots, markX, placed } = useMarkPlaces();
  const { marks, drawArt } = useMarksArt(views, markX);

  return (
    <section
      className={`onboarding-screen onboarding-connect-screen ${back ? "onboarding-enter-back" : "onboarding-enter"}`}
    >
      <TopBar onBack={onBack} onSkip={anyOn ? undefined : onSkip} />
      <h1 ref={heading} tabIndex={-1} className="onboarding-title">
        Bring your AI subscription
      </h1>
      <p className="onboarding-lede">Genex builds with the Claude or ChatGPT plan you already pay for.</p>
      <div ref={area} className="onboarding-marks">
        <ArtCanvas
          width={MARKS.width}
          height={MARKS.height}
          draw={drawArt}
          still={`${marks.claude}:${marks.codex}:${placed}`}
        />
        <div className="onboarding-choices">
          {SUBSCRIPTIONS.map((id) => (
            <ConnectButton
              key={id}
              id={id}
              view={views[id]}
              slot={slots[MARK_OF[id]]}
              onAct={act}
              onCancel={cancel}
              onPasteCode={codeFallback.pasteCode}
            />
          ))}
        </div>
      </div>
      <OtherWays views={ways} onOpen={onWay} />
      <p role="alert" className="onboarding-problem onboarding-connect-problem">
        {shown ? problemWords(shown) : ""}
      </p>
      <StartBuilding anyOn={anyOn} onStart={onStart} />
    </section>
  );
}

/** The connect step: the subscriptions' screen, or — in this fork, which registers none — the local one. */
function ConnectStep(props: {
  engines: EngineDescriptor[];
  onEnginesRefresh: () => void;
  ways: Record<OtherWay, WayView>;
  anyOn: boolean;
  back: boolean;
  onBack: () => void;
  onWay: (way: OtherWay) => void;
  onSkip: () => void;
  onStart: () => void;
  onTerminal: () => void;
}): JSX.Element {
  const hasSubscriptions = SUBSCRIPTIONS.some((id) => props.engines.some((engine) => engine.id === id));
  if (!hasSubscriptions) {
    return (
      <ConnectLocal
        ways={props.ways}
        anyOn={props.anyOn}
        back={props.back}
        onBack={props.onBack}
        onWay={props.onWay}
        onSkip={props.onSkip}
        onStart={props.onStart}
      />
    );
  }
  return (
    <Connect
      engines={props.engines}
      onEnginesRefresh={props.onEnginesRefresh}
      ways={props.ways}
      anyOn={props.anyOn}
      back={props.back}
      onBack={props.onBack}
      onWay={props.onWay}
      onSkip={props.onSkip}
      onStart={props.onStart}
      onTerminal={props.onTerminal}
    />
  );
}

/**
 * First launch in this fork: there is no subscription to bring. The connect step is the local
 * one — the studio connects a local server it finds on its own (LM Studio first), and the ways
 * row leads to managed local models or the server settings. Start lights up as soon as any
 * local engine is ready to build with.
 */
function ConnectLocal({
  ways,
  anyOn,
  back,
  onBack,
  onWay,
  onSkip,
  onStart,
}: {
  ways: Record<OtherWay, WayView>;
  anyOn: boolean;
  back: boolean;
  onBack: () => void;
  onWay: (way: OtherWay) => void;
  onSkip: () => void;
  onStart: () => void;
}): JSX.Element {
  const heading = useHeadingFocus();
  return (
    <section
      className={`onboarding-screen onboarding-connect-screen ${back ? "onboarding-enter-back" : "onboarding-enter"}`}
    >
      <TopBar onBack={onBack} onSkip={anyOn ? undefined : onSkip} />
      <h1 ref={heading} tabIndex={-1} className="onboarding-title">
        Build with models on this Mac
      </h1>
      <p className="onboarding-lede">
        This studio runs entirely on your own hardware: the local server it finds (LM Studio, llama.cpp or TabbyAPI),
        managed local models, or your Ollama. Nothing you build leaves this machine.
      </p>
      <OtherWays views={ways} onOpen={onWay} />
      <StartBuilding anyOn={anyOn} onStart={onStart} />
    </section>
  );
}

/** The model row's second line: its size and what it is good at, the download's progress, or that it is here. */
function modelDetail(local: LocalModel, pick: ModelPick): string {
  if (local.installed) return "Downloaded · runs on this Mac";
  if (local.state === ChipState.Downloading)
    return `${((pick.sizeGb * local.percent) / 100).toFixed(1)} of ${pick.sizeGb} GB`;
  return `${pick.sizeGb} GB · ${pick.about}`;
}

/** The model row's action: Download, the download's percent (with Cancel for Bonsai), or Ready. */
function ModelAction({ local, pick }: { local: LocalModel; pick: ModelPick }): JSX.Element {
  if (local.installed)
    return (
      <div role="status" className="onboarding-status" data-on>
        <Check />
        Ready
      </div>
    );
  if (local.state === ChipState.Downloading)
    return (
      <div role="status" className="flex items-center gap-2">
        <span className="onboarding-percent">{local.percent}%</span>
        {pick.engine === EngineId.Bonsai && (
          <Button variant="ghost" onClick={local.cancel} aria-label={`Cancel downloading ${local.name}`}>
            <Icon name="close" size={14} />
          </Button>
        )}
      </div>
    );
  return (
    <Button variant="default" onClick={() => void local.download()}>
      Download
    </Button>
  );
}

/** The Best fit model for this Mac: its name, detail, action and, while it downloads, its bar. */
function ModelRow({ local, pick }: { local: LocalModel; pick: ModelPick }): JSX.Element {
  const downloading = local.state === ChipState.Downloading;
  return (
    <div className="onboarding-model">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center gap-2.5">
          <span className="onboarding-model-name">{local.name}</span>
          <span className="onboarding-tag">Best fit</span>
        </div>
        <span className="onboarding-model-detail">{modelDetail(local, pick)}</span>
      </div>
      <Hug swap={local.state}>
        <ModelAction local={local} pick={pick} />
      </Hug>
      {downloading && (
        <span
          className="onboarding-model-bar"
          role="progressbar"
          aria-label={`Downloading ${local.name}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={local.percent}
          style={{ width: `${local.percent}%` }}
        />
      )}
    </div>
  );
}

/** What the local screen knows about this Mac: a problem, still looking, no model that fits, or the Best fit row. */
function LocalBody({ local }: { local: LocalModel }): JSX.Element {
  const { pick } = local;
  if (local.hardwareError)
    return (
      <p role="alert" className="onboarding-problem">
        Couldn't look at this Mac. {local.hardwareError}
      </p>
    );
  if (!local.hardware)
    return (
      <p role="status" className="onboarding-note">
        Looking at this Mac…
      </p>
    );
  if (!pick)
    return (
      <p className="onboarding-note">
        No local model fits this Mac's {Math.round(local.hardware.hardware.usableModelGb ?? 0)} GB. Connect a
        subscription instead.
      </p>
    );
  return <ModelRow local={local} pick={pick} />;
}

/** A server the person already runs (LM Studio, llama.cpp, TabbyAPI) is connected in Settings. */
function ServerLink({ onServer }: { onServer: () => void }): JSX.Element {
  return (
    <p className="onboarding-note">
      {LOCAL_SERVER_WORDS.onboardingLine}{" "}
      <button
        type="button"
        className="onboarding-link"
        data-state="idle"
        data-onboarding-action={OnboardingAction.Server}
        onClick={onServer}
      >
        {LOCAL_SERVER_WORDS.connectServer}
      </button>
    </p>
  );
}

function Local({
  local,
  anyOn,
  onBack,
  onSkip,
  onStart,
  onServer,
}: {
  local: LocalModel;
  anyOn: boolean;
  onBack: () => void;
  onSkip: () => void;
  onStart: () => void;
  onServer: () => void;
}): JSX.Element {
  const heading = useHeadingFocus();
  const { load } = local;
  useEffect(() => {
    load();
  }, [load]);
  const now = useRef({ state: local.state, percent: local.percent });
  now.current = { state: local.state, percent: local.percent };
  const born = useRef(performance.now());
  const drawArt = useCallback<Draw>((ctx, palette, time) => {
    drawChip(
      ctx,
      now.current.state,
      now.current.percent,
      time === null ? 0 : (time - born.current) / SECOND_MS,
      palette,
    );
  }, []);
  const downloading = local.state === ChipState.Downloading;

  return (
    <section className="onboarding-screen onboarding-local onboarding-enter">
      <TopBar onBack={onBack} onSkip={anyOn ? undefined : onSkip} />
      <h1 ref={heading} tabIndex={-1} className="onboarding-title">
        Run a model on this Mac
      </h1>
      <p className="onboarding-lede">Free and private. Slower than Claude or ChatGPT.</p>
      <ArtCanvas
        width={CHIP.width}
        height={CHIP.height}
        draw={drawArt}
        still={`${local.state}:${local.percent}`}
        className="onboarding-chip"
      />
      <LocalBody local={local} />
      <ServerLink onServer={onServer} />
      <p role="alert" className="onboarding-problem">
        {local.error ?? ""}
      </p>
      {downloading && <p className="onboarding-note onboarding-rise">It keeps downloading if you go back.</p>}
      <StartBuilding anyOn={anyOn} onStart={onStart} />
    </section>
  );
}

/**
 * Ending the welcome: the app first opens what waits behind it (`onReady`, which gets the idea),
 * the layer shows the wait (`closing`), then fades (`leaving`) and hands over (`onFinish`).
 */
function useWelcomeExit(
  idea: string,
  onReady: (idea: string | null) => Promise<void>,
  onFinish: (then?: () => void) => void,
): { closing: boolean; leaving: boolean; finish: (then?: () => void) => void } {
  const reduced = useReducedMotion();
  const [closing, setClosing] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const finish = (then?: () => void) => {
    if (closing) return;
    setClosing(true);
    void onReady(idea.trim() || null)
      .catch(() => {})
      .then(() => {
        setLeaving(true);
        window.setTimeout(() => onFinish(then), reduced ? 0 : LEAVE_MS);
      });
  };
  return { closing, leaving, finish };
}

export function Onboarding({
  engines,
  onEnginesRefresh,
  onReady,
  onFinish,
}: {
  engines: EngineDescriptor[];
  onEnginesRefresh: () => void;
  /** Welcome is ending: the app opens what waits behind it (the idea, if any, goes to its composer) before the fade. */
  onReady: (idea: string | null) => Promise<void>;
  /** Welcome is over. */
  onFinish: (then?: () => void) => void;
}): JSX.Element {
  const [screen, setScreen] = useState<{ id: Screen; back: boolean }>({ id: Screen.Welcome, back: false });
  const [idea, setIdea] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const local = useLocalModel(engines, onEnginesRefresh);
  const router = useOpenRouter(engines, onEnginesRefresh);
  const code = useOpenCode(engines, onEnginesRefresh);
  const { closing, leaving, finish } = useWelcomeExit(idea, onReady, onFinish);
  const ready = (id: string) => engines.find((engine) => engine.id === id)?.status.code === EngineStatusCode.Ready;
  const othersOn = local.installed || BUILDS_WITH.some(ready);
  // OpenCode's free models count: a ready OpenCode is something to build with.
  const anyOn = othersOn || ready(EngineId.OpenCode);
  const freeModel = useFreeModel(code, engines, othersOn);
  /** Every way out of the welcome: the free model picked here (if any) goes with it. */
  const end = (then?: () => void) => {
    freeModel.remember();
    finish(then);
  };
  const ways: Record<OtherWay, WayView> = {
    [OtherWay.Local]: localWay(local.state, local.name, local.percent),
    [OtherWay.OpenRouter]: openRouterWay(router.status, router.step === RouterStep.Browser),
    [OtherWay.OpenCode]: openCodeWay(code.row),
  };

  useEffect(() => {
    root.current?.focus({ preventScroll: true });
  }, []);
  // Past the welcome, home's background gets ready behind these screens, so home opens on it.
  useEffect(() => {
    if (screen.id !== Screen.Welcome) void preloadHomeBackdrop();
  }, [screen.id]);
  const go = (id: Screen, back = false) => setScreen({ id, back });
  // Every screen after Connect goes back to it, and skips or starts the same way.
  const after = { anyOn, onBack: () => go(Screen.Connect, true), onSkip: () => end(), onStart: () => end() };

  const current = (): JSX.Element => {
    switch (screen.id) {
      case Screen.Welcome:
        return (
          <Welcome
            key={Screen.Welcome}
            idea={idea}
            back={screen.back}
            onIdea={setIdea}
            onNext={(draft) => {
              if (draft) setIdea(draft);
              go(Screen.Connect);
            }}
          />
        );
      case Screen.Connect:
        return (
          <ConnectStep
            key={Screen.Connect}
            engines={engines}
            onEnginesRefresh={onEnginesRefresh}
            ways={ways}
            anyOn={anyOn}
            back={screen.back}
            onBack={() => go(Screen.Welcome, true)}
            onWay={(way) => go(WAY_SCREEN[way])}
            onSkip={() => end()}
            onStart={() => end()}
            onTerminal={() => end(() => window.dispatchEvent(new Event(SHOW_TERMINAL_EVENT)))}
          />
        );
      case Screen.OpenRouter:
        return <OpenRouterScreen key={Screen.OpenRouter} router={router} {...after} />;
      case Screen.OpenCode:
        return <OpenCodeScreen key={Screen.OpenCode} code={code} free={freeModel.free} {...after} />;
      default:
        return (
          <Local
            key={Screen.Local}
            local={local}
            {...after}
            onServer={() => end(() => openSettings(SettingsSection.Providers))}
          />
        );
    }
  };

  return (
    <div
      ref={root}
      role="dialog"
      aria-modal="true"
      aria-label="Welcome to Genex"
      tabIndex={-1}
      className="onboarding"
      data-closing={closing || undefined}
      data-leaving={leaving || undefined}
      aria-busy={closing || undefined}
    >
      <div className="onboarding-drag" />
      {current()}
    </div>
  );
}
