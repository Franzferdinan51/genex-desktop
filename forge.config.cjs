/**
 * Packaging.
 *
 * Supported target: macOS on Apple Silicon (arm64); Linux x64 packages (deb, rpm, zip) and the
 * Windows x64 Squirrel installer (unsigned until a certificate exists) are built and smoke-tested
 * in CI. Without a signing identity the macOS build is signed ad-hoc once packaged and opens only
 * on the Mac that built it; with one it is a hardened, notarized Developer ID build
 * (scripts/package-signing.cjs, .github/workflows/release.yml).
 * Open release decisions are in docs/release-readiness.md.
 *
 * The one subtlety is asar: the harness bootstrap and the self-edit gate's TypeScript compiler
 * (dist/resources/tsc) are **spawned** as child processes and the vendored three.js is **served**
 * to the preview, and none of that works from inside an asar archive.
 * Runtime resources (including the Genex plugin payload) are unpacked. Coding CLIs are external installations:
 * exclude Codex and Claude SDK native packages; retain the Claude JavaScript SDK only. A Windows
 * package also carries Git for Windows outside the archive (scripts/package-git.cjs).
 */
const path = require("node:path");
const { FusesPlugin } = require("@electron-forge/plugin-fuses");
const { FuseV1Options, FuseVersion } = require("@electron/fuses");
const {
  pruneUnreachable,
  refuseLinkedModules,
  trimNodePty,
  trimSandboxVendor,
} = require("./scripts/package-prune.cjs");
const { APP_BUNDLE_ID, localSigningHook, macSigning, windowsSigning } = require("./scripts/package-signing.cjs");
const { copyBundledGit } = require("./scripts/package-git.cjs");
const { version } = require("./package.json");

const PRODUCT_NAME = "Genex";
const EXECUTABLE_NAME = "genex";
const HOMEPAGE = "https://github.com/Franzferdinan51/genex-desktop";
const SUMMARY = "Self-improving AI game studio";
/** The Linux desktop entry's generic name, beside the product name. */
const GENERIC_NAME = "Game studio";
/** Who the packages name as their authors. */
const AUTHORS = "Genex contributors";
const DESCRIPTION =
  "A desktop studio where coding agents build three.js games, run them in a live preview, judge the result and improve their own harness.";
// Renditions of the 1024x1024 app icon master: .icns for macOS, .png for Linux, .ico for Windows.
const ICON = path.join(__dirname, "build", "icon");
/** The install window's 660x400 art; appdmg picks up the @2x file beside it for Retina. */
const DMG_BACKGROUND = path.join(__dirname, "build", "dmg-background.png");
/** Icon centres in the install window, either side of the background's arrow. */
const DMG_ICON_Y = 170;
const DMG_APP_X = 165;
const DMG_APPLICATIONS_X = 495;
const DMG_ICON_SIZE = 128;
/** What the app refuses to start without on Linux: the process sandbox and code search. */
const LINUX_DEPENDS = ["bubblewrap", "socat", "ripgrep"];
const LINUX_CATEGORIES = ["Development", "Game"];
/**
 * The deb's maintainer scripts: install and remove the AppArmor profile that lets the sandbox
 * create user namespaces on Ubuntu 24.04 and the distributions built on it.
 */
const DEB_SCRIPTS = {
  postinst: path.join(__dirname, "build", "linux", "postinst"),
  postrm: path.join(__dirname, "build", "linux", "postrm"),
};
/**
 * The rpm's scriptlets: add the Genex package repository on install, take it away on uninstall.
 * Both packages read the repository's public key from the app's resources (`LINUX_REPOSITORY_KEY`).
 */
const RPM_SCRIPTS = {
  post: path.join(__dirname, "build", "linux", "rpm-post"),
  postun: path.join(__dirname, "build", "linux", "rpm-postun"),
};
/** The public key of packages.genex.games, shipped in resources/ only by Linux builds. */
const LINUX_REPOSITORY_KEY = path.join(__dirname, "build", "linux", "genex-archive-keyring.asc");
/** The Windows installer's file name, the same for every version so a download link can stay put. */
const WINDOWS_SETUP_EXE = "Genex-Setup.exe";
/** Only with a WINDOWS_SIGN_* certificate, parameters or hook; otherwise unsigned. */
const windowsSign = windowsSigning(process.env);
/** Only with MACOS_SIGN_IDENTITY (and the notarytool API key); otherwise ad-hoc once packaged. */
const macSign = macSigning(process.env, APP_BUNDLE_ID);
/** Why macOS asks before the app's agents read or write in a protected folder. */
const folderAccess = (where) => `Genex's agents build and run games in the folders you choose, including ${where}.`;

