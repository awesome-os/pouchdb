import * as path from 'node:path';
import * as rollupModule from 'rollup';
import { nodeResolve as rollupPluginNodeResolve } from '@rollup/plugin-node-resolve';
import rollupPluginReplace from '@rollup/plugin-replace';
import builtInModules from 'builtin-modules';

// Rollup plugins function
function getRollupPlugins(nodeResolveConfig: { mainFields?: string[]; browser?: boolean }): any[] {
  return [
    rollupPluginNodeResolve(nodeResolveConfig),
    rollupPluginReplace({
      // we have switches for coverage; don't ship this to consumers
      'process.env.COVERAGE': JSON.stringify(!!process.env.COVERAGE),
      // test for fetch vs xhr
      'process.env.FETCH': JSON.stringify(!!process.env.FETCH),
    }),
  ];
}

export interface ModuleRollupConfig {
  input: string;
  external: string[];
  plugins: any[];
  output: Array<{
    format: rollupModule.ModuleFormat;
    file: string;
  }>;
}

export interface PouchDBRollupConfig {
  input: string;
  external: string[];
  plugins: any[];
  outputFormat: string;
  outputFile: string;
}

/**
 * Generate rollup configs for building a module package
 */
export function getModuleRollupConfigs(
  filepath: string,
  pkg: any,
  topPkg: any,
  pouchdbPackages: string[],
  AGGRESSIVELY_BUNDLED_PACKAGES: string[],
  BROWSER_ONLY_PACKAGES: string[],
): ModuleRollupConfig[] {
  const dependencies = topPkg.dependencies || {};
  let depsToSkip = Object.keys(dependencies).concat(builtInModules);

  if (AGGRESSIVELY_BUNDLED_PACKAGES.indexOf(pkg.name) === -1) {
    depsToSkip = depsToSkip.concat(pouchdbPackages);
  }

  // browser & node vs one single vanilla version
  const versions = pkg.browser ? [false, true] : [false];

  // special case for "pouchdb-browser" - there is only one index.js,
  // and it's built in "browser mode"
  const forceBrowser = BROWSER_ONLY_PACKAGES.indexOf(pkg.name) !== -1;

  const configs: ModuleRollupConfig[] = [];

  versions.forEach((isBrowser) => {
    const rollupPluginsForVersion = getRollupPlugins({
      mainFields: ['module', 'main'],
      browser: isBrowser || forceBrowser,
    });

    const formats: rollupModule.ModuleFormat[] = ['cjs', 'es'];
    formats.forEach((format) => {
      const file = (isBrowser ? 'lib/index-browser' : 'lib/index') + (format === 'es' ? '.es.js' : '.js');
      configs.push({
        input: path.resolve(filepath, './src/index.js'),
        external: depsToSkip,
        plugins: rollupPluginsForVersion,
        output: [{
          format,
          file: path.resolve(filepath, file),
        }],
      });
    });
  });

  return configs;
}

/**
 * Generate rollup configs for building PouchDB main bundle
 */
export function getPouchDBRollupConfigs(
  pkgPath: string,
  external: string[],
  addPath: (pkgName: string, otherPath: string) => string,
): PouchDBRollupConfig[] {
  const configs: PouchDBRollupConfig[] = [];

  // build for Node (index.js)
  const nodePlugins = getRollupPlugins({
    mainFields: ['module'],
    browser: false,
  });
  configs.push({
    input: addPath('pouchdb', 'src/index.js'),
    external,
    plugins: nodePlugins,
    outputFormat: 'cjs',
    outputFile: addPath('pouchdb', 'lib/index.js'),
  });
  configs.push({
    input: addPath('pouchdb', 'src/index.js'),
    external,
    plugins: nodePlugins,
    outputFormat: 'es',
    outputFile: addPath('pouchdb', 'lib/index.es.js'),
  });

  // build for Browserify/Webpack (index-browser.js)
  const browserifyPlugins = getRollupPlugins({
    mainFields: ['module'],
    browser: true,
  });
  configs.push({
    input: addPath('pouchdb', 'src/index.js'),
    external,
    plugins: browserifyPlugins,
    outputFormat: 'cjs',
    outputFile: addPath('pouchdb', 'lib/index-browser.js'),
  });
  configs.push({
    input: addPath('pouchdb', 'src/index.js'),
    external,
    plugins: browserifyPlugins,
    outputFormat: 'es',
    outputFile: addPath('pouchdb', 'lib/index-browser.es.js'),
  });

  return configs;
}

/**
 * Generate rollup configs for building PouchDB plugins
 */
export function getPouchDBPluginRollupConfigs(
  plugins: string[],
  external: string[],
  addPath: (pkgName: string, otherPath: string) => string,
): PouchDBRollupConfig[] {
  const configs: PouchDBRollupConfig[] = [];
  const browserifyPlugins = getRollupPlugins({
    mainFields: ['module'],
    browser: true,
  });

  plugins.forEach((plugin) => {
    configs.push({
      input: addPath('pouchdb', 'src/plugins/' + plugin + '.js'),
      external,
      plugins: browserifyPlugins,
      outputFormat: 'cjs',
      outputFile: addPath('pouchdb', 'lib/plugins/' + plugin + '.js'),
    });
  });

  return configs;
}

/**
 * Get all rollup configs as an array
 * This is a convenience function that combines all config types
 */
export function getAllRollupConfigs(
  moduleConfigs?: ModuleRollupConfig[],
  pouchdbConfigs?: PouchDBRollupConfig[],
  pluginConfigs?: PouchDBRollupConfig[],
): Array<ModuleRollupConfig | PouchDBRollupConfig> {
  const allConfigs: Array<ModuleRollupConfig | PouchDBRollupConfig> = [];
  if (moduleConfigs) allConfigs.push(...moduleConfigs);
  if (pouchdbConfigs) allConfigs.push(...pouchdbConfigs);
  if (pluginConfigs) allConfigs.push(...pluginConfigs);
  return allConfigs;
}

