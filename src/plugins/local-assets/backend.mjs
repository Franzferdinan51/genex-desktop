import { writeFile } from "node:fs/promises";
import path from "node:path";

/** Juno local TTS server (Drama 3 MLX + Qwen3-TTS MLX), OpenAI-shaped, :8799 on this Mac. */
const TTS = "http://127.0.0.1:8799";
const CALL_MS = 5 * 60 * 1000;

/** POST JSON to the TTS server, return {ok, buffer} or {ok: false, problem}. */
async function postJson(route, body, timeout = CALL_MS) {
  const signal = AbortSignal.timeout(timeout);
  let response;
  try {
    response = await fetch(`${TTS}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    const code = error?.cause?.code;
    return {
      ok: false,
      closed: code === "ECONNREFUSED",
      problem: `TTS server isn't answering on :8799 (${code ?? error?.message ?? String(error)}). ` +
        `Start the ai.duckbot.drama3-tts LaunchAgent.`,
    };
  }
  if (!response.ok) {
    return { ok: false, problem: `TTS server ${route} returned HTTP ${response.status}` };
  }
  return { ok: true, buffer: Buffer.from(await response.arrayBuffer()) };
}

/** Keep the output file inside the bound project directory. */
function projectFile(context, file) {
  const under = path.resolve(context.directory);
  const target = path.resolve(under, file);
  const ok =
    target === under ||
    target.startsWith(under + path.sep);
  return { target, ok };
}

async function voice(args, context) {
  const text = typeof args?.text === "string" ? args.text : "";
  const model = typeof args?.model === "string" && args.model ? args.model : "qwen3-tts";
  const voice = typeof args?.voice === "string" && args.voice ? args.voice : "af_heart";
  const file = typeof args?.file === "string" && args.file ? args.file : "voice.mp3";
  if (!text) return { ok: false, problem: "text is required" };
  const { target, ok } = projectFile(context, file);
  if (!ok) return { ok: false, problem: `file "${file}" must live inside this project` };
  const result = await postJson("/v1/audio/speech", {
    model,
    input: text,
    voice,
  });
  if (!result.ok) return result;
  await writeFile(target, result.buffer);
  return { ok: true, model, file, path: target };
}

export async function activate() {
  return {
    async tool(name, args, context) {
      if (name === "voice") return voice(args ?? {}, context);
      throw new Error(`local-assets has no tool named ${name}`);
    },
  };
}
