# Genex Desktop — Local + Free Asset Pipeline

> Replaces every cloud plugin the upstream Genex fork ships (Tripo, Meshy, ElevenLabs)
> with free/open tools that run **entirely on this Mac**. Research dated 2026-10-20.
> Machine: Mac Studio M5 Max, 128 GB unified RAM, Apple Metal. ComfyUI (:8188) is the
> unifying UI; LM Studio (:1234) serves text.

## What's ALREADY on this machine (don't re-install)

- **Voice — SOLVED.** `Juno local TTS server` at **http://127.0.0.1:8799** (OpenAI-compatible,
  `POST /v1/audio/speech {model, input, voice, response_format}`), running as LaunchAgent
  `ai.duckbot.drama3-tts`. Two MLX-native engines, both verified generating audio:
  - **Drama 3** (`fishaudio/drama-3`, MLX 4-bit) — emotive, multi-speaker (`<|speaker:N|>`),
    voice cloning from a few seconds of reference, 83 langs, natural-language emotion tags.
    License: **Fish Audio Community License** (⚠️ check commercial terms).
  - **Qwen3-TTS** (`qwen3-tts-0.6b`, MLX) — lighter, expressive, streaming; backup engine.
  - This is the ElevenLabs-**Voice** replacement and it's better: local, free, MLX-accelerated.
    Point Genex / any client at `:8799` as an OpenAI-compatible endpoint.
- **Text — SOLVED.** LM Studio on **:1234** (serves ornith / tess / qwen models).
- **Image + Video — SOLVED.** ComfyUI on **:8188** (Qwen Image 2.1, Flux3 Klein, Wan 2.2 native,
  LTX-2.5, MiniMax H3 staged). Bare install — needs ComfyUI-Manager + audio/3D nodes.

**So the only two gaps left are 3D and music/SFX.** Everything else is local + running.

## The one rule that shapes everything: MPS, not MLX

There is **no MLX-native text/image-to-3D or audio model** as of Oct 2026. Every viable
open-source option runs on **PyTorch's MPS (Metal) backend** — with `PYTORCH_ENABLE_MPS_FALLBACK=1`
(CPU fallback is normal and expected on Mac). The **exceptions that ARE MLX-native**:
`mlx-audio` (voice) and `mlx-audiocraft` (music/SFX) — these are the fastest path on this box.

So the pattern is: **image/video/3D/audio-diffusion → ComfyUI on MPS**; **voice + music → the
MLX-native ports when you want speed, else ComfyUI nodes**. Unified RAM = VRAM, so 128 GB lets
you load models that OOM on consumer NVIDIA. Quantize for *speed*, not capacity.

## ⚠️ License caveat (this is the "free" gotcha)

Code being MIT/Apache does **not** mean the model weights are. Several flagship tools ship
**non-commercial weights**:

| Tool | Code license | **Weight license** | Commercial? |
| --- | --- | --- | --- |
| TripoSR | MIT | permissive | ✅ yes |
| Hunyuan3D-2.1 | — | **Tencent Community** (>1M MAU needs license) | ⚠️ small-scale ok |
| TRELLIS | MIT | MIT | ✅ yes |
| InstantMesh | Apache-2.0 | Apache | ✅ yes |
| SF3D | — | **Stability Community** (<$1M rev) | ⚠️ |
| CosyVoice2 | Apache-2.0 | Apache-2.0 | ✅ yes |
| F5-TTS | MIT | **CC-BY-NC** | ❌ personal only |
| Kokoro-82M | Apache-2.0 | Apache-2.0 | ✅ yes |
| MusicGen / AudioGen (Meta) | MIT | **CC-BY-NC 4.0** | ❌ personal only |
| Stable Audio Open | MIT | **Stability Community** (<$1M rev) | ⚠️ small-scale ok |

**If game audio/assets will ship commercially, prefer the ✅ rows:** TripoSR/TRELLIS/InstantMesh
(3D), CosyVoice2/Kokoro (voice), Stable Audio Open (music+SFX).

---

## Mapping: Genex cloud plugin → free local replacement

