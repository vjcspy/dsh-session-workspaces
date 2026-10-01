/**
 * The browser half's bundle.
 *
 * The DSH Client loads plugin bundles through the shell-owned module loader, so
 * the artifact must hand its factory to `window.__ModuleLoader__.load` instead
 * of exporting an ES module. `platform: 'browser'` + `format: 'cjs'` reproduce
 * the in-repo client-bundle preset, whose `require` answers from the preloaded
 * platform module table.
 *
 * React and its JSX runtimes are externals because the loader — not this bundle
 * — owns those instances; inlining a second copy would break hooks. The rest of
 * the list is the client baseline (`PLATFORM_MODULES` in
 * `packages/client/web/src/platform.ts`), which is implicit for every dynamic
 * bundle and stated here explicitly because this config is hand-rolled: the
 * in-repo preset derives it from `PLATFORM_MODULES`, which an external plugin
 * cannot import. `@deepseek-ai/dsh-client-ui-primitives` is a VALUE import (the
 * shipped menu-row button), so it must stay external too — it is a platform row,
 * and bundling a second copy would render rows the shell's menu keyboard walk
 * cannot see.
 *
 * The Host half is emitted by `tsc` (see `build:host`), which is why no `index`
 * entry appears here.
 */
import { defineConfig } from 'tsdown'

/** Package name; must equal the `id` the loader registers and `package.json` `name`. */
const PLUGIN_ID = 'dsh-session-workspaces'

/** Specifiers left to the shell's preloaded module table. */
const EXTERNAL = [
  'react',
  'react-dom',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

export default defineConfig({
  name: PLUGIN_ID,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: { neverBundle: EXTERNAL },
  // An inlined dependency reads `process.env.NODE_ENV`, and a browser bundle has
  // no `process`; the factory then throws `ReferenceError: process is not
  // defined` at boot and the whole client half fails to activate — a full-page
  // "Failed to load plugins", not a degraded section. The in-repo client preset
  // bakes the same substitution for the same reason, and an external plugin
  // cannot import that preset, so the define is stated here.
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
})