module.exports = {
  packagerConfig: {
    name: PRODUCT_NAME,
    executableName: EXECUTABLE_NAME,
    appBundleId: APP_BUNDLE_ID,
    appCategoryType: "public.app-category.developer-tools",
    icon: ICON,
    // Each platform is made on its own runner, so only a Linux build carries the repository key.
    ...(process.platform === "linux" ? { extraResource: [LINUX_REPOSITORY_KEY] } : {}),
    asar: {
      unpack:
        "{**/dist/resources/**,**/node_modules/node-pty/**,**/node_modules/@anthropic-ai/sandbox-runtime/vendor/**}",
    },
    // Ship only what the app needs at runtime; sources and tests stay out of the bundle.
    ignore: [
      /^\/node_modules\/@genex-ai\/cli-demo(?:\/|$)/,
      /\/node_modules\/@anthropic-ai\/claude-agent-sdk-[^/]+(?:\/|$)/,
      /\/node_modules\/@openai\/codex(?:-[^/]+)?(?:\/|$)/,
      // The build's download cache (vendored Git and cua-driver, their archives). It is no module,
      // so the packager's prune keeps it; what ships from it is copied where it belongs.
      /^\/node_modules\/\.cache($|\/)/,
      /^\/(?!dist(?:\/|$)|node_modules(?:\/|$)|package\.json$|LICENSE(?:\..*)?$|THIRD-PARTY-NOTICES\.md$)/,
      /^\/archive($|\/)/,
      /^\/src($|\/)/,
      /^\/tests($|\/)/,
      /^\/scripts($|\/)/,
      /^\/out($|\/)/,
      /^\/\.git($|\/)/,
      /^\/\.(studio-dev|claude|codex|agents)($|\/)/,
      /^\/docs\/agent($|\/)/,
      /^\/(AGENTS|CLAUDE)\.md$/,
      /^\/PLAN\.md$/,
      /^\/research($|\/)/,
      /^\/tsconfig\.json$/,
      /\.map$/,
    ],
    // Windows: the Git for Windows the build vendored, beside the app as resources\git, so agents
    // have Git Bash and the snapshots have git on a PC without Git (scripts/package-git.cjs).
    afterCopy: [async ({ buildPath, platform }) => copyBundledGit(buildPath, platform)],
    // Forge's prune keeps the trees of ignored dependencies and every platform's node-pty and
    // sandbox-runtime helpers; drop what the target never loads (scripts/package-prune.cjs).
    afterPrune: [
      async ({ buildPath, platform, arch }) => {
        await pruneUnreachable(buildPath);
        await trimNodePty(buildPath, platform, arch);
        await trimSandboxVendor(buildPath, platform, arch);
      },
    ],
    extendInfo: {
      // The studio is meant to keep working while unattended and in the background.
      LSUIElement: false,
      NSHumanReadableCopyright: `© ${AUTHORS}`,
      // Agent children run as this app, so macOS attributes their folder access to it.
      NSDocumentsFolderUsageDescription: folderAccess("your Documents folder"),
      NSDesktopFolderUsageDescription: folderAccess("your Desktop"),
      NSDownloadsFolderUsageDescription: folderAccess("your Downloads folder"),
      NSRemovableVolumesUsageDescription: folderAccess("folders on an external drive"),
      // app_look reads an app window's accessibility tree through System Events (Automation), and
      // the embedded cua-driver runs as Genex, so its Automation and screen requests name Genex too.
      NSAppleEventsUsageDescription:
        "Genex reads an app window when an agent looks at it. It clicks and types only after you let the chat's agent use your computer.",
      NSScreenCaptureUsageDescription:
        "Genex sees your screen only after you let the chat's agent use your computer, so it can see the apps it works in.",
      // Voice chat in a Play game, only while the person turns its mic on in the game's header.
      NSMicrophoneUsageDescription:
        "Genex uses your microphone for voice chat in Play games, while you turn the mic on.",
    },
    // The Windows executable's version resource: what Explorer, Task Manager and UAC show.
    win32metadata: {
      CompanyName: PRODUCT_NAME,
      ProductName: PRODUCT_NAME,
      FileDescription: PRODUCT_NAME,
      InternalName: EXECUTABLE_NAME,
    },
    ...macSign,
    ...(windowsSign ? { windowsSign } : {}),
  },
  // Windows uses node-pty's own N-API prebuilds (conpty and winpty included) rather than
  // compiling it: nothing else native ships, and no Visual Studio is needed to package.
  rebuildConfig: process.platform === "win32" ? { ignoreModules: ["node-pty"] } : {},
  hooks: {
    // Before anything is copied: a linked node_modules would be pruned in place.
    prePackage: () => refuseLinkedModules(__dirname),
    // A macOS build no identity signs is signed again over its finished Info.plist: the fuses'
    // ad-hoc signature predates it, and macOS then refuses the agents protected folders unasked.
    postPackage: localSigningHook(macSign, PRODUCT_NAME),
  },
  makers: [
    {
      name: "@electron-forge/maker-dmg",
      platforms: ["darwin"],
      config: {
        name: PRODUCT_NAME,
        icon: `${ICON}.icns`,
        format: "ULFO",
        background: DMG_BACKGROUND,
        iconSize: DMG_ICON_SIZE,
        contents: ({ appPath }) => [
          { x: DMG_APP_X, y: DMG_ICON_Y, type: "file", path: appPath },
          { x: DMG_APPLICATIONS_X, y: DMG_ICON_Y, type: "link", path: "/Applications" },
        ],
      },
    },
    // Windows: a per-user install under %LOCALAPPDATA%\genex (Squirrel), which update.electronjs.org
    // updates from the release's RELEASES and nupkg. Named `genex`, not the npm package name.
    {
      name: "@electron-forge/maker-squirrel",
      platforms: ["win32"],
      config: {
        name: EXECUTABLE_NAME,
        title: PRODUCT_NAME,
        authors: AUTHORS,
        description: SUMMARY,
        setupExe: WINDOWS_SETUP_EXE,
        setupIcon: `${ICON}.ico`,
        // Shown while Setup installs, and behind the first start's setup screen: a dithered ripple
        // field that bends where it crosses the G.
        loadingGif: path.join(__dirname, "src", "renderer", "media", "installing.gif"),
        noMsi: true,
        ...(windowsSign ? { windowsSign } : {}),
      },
    },
    // The darwin zip is also what update.electronjs.org serves to installed copies.
    { name: "@electron-forge/maker-zip", platforms: ["darwin", "linux"] },
    {
      name: "@electron-forge/maker-deb",
      platforms: ["linux"],
      config: {
        options: {
          name: EXECUTABLE_NAME,
          // The packaged binary is `executableName`, not the npm package name the makers default to.
          bin: EXECUTABLE_NAME,
          productName: PRODUCT_NAME,
          genericName: GENERIC_NAME,
          description: SUMMARY,
          productDescription: DESCRIPTION,
          categories: LINUX_CATEGORIES,
          section: "devel",
          maintainer: AUTHORS,
          homepage: HOMEPAGE,
          icon: `${ICON}.png`,
          depends: LINUX_DEPENDS,
          scripts: DEB_SCRIPTS,
        },
      },
    },
    {
      name: "@electron-forge/maker-rpm",
      platforms: ["linux"],
      config: {
        options: {
          name: EXECUTABLE_NAME,
          // The packaged binary is `executableName`, not the npm package name the makers default to.
          bin: EXECUTABLE_NAME,
          productName: PRODUCT_NAME,
          genericName: GENERIC_NAME,
          description: SUMMARY,
          productDescription: DESCRIPTION,
          categories: LINUX_CATEGORIES,
          homepage: HOMEPAGE,
          icon: `${ICON}.png`,
          requires: LINUX_DEPENDS,
          license: "MIT",
          scripts: RPM_SCRIPTS,
        },
      },
    },
  ],
  plugins: [
    // Applied to the Electron binary before signing.
    new FusesPlugin({
      version: FuseVersion.V1,
      // ON: the harness, plugin backends, MCP servers, Genex and the self-edit gate are this
      // binary run with ELECTRON_RUN_AS_NODE.
      [FuseV1Options.RunAsNode]: true,
      // ON: cookies at rest are encrypted with the OS key store.
      [FuseV1Options.EnableCookieEncryption]: true,
      // OFF: NODE_OPTIONS and --inspect cannot inject code into a signed app (the harness host
      // already clears NODE_OPTIONS for its children).
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      // ON: the app loads only from app.asar, and that archive must match the hash in Info.plist
      // (packaged smoke checks both).
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
      // ON: the renderer loads over file://, which needs the privileges this fuse keeps.
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: true,
    }),
  ],
  publishers: [
    {
      name: "@electron-forge/publisher-github",
      config: {
        // This fork's repository, as UPDATE_REPO in src/main/auto-update.ts names it.
        repository: { owner: "Franzferdinan51", name: "genex-desktop" },
        draft: true,
        // The tag is v<version>; a pre-release version (0.2.0-rc.1) makes a GitHub pre-release.
        prerelease: version.includes("-"),
      },
    },
  ],
};