| Genex plugin | What it does | Free local replacement | License-safe | How to run |
| --- | --- | --- | --- | --- |
| **Tripo** | 3D / rig / animate | **TripoSR** (image→mesh) + **Mesh2Motion** (rig+animate) | ✅ MIT | `--device mps`; Mesh2Motion is a node web app, no GPU pressure |
| **Meshy** | characters w/ materials | **Hunyuan3D-2.1** (image→3D + PBR materials) | ⚠️ Tencent | PyTorch MPS; macOS officially listed |
| **ElevenLabs — Voice** | voice lines / cloning | ✅ **ALREADY DONE**: Drama 3 + Qwen3-TTS on **:8799** (OpenAI-compat, MLX) | ✅ local | `POST :8799/v1/audio/speech` — no install needed |
| **ElevenLabs — Music** | music tracks | **Stable Audio Open** (permissive) or **mlx-audiocraft** MusicGen | ⚠️/❌ | `run_gradio.py` / `mlx-audiocraft "..."` |
| **ElevenLabs — SFX** | sound effects | **Stable Audio Open** / **AudioGen** (mlx-audiocraft) | ⚠️/❌ | same as music |

### Rigging specifically (Tripo's rig/animate role)
- **Mesh2Motion** ⭐ — MIT + CC0, free local Mixamo: auto-rig + animate bipeds/quadrupeds/birds. Node web app, no GPU concerns.
- Rigify (Blender built-in), AccuRIG (free tier) — manual/semi-auto.
- **Pipeline:** TripoSR/Hunyuan → GLB → Mesh2Motion (rig/anim) → Blender cleanup.

---

## ComfyUI is the unifying layer (already installed, running :8188)

Current install is **bare**: only `ComfyUI-VideoHelperSuite`. Models staged for image/video
(`qwen_image_2.1`, `flux3_klein`, `ltx-2.5`, `minimax_h3`) but the video ones are `int8` variants
that hit CPU fallback / errors on Metal — images (Qwen/Flux) are the solid MPS path.

**Free custom nodes to install:**

| Category | Node pack | Install |
| --- | --- | --- |
| Manager (needed first) | **ComfyUI-Manager** | git clone into `custom_nodes/`, restart |
| Image conditioning | `comfyui_controlnet_aux` | via Manager |
| **3D (image→mesh+PBR)** | ✅ **Hunyuan3D-2 is BUILT INTO ComfyUI** (templates section) — no node needed | none; use built-in template |
| **3D (advanced)** | **ComfyUI-3D-Pack** (`MrForExample/ComfyUI-3D-Pack`) — adds TripoSR, TRELLIS, StableFast3D | via ComfyUI-Manager |
| **Audio (music+SFX)** | **comfyui-sound-lab** (`shadowcz007/comfyui-sound-lab`, 144★) — MusicGen + Stable Audio | `git clone` into custom_nodes (uses audiotools+protobuf) |
| Video | Wan 2.2 is **native**; LTX-Video needs `ComfyUI-LTXVideo` | native / git |
| Voice (bonus) | `1038lab/ComfyUI-KokoroTTS` | via Manager (Python 3.11 ✓) |

**So both gaps ARE ComfyUI nodes — you were right.** Caveat for this Mac: Hunyuan3D-2 / TripoSR
run on MPS but ComfyUI-3D-Pack's post-processing (marching cubes, Gaussian splat → mesh) is
CUDA-oriented and may need CPU fallback / be slow. Music/SFX via comfyui-sound-lab is lighter.

**ComfyUI is NOT MLX** — it runs on MPS. `ComfyUI-MLX` is an optional Flux-only booster (~35–70%
faster). MPS doesn't support `int_mm`/block-scale fp8, so the staged int8 video models need
fp8/full-precision variants or an MLX offload + ComfyUI for post.

---

## Recommended install order (incremental — don't overrun the box)

The risk here is **memory + MPS gaps, not concurrency** (Genex already serializes local-engine
work to one facet at a time). Install ONE tool, verify it runs on Metal, then add the next.

1. **ComfyUI-Manager** — prerequisite for everything below.
2. **TripoSR + Mesh2Motion** (3D) — lightest, MIT-clean, proves the mesh→rig pipeline.
3. **comfyui-sound-lab** (music+SFX in-ComfyUI) or standalone **Stable Audio Open** for a permissive license.
4. **CosyVoice2** (voice) — Apache, best cloning; or drop into ComfyUI via a Kokoro node for speed.
5. **mlx-audio / mlx-audiocraft** — the MLX-native voice+music path; fastest on this box, add once the MPS path is proven.

Each model is 0.5–7 GB; with 128 GB they co-reside, but launch them one at a time so you catch
MPS fallback errors before they stack.

## Source reports
- `~/3d-asset-generation-local-alternatives.md` — 9 tools, rig vs mesh breakdown
- `~/tts-local-alternatives.md` — voice/TTS matrix w/ cloning + license
- `~/comfyui-game-dev-capability-map.md` — ComfyUI node map + Metal caveats
- Music/SFX findings are inline above (no separate file was saved)
