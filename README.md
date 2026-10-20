<p align="center">
  <a href="https://genex.games">
    <picture>
      <source srcset=".github/logo-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset=".github/logo-light.svg" media="(prefers-color-scheme: light)">
      <img src=".github/logo-light.svg" alt="Genex" width="320">
    </picture>
  </a>
</p>
<p align="center">Desktop app for game dev with AI.</p>
<p align="center">
  <a href="https://github.com/Franzferdinan51/genex-desktop/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/Franzferdinan51/genex-desktop?style=flat-square" /></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/github/license/Franzferdinan51/genex-desktop?style=flat-square" /></a>
  <a href="https://github.com/Franzferdinan51/genex-desktop/actions/workflows/check.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/Franzferdinan51/genex-desktop/check.yml?branch=dev&style=flat-square&label=build" /></a>
</p>

<p align="center"><img src=".github/banner.png" alt="Genex: a game built in chat, with its assets beside it" width="100%"></p>

---

### Download

| Platform | Download |
| --- | --- |
| macOS (Apple Silicon) | [`Genex.dmg`](https://github.com/Franzferdinan51/genex-desktop/releases/latest/download/Genex.dmg) |
| Linux (x64) | `.deb`, `.rpm` or `.zip` from the [latest release](https://github.com/Franzferdinan51/genex-desktop/releases/latest). The `.deb` and `.rpm` add the Genex package repository, so your system's updates (Software Updater, `apt`, `dnf`) bring every later version |
| Windows (x64), preview | [`Genex-Setup.exe`](https://github.com/Franzferdinan51/genex-desktop/releases/latest/download/Genex-Setup.exe). Not signed yet: if Windows warns, choose More info, then Run anyway |

Genex is early: expect rough edges, and tell us about them in
[issues](https://github.com/Franzferdinan51/genex-desktop/issues).

> [!IMPORTANT]
> **This fork runs entirely locally.** No Claude Code or ChatGPT subscription, no OpenRouter or
> OpenCode account, no Genex account: the cloud engines are not registered, and every run —
> main agent, workers and reviewers — happens on models this Mac serves itself. On launch the
> studio connects the local model server it finds (LM Studio first, then llama.cpp / TabbyAPI),
> or runs a managed local model (Bonsai) or your Ollama. The bundled Genex plugin's hosted
> generators (Meshy, Tripo, ElevenLabs) ship off, the plugin marketplace never fetches its
> remote catalog, and updates come from this repository's own releases. Assets come from the
> local Blender plugin or your own plugins. Upstream Genex (Franzferdinan51/genex-desktop) offers
> the subscription and metered providers this fork leaves out.

### What it does

→ Run local models only: your LM Studio / llama.cpp / TabbyAPI server, managed Bonsai models, or Ollama\
→ Multi-agent game dev: mix local models across the main agent, workers and reviewers\
→ Make 3D assets locally with the Blender plugin\
→ Export anywhere, or publish to the web\
→ Build in Unreal or Godot on your Mac with their plugins\
→ Native C++ games soon

> [!TIP]
> Have a tool your games need? [Build a plugin](#build-a-plugin) and put it in the Genex
> Marketplace for everyone.

### Contributing

You need macOS on Apple Silicon, Git and Node 24.

```bash
git clone https://github.com/Franzferdinan51/genex-desktop.git
cd genex-desktop
nvm install && nvm use   # Node 24, from .nvmrc
npm ci
npm run studio:dev -- start --profile first-run --fixture app-basics
```

The fixture runs the app with scripted models and sample games, so it needs no account. Read
[CONTRIBUTING.md](CONTRIBUTING.md) before you open a pull request; coding agents start at
[AGENTS.md](AGENTS.md).

### Build a plugin

Plugins give Genex's agents new tools: an asset generator, an engine bridge, a service your
game talks to. The Blender and Genex tools that ship with the app are plugins too. From a Genex
checkout:

```bash
npm run plugin:new -- my-plugin --out ~/studio-plugins   # scaffold it from the example
npm run plugin:doctor -- ~/studio-plugins/my-plugin      # check it the way Genex will
```

1. **Try it**: in the app, **Plugins → Add → Load local plugin…** and pick the folder.
2. **Share it**: push it to a public GitHub repository and publish a release for each version.
   Anyone can install it from there with **Plugins → Add → Install from GitHub…**.
3. **List it**: open a pull request to
   [genex-plugins](https://github.com/genex-games/genex-plugins/blob/main/CONTRIBUTING.md). A
   maintainer reviews it, and it appears in every Genex app's Marketplace.

The [plugin guide](docs/PLUGIN_GUIDE.md) covers tools, panels, settings and accounts.

### Documentation

- [Product overview](docs/agent/context.md): what the app does, with a page per feature
- [Developer field guide](docs/STUDIO-DEVELOPER-FIELD-GUIDE.md): run commands and where data lives
- [Release operations](docs/release-operations.md): packaging, signing and publishing a release

### Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by
[SignPath Foundation](https://signpath.org/).

Windows builds are signed only when GitHub Actions builds them from this repository's source,
and a maintainer approves each release before it is signed.
Until that signing is in place, Windows builds ship unsigned as a preview; every release lists
each file's SHA-256 in `SHA256SUMS`.

- Committers and reviewers: [members of genex-games](https://github.com/orgs/genex-games/people)
- Approvers: [owners of genex-games](https://github.com/orgs/genex-games/people?query=role%3Aowner)

Privacy: what Genex stores and sends is in its [privacy policy](PRIVACY.md); connected providers,
plugins and services have their own policies.

---

[Privacy](PRIVACY.md) · [Security](SECURITY.md) · [Code signing policy](#code-signing-policy) ·
[MIT license](LICENSE), copyright `genex.games` · [Third-party notices](THIRD-PARTY-NOTICES.md)
