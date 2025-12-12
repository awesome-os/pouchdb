#!/usr/bin/env node

import { execSync, spawn, ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import * as zlib from 'node:zlib';
import { promisify } from 'node:util';
import { mkdir } from 'node:fs/promises';

// ESM imports for CommonJS modules
import * as rollupModule from 'rollup';
import rimraf from 'rimraf';
import builtInModules from 'builtin-modules';
import browserify from 'browserify';
import browserifyIncremental from 'browserify-incremental';
import derequire from 'derequire';
import streamToPromise from 'stream-to-promise';
import * as terser from 'terser';
import replace from 'replace';
import { 
  getModuleRollupConfigs, getPouchDBRollupConfigs, getPouchDBPluginRollupConfigs
 } from './rollup.config.ts';
import cssmin from 'cssmin';
import httpServer from 'http-server';
import watchGlob from 'glob-watcher';
import findRequires from 'find-requires';
import * as assert from 'node:assert';
import * as glob from 'glob';
import * as playwright from 'playwright';
import * as sourceMap from 'source-map';
import stacktraceParser from 'stacktrace-parser';
import * as mocha from 'mocha';

// Extract rollup function
const rollup = rollupModule.rollup;
import * as readline from 'readline';

const sleepAsync = promisify(setTimeout);

// Helper functions (replacing lodash)
function uniq<T>(array: T[]): T[] {
  return Array.from(new Set(array));
}

function debounce<T extends (...args: any[]) => any>(
  func: T,
  wait: number,
  options?: { leading?: boolean }
): (...args: Parameters<T>) => void {
  let timeout: NodeJS.Timeout | null = null;
  let lastCallTime = 0;

  return function debounced(...args: Parameters<T>) {
    const now = Date.now();
    const timeSinceLastCall = now - lastCallTime;
    
    if (options?.leading) {
      // Leading edge: call immediately if enough time has passed
      if (timeSinceLastCall >= wait) {
        lastCallTime = now;
        func(...args);
      }
      // Reset timeout to allow next leading call
      if (timeout) {
        clearTimeout(timeout);
      }
      timeout = setTimeout(() => {
        timeout = null;
      }, wait);
    } else {
      // Trailing edge: call after wait period
      if (timeout) {
        clearTimeout(timeout);
      }
      timeout = setTimeout(() => {
        timeout = null;
        func(...args);
      }, wait);
    }
  };
}

function identity<T>(value: T): T {
  return value;
}

function pickBy<T extends Record<string, any>>(
  object: T,
  predicate: (value: any, key: string) => boolean
): Partial<T> {
  const result: Partial<T> = {};
  for (const key in object) {
    if (Object.prototype.hasOwnProperty.call(object, key) && predicate(object[key], key)) {
      result[key] = object[key];
    }
  }
  return result;
}

// Helper function to run a command and throw on error
function exec(command: string, options: { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: 'inherit' | 'pipe'; shell?: boolean | string } = {}) {
  try {
    const shellOption = options.shell !== false 
      ? (os.platform() === 'win32' ? 'cmd.exe' : true)
      : (options.shell === false ? false : undefined);
    execSync(command, {
      cwd: options.cwd || process.cwd(),
      env: { ...process.env, ...options.env },
      stdio: options.stdio || 'inherit',
      encoding: 'utf8',
      shell: shellOption,
    } as any);
  } catch (error: any) {
    if (error.status !== undefined) {
      process.exit(error.status);
    }
    throw error;
  }
}

// Helper function to check if a command exists
function commandExists(command: string): boolean {
  try {
    if (os.platform() === 'win32') {
      execSync(`where ${command}`, { stdio: 'pipe', shell: 'cmd.exe' });
    } else {
      execSync(`command -v ${command}`, { stdio: 'pipe' });
    }
    return true;
  } catch {
    return false;
  }
}

// Helper function to read file and return lines
function readLines(filePath: string): string[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);
}

// Helper function to check if port is in use (cross-platform)
function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.listen(port, () => {
      server.once('close', () => resolve(false));
      server.close();
    });
    server.on('error', () => resolve(true));
  });
}

// Helper function to find free port
async function findFreePort(startPort: number = 3000): Promise<number> {
  let port = startPort;
  while (await isPortInUse(port)) {
    port++;
  }
  return port;
}

// Helper function to sleep (cross-platform)
function sleepSync(seconds: number) {
  if (os.platform() === 'win32') {
    execSync(`timeout /t ${seconds} /nobreak >nul 2>&1`, { stdio: 'pipe', shell: 'cmd.exe' });
  } else {
    execSync(`sleep ${seconds}`, { stdio: 'pipe' });
  }
}

export async function buildNode(...cmdArgs: string[]) {
  // don't bother doing this in GHA because it's already been built
  if (!process.env.GITHUB_REPOSITORY) {
    await buildModules();
  }
}

// Special case packages
const AGGRESSIVELY_BUNDLED_PACKAGES = ['pouchdb-for-coverage', 'pouchdb-node', 'pouchdb-browser'];
const BROWSER_ONLY_PACKAGES = ['pouchdb-browser'];
const BROWSER_DEPENDENCY_ONLY_PACKAGES = ['pouchdb-adapter-leveldb'];

async function buildModule(filepath: string): Promise<void> {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(filepath, 'package.json'), 'utf8'));
  const topPkg = JSON.parse(fs.readFileSync(path.resolve(filepath, '../../../package.json'), 'utf8'));
  const pouchdbPackages = fs.readdirSync(path.resolve(filepath, '..'));
  
  // All external modules are assumed to be CommonJS, and therefore should
  // be skipped by Rollup. We may revisit this later.
  const dependencies = topPkg.dependencies || {};
  let depsToSkip = Object.keys(dependencies).concat(builtInModules);

  if (AGGRESSIVELY_BUNDLED_PACKAGES.indexOf(pkg.name) === -1) {
    depsToSkip = depsToSkip.concat(pouchdbPackages);
  }

  // browser & node vs one single vanilla version
  const versions = pkg.browser ? [false, true] : [false];

  // technically this is necessary in source code because browserify
  // needs to know about the browser switches in the lib/ folder
  // some modules don't need this check and should be skipped
  const skipBrowserField = BROWSER_DEPENDENCY_ONLY_PACKAGES.indexOf(pkg.name) !== -1;
  if (!skipBrowserField && pkg.browser && pkg.browser['./lib/index.js'] !== './lib/index-browser.js') {
    throw new Error(pkg.name + ' is missing a "lib/index.js" entry in the browser field');
  }

  // special case for "pouchdb-browser" - there is only one index.js,
  // and it's built in "browser mode"
  const forceBrowser = BROWSER_ONLY_PACKAGES.indexOf(pkg.name) !== -1;

  // Clean and create lib directory
  const libPath = path.resolve(filepath, 'lib');
  if (fs.existsSync(libPath)) {
    await new Promise<void>((resolve, reject) => {
      rimraf(libPath, (err: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
  await mkdir(libPath, { recursive: true });

  // Get rollup configs from rollup.config.ts
  const configs = getModuleRollupConfigs(
    filepath,
    pkg,
    topPkg,
    pouchdbPackages,
    AGGRESSIVELY_BUNDLED_PACKAGES,
    BROWSER_ONLY_PACKAGES,
  );

  // Build all configs
  await Promise.all(configs.map(async (config) => {
    const bundle = await rollup({
      input: config.input,
      external: config.external,
      plugins: config.plugins,
    });

    await Promise.all(config.output.map(async (output) => {
      await bundle.write({
        format: output.format,
        file: output.file,
      });
      
      const isBrowser = output.file.includes('index-browser');
      const mode = isBrowser ? 'browser' : versions.length > 1 ? 'node' : 'vanilla';
      const relativeFile = path.relative(filepath, output.file);
      console.log(`  ✓ wrote ${path.basename(filepath)}/${relativeFile} in ${mode} mode`);
    }));
  }));
}


export async function buildModules(...cmdArgs: string[]) {
  const packagesDir = path.join(process.cwd(), 'packages', 'node_modules');
  
  if (!fs.existsSync(packagesDir)) {
    console.error(`Packages directory not found: ${packagesDir}`);
    process.exit(1);
  }

  const packages = fs.readdirSync(packagesDir);
  const buildPromises: Promise<void>[] = [];

  for (const pkg of packages) {
    const pkgPath = path.join(packagesDir, pkg);
    const stat = fs.statSync(pkgPath);
    
    if (!stat.isDirectory()) {
      // skip e.g. 'npm-debug.log'
      continue;
    }

    console.log(`Building ${pkg}...`);
    
    if (pkg === 'pouchdb') {
      // Build pouchdb package using integrated buildPouchDB function
      buildPromises.push(
        buildPouchDB().catch((err: Error) => {
          console.error(`Error building ${pkg}:`);
          console.error(err.stack);
          throw err;
        })
      );
    } else {
      // Build other modules using integrated buildModule function
      buildPromises.push(
        buildModule(pkgPath).catch((err: Error) => {
          console.error(`Error building ${pkg}:`);
          console.error(err.stack);
          throw err;
        })
      );
    }
  }

  try {
    await Promise.all(buildPromises);
  } catch (err: any) {
    console.error('build error');
    if (err.stack) {
      console.error(err.stack);
    } else {
      console.error(err);
    }
    process.exit(1);
  }
}

// Build utilities for pouchdb
function addPath(pkgName: string, otherPath: string): string {
  return path.resolve(path.join('packages', 'node_modules', pkgName), otherPath);
}

async function writeFile(filename: string, contents: string): Promise<void> {
  const tmp = filename + '.tmp';
  await fs.promises.writeFile(tmp, contents, 'utf-8');
  await fs.promises.rename(tmp, filename);
  const match = filename.match(/packages[/\\]node_modules[/\\]\S*?[/\\].*/);
  if (match) {
    console.log(`  ✓ wrote ${match[0]}`);
  }
}

async function doUglify(pkgName: string, code: string, prepend: string, fileOut: string): Promise<void> {
  const filename = fileOut.replace(/.*\//, '');
  const sourceMap = { filename, url: filename + '.map' };
  const minified = await terser.minify(code, { 
    output: { ascii_only: true }, 
    sourceMap 
  } as any);
  if (minified.code) {
    await writeFile(addPath(pkgName, fileOut), prepend + minified.code);
  }
  if (minified.map) {
    const mapContent = typeof minified.map === 'string' ? minified.map : JSON.stringify(minified.map);
    await writeFile(addPath(pkgName, fileOut) + '.map', mapContent);
  }
}

const browserifyCache: Record<string, any> = {};

async function doBrowserify(pkgName: string, filepath: string, opts: any = {}, exclude?: string): Promise<string> {
  const fullPath = addPath(pkgName, filepath);
  let bundler = browserifyCache[filepath];

  if (!bundler) {
    const DEV_MODE = process.env.CLIENT === 'dev';
    if (DEV_MODE) {
      opts.debug = true;
      bundler = browserifyIncremental(fullPath, opts);
      bundler.on('time', (time: number) => {
        console.log(`    took ${time} ms to browserify ${path.dirname(filepath)}/${path.basename(filepath)}`);
      });
    } else {
      bundler = browserify(fullPath, opts);
    }

    if (exclude) {
      bundler.external(exclude);
    }
    browserifyCache[filepath] = bundler;
  }

  const code = await streamToPromise(bundler.bundle());
  const codeString = code.toString('utf8');
  const DEV_MODE = process.env.CLIENT === 'dev';
  if (!DEV_MODE) {
    return derequire(codeString);
  }
  return codeString;
}

async function buildPouchDB(): Promise<void> {
  const DEV_MODE = process.env.CLIENT === 'dev';
  const pkgPath = path.join(process.cwd(), 'packages', 'node_modules', 'pouchdb');
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgPath, 'package.json'), 'utf8'));
  const version = pkg.version;
  const topPkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
  const external = Object.keys(topPkg.dependencies || {}).concat(builtInModules);
  const plugins = ['indexeddb', 'localstorage', 'memory', 'find'];
  const currentYear = new Date().getFullYear();

  const comments: Record<string, string> = {
    'pouchdb': `// PouchDB ${version}\n// \n// (c) 2012-${currentYear} Dale Harvey and the PouchDB team\n// PouchDB may be freely distributed under the Apache license, version 2.0.\n// For all details and documentation:\n// http://pouchdb.com\n`,
    'indexeddb': `// PouchDB indexeddb plugin ${version}\n`,
    'memory': `// PouchDB in-memory plugin ${version}\n// Based on MemDOWN: https://github.com/rvagg/memdown\n// \n// (c) 2012-${currentYear} Dale Harvey and the PouchDB team\n// PouchDB may be freely distributed under the Apache license, version 2.0.\n// For all details and documentation:\n// http://pouchdb.com\n`,
    'localstorage': `// PouchDB localStorage plugin ${version}\n// Based on localstorage-down: https://github.com/No9/localstorage-down\n// \n// (c) 2012-${currentYear} Dale Harvey and the PouchDB team\n// PouchDB may be freely distributed under the Apache license, version 2.0.\n// For all details and documentation:\n// http://pouchdb.com\n`,
    'find': `// pouchdb-find plugin ${version}\n// Based on Mango: https://github.com/cloudant/mango\n// \n// (c) 2012-${currentYear} Dale Harvey and the PouchDB team\n// PouchDB may be freely distributed under the Apache license, version 2.0.\n// For all details and documentation:\n// http://pouchdb.com\n`,
  };

  // build for Node (index.js)
  async function buildForNode(): Promise<void> {
    const configs = getPouchDBRollupConfigs(pkgPath, external, addPath).filter(
      config => config.outputFile.includes('lib/index') && !config.outputFile.includes('browser')
    );
    
    await Promise.all(configs.map(async (config) => {
      const start = process.hrtime();
      const bundle = await rollup({
        input: config.input,
        external: config.external,
        plugins: config.plugins,
      });

      const generated = await bundle.generate({ format: config.outputFormat as rollupModule.ModuleFormat });
      if (DEV_MODE) {
        const ms = Math.round(process.hrtime(start)[1] / 1000000);
        console.log(`    took ${ms} ms to rollup ${path.relative(addPath('pouchdb', ''), config.input)}`);
      }
      const output = generated.output[0];
      if (!output || !('code' in output)) {
        throw new Error(`Expected OutputChunk but got ${output ? 'OutputAsset' : 'undefined'}`);
      }
      await writeFile(config.outputFile, output.code);
    }));
  }

  // build for Browserify/Webpack (index-browser.js)
  async function buildForBrowserify(): Promise<void> {
    const configs = getPouchDBRollupConfigs(pkgPath, external, addPath).filter(
      config => config.outputFile.includes('lib/index-browser')
    );
    
    await Promise.all(configs.map(async (config) => {
      const start = process.hrtime();
      const bundle = await rollup({
        input: config.input,
        external: config.external,
        plugins: config.plugins,
      });

      const generated = await bundle.generate({ format: config.outputFormat as rollupModule.ModuleFormat });
      if (DEV_MODE) {
        const ms = Math.round(process.hrtime(start)[1] / 1000000);
        console.log(`    took ${ms} ms to rollup ${path.relative(addPath('pouchdb', ''), config.input)}`);
      }
      const output = generated.output[0];
      if (!output || !('code' in output)) {
        throw new Error(`Expected OutputChunk but got ${output ? 'OutputAsset' : 'undefined'}`);
      }
      await writeFile(config.outputFile, output.code);
    }));
  }

  // build for the browser (dist)
  async function buildForBrowser(): Promise<void> {
    const code = await doBrowserify('pouchdb', 'lib/index-browser.js', {
      standalone: 'PouchDB',
    });
    const codeWithComments = comments.pouchdb + code;
    await Promise.all([
      writeFile(addPath('pouchdb', 'dist/pouchdb.js'), codeWithComments),
      doUglify('pouchdb', codeWithComments, comments.pouchdb, 'dist/pouchdb.min.js'),
    ]);
  }

  async function buildPluginsForBrowserify(): Promise<void> {
    const configs = getPouchDBPluginRollupConfigs(plugins, external, addPath);
    
    await Promise.all(configs.map(async (config) => {
      const start = process.hrtime();
      const bundle = await rollup({
        input: config.input,
        external: config.external,
        plugins: config.plugins,
      });

      const generated = await bundle.generate({ format: config.outputFormat as rollupModule.ModuleFormat });
      if (DEV_MODE) {
        const ms = Math.round(process.hrtime(start)[1] / 1000000);
        console.log(`    took ${ms} ms to rollup ${path.relative(addPath('pouchdb', ''), config.input)}`);
      }
      const output = generated.output[0];
      if (!output || !('code' in output)) {
        throw new Error(`Expected OutputChunk but got ${output ? 'OutputAsset' : 'undefined'}`);
      }
      await writeFile(config.outputFile, output.code);
    }));
  }

  async function buildPluginsForBrowser(): Promise<void> {
    await Promise.all(plugins.map(async (plugin) => {
      const source = 'lib/plugins/' + plugin + '.js';
      const code = await doBrowserify('pouchdb', source, {}, 'pouchdb');
      const codeWithComments = comments[plugin] + code;
      await Promise.all([
        writeFile(path.join(pkgPath, 'dist', `pouchdb.${plugin}.js`), codeWithComments),
        doUglify('pouchdb', codeWithComments, comments[plugin], `dist/pouchdb.${plugin}.min.js`),
      ]);
    }));
    
    // no need for this after building dist/
    const libPluginsPath = addPath('pouchdb', 'lib/plugins');
    if (fs.existsSync(libPluginsPath)) {
      await new Promise<void>((resolve, reject) => {
        rimraf(libPluginsPath, (err: Error | null) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  }

  async function rimrafMkdirp(...args: string[]): Promise<void> {
    await Promise.all(args.map((otherPath) => {
      return new Promise<void>((resolve, reject) => {
        rimraf(addPath('pouchdb', otherPath), (err: Error | null) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }));
    await Promise.all(args.map((otherPath) => {
      return mkdir(addPath('pouchdb', otherPath), { recursive: true });
    }));
  }

  async function doBuildNode(): Promise<void> {
    await mkdir(addPath('pouchdb', 'lib/plugins'), { recursive: true });
    await buildForNode();
  }

  async function doBuildAll(): Promise<void> {
    await rimrafMkdirp('lib', 'dist', 'lib/plugins');
    await Promise.all([buildForNode(), buildForBrowserify()]);
    await Promise.all([buildForBrowser(), buildPluginsForBrowserify()]);
    await buildPluginsForBrowser();
  }

  if (process.env.BUILD_NODE) {
    // rebuild before "npm test"
    await doBuildNode();
  } else {
    // normal, full build
    await doBuildAll();
  }
}

export function installJekyll(...cmdArgs: string[]) {
  if (!commandExists('bundler')) {
    console.error('bundler is not installed.  You need to do: gem install bundler');
    process.exit(1);
  }

  const docsPath = path.join(process.cwd(), 'docs');
  exec('bundle install', { cwd: docsPath });
}

function shouldPublish(pkg: string): boolean {
  const pkgPath = path.join(process.cwd(), 'packages', 'node_modules', pkg);
  if (!fs.existsSync(pkgPath)) {
    return false;
  }

  const packageJsonPath = path.join(pkgPath, 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  return packageJson.private !== true;
}

function publishPackage(pkg: string): boolean {
  const pkgPath = path.join(process.cwd(), 'packages', 'node_modules', pkg);
  process.chdir(pkgPath);
  console.log(`Publishing ${pkg}...`);

  try {
    if (process.env.DRY_RUN) {
      console.log('Dry run, not publishing');
    } else if (process.env.BETA) {
      exec('npm publish --tag beta');
    } else {
      exec('npm publish');
    }
    return true;
  } catch {
    return false;
  }
}

export function publishPackages(...cmdArgs: string[]) {
  const rootDir = process.cwd();
  const todoPath = path.join(rootDir, 'release-todo.txt');

  if (!fs.existsSync(todoPath)) {
    console.log('No packages to release, quitting.');
    return;
  }

  const pkgs = readLines(todoPath);
  let failed = false;

  for (const pkg of pkgs) {
    process.chdir(rootDir);

    if (!shouldPublish(pkg)) {
      continue;
    }

    if (!failed) {
      if (!publishPackage(pkg)) {
        failed = true;
        console.error(`Publishing '${pkg}' failed, quitting.`);
        fs.writeFileSync(todoPath, pkg + '\n');
      }
    } else {
      fs.appendFileSync(todoPath, pkg + '\n');
    }
  }

  if (!failed) {
    fs.unlinkSync(todoPath);
  } else {
    process.exit(1);
  }
}

export async function publishSite(...cmdArgs: string[]) {
  // Build the website
  process.env.BUILD = '1';
  await buildSite();

  // Push the site live, requires credentials, open a bug
  // if you need to be able to push the site
  exec('rsync --recursive --progress docs/_site/* pouchdb@pouchdb.com:/home/pouchdb/www/pouchdb.com/');
}

// Build site function
export async function buildSite(...cmdArgs: string[]): Promise<void> {
  const buildMode = process.env.BUILD === '1';
  const originalCwd = process.cwd();
  const docsPath = path.join(process.cwd(), 'docs');
  
  // Change to docs directory
  process.chdir(docsPath);

  try {
    await checkJekyll();
    await buildCSS();
    await buildJekyll();

    if (!buildMode) {
      // Start watch mode and server
      await startSiteServer();
    }
  } finally {
    // Restore original directory
    process.chdir(originalCwd);
  }
}

async function checkJekyll(): Promise<void> {
  try {
    await exec('bundle check');
  } catch (err) {
    throw new Error('Jekyll is not installed.  You need to do: npm run install-jekyll');
  }
}

async function buildCSS(): Promise<void> {
  const cssDir = path.join(process.cwd(), 'static', 'css');
  if (!fs.existsSync(cssDir)) {
    fs.mkdirSync(cssDir, { recursive: true });
  }

  const lessPath = path.join(process.cwd(), 'src', 'less', 'pouchdb', 'pouchdb.less');
  const cssPath = path.join(cssDir, 'pouchdb.css');
  
  const lesscPath = path.join(process.cwd(), '..', 'node_modules', 'less', 'bin', 'lessc');
  const stdout = execSync(`${lesscPath} ${lessPath}`, { encoding: 'utf8' });
  const minifiedCss = cssmin(stdout);
  fs.writeFileSync(cssPath, minifiedCss);
  console.log('Updated:', cssPath);
}

async function buildJekyll(): Promise<void> {
  await exec('bundle exec jekyll build');
  console.log('=> Rebuilt jekyll');

  highlightEs6();
  console.log('=> Highlighted ES6');

  const srcPath = path.join(process.cwd(), 'src', 'code.js');
  const targetPath = path.join(process.cwd(), '_site', 'static', 'js', 'code.min.js');
  const src = fs.readFileSync(srcPath, { encoding: 'utf8' });
  const mangle = { toplevel: true };
  const output = { ascii_only: true };
  const minified = await terser.minify(src, { mangle, output } as any);
  
  if ((minified as any).error) {
    if (process.env.BUILD) {
      throw (minified as any).error;
    } else {
      const error = (minified as any).error;
      console.log(
        `Javascript minification failed on line ${error.line} col ${error.col}:`,
        error.message,
      );
    }
  } else if (minified.code) {
    fs.writeFileSync(targetPath, minified.code);
    console.log('Minified javascript.');
  }
}

function highlightEs6(): void {
  const sitePath = path.join(process.cwd(), '_site');

  // TODO: this is a fragile and hacky way to get
  // 'async' and 'await' to highlight correctly
  // in blog posts & documentation.
  replace({
    regex: '<span class="nx">(await|async|of)</span>',
    replacement: '<span class="kd">$1</span>',
    paths: [sitePath],
    recursive: true,
  });
}

async function startSiteServer(): Promise<void> {
  const sitePath = path.join(process.cwd(), '_site');
  
  // Watch for changes
  fs.readdirSync(process.cwd())
    .forEach((filePath) => {
      if (filePath === '_site' || filePath.startsWith('Gemfile')) {
        return;
      }

      const fullPath = path.join(process.cwd(), filePath);
      if (fs.statSync(fullPath).isDirectory()) {
        watchGlob(`${filePath}/**`, buildJekyll);
      } else {
        watchGlob(filePath, buildJekyll);
      }
    });

  watchGlob('static/src/*/*.less', buildCSS);

  httpServer.createServer({ root: sitePath, cache: '-1' }).listen(4000);
  console.log('Server address: http://localhost:4000');
}

export function release(...cmdArgs: string[]) {
  if (process.env.DRY_RUN) {
    console.log('Doing a dry run release...');
  } else if (process.env.BETA) {
    console.log('Doing a beta release to npm...');
  } else {
    console.log('Doing a real release! Use DRY_RUN=1 for a dry run instead.');
  }

  // make sure deps are up to date
  if (fs.existsSync('node_modules')) {
    fs.rmSync('node_modules', { recursive: true, force: true });
  }
  exec('npm clean-install');

  // get current version
  const packageJsonPath = path.join(process.cwd(), 'packages', 'node_modules', 'pouchdb', 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const VERSION = packageJson.version;

  // Create a temporary build directory
  const sourceDir = execSync('git name-rev --name-only HEAD', { encoding: 'utf8' }).trim();
  const buildDir = `build_${Math.floor(Math.random() * 1000000)}`;
  exec(`git checkout -b ${buildDir}`);

  // Update dependency versions inside each package.json (replace the "*")
  updatePackageJsonForPublish();

  // Publish all modules with Lerna
  const packagesDir = path.join(process.cwd(), 'packages', 'node_modules');
  const packages = fs.readdirSync(packagesDir);
  fs.writeFileSync('release-todo.txt', packages.join('\n') + '\n');
  publishPackages();

  // Create git tag, which is also the Bower/Github release
  const filesToRemove = ['lib', 'src', 'dist', 'bower.json', 'component.json', 'package.json'];
  for (const file of filesToRemove) {
    const filePath = path.join(process.cwd(), file);
    if (fs.existsSync(filePath)) {
      if (fs.statSync(filePath).isDirectory()) {
        fs.rmSync(filePath, { recursive: true, force: true });
      } else {
        fs.unlinkSync(filePath);
      }
    }
  }

  const pouchdbPath = path.join(process.cwd(), 'packages', 'node_modules', 'pouchdb');
  const filesToCopy = ['src', 'lib', 'dist', 'bower.json', 'component.json', 'package.json'];
  for (const file of filesToCopy) {
    const srcPath = path.join(pouchdbPath, file);
    const destPath = path.join(process.cwd(), file);
    if (fs.existsSync(srcPath)) {
      if (fs.statSync(srcPath).isDirectory()) {
        if (fs.existsSync(destPath)) {
          fs.rmSync(destPath, { recursive: true, force: true });
        }
        fs.cpSync(srcPath, destPath, { recursive: true });
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  exec('git add -f -- lib src dist *.json');
  exec('git rm -fr packages bin docs tests');
  exec(`git commit -m "build ${VERSION}"`);

  // Only "publish" to GitHub/Bower if this is a non-beta non-dry run
  if (!process.env.DRY_RUN) {
    if (!process.env.BETA) {
      // Tag and push
      exec(`git tag "${VERSION}"`);
      exec(`git push --tags git@github.com:pouchdb/pouchdb.git "${VERSION}"`);

      // Cleanup
      exec(`git checkout "${sourceDir}"`);
      exec(`git branch -D ${buildDir}`);
    }
  }
}

export async function repeatPerfTest(...cmdArgs: string[]) {
  const scriptName = 'repeat-perf-test';
  const log = (msg: string) => console.log(`[${scriptName}] ${msg}`);

  const npmInstall = () => {
    exec('npm install --no-fund --ignore-scripts --no-audit --prefer-offline --progress=false');
  };

  const perfTestResultsDir = path.join(process.cwd(), 'perf-test-results');
  if (!fs.existsSync(perfTestResultsDir)) {
    fs.mkdirSync(perfTestResultsDir, { recursive: true });
  }

  const flagFileDevServerRunning = path.join(perfTestResultsDir, '.dev-server-started');
  let serverPid: ChildProcess | null = null;

  const cleanup = () => {
    if (serverPid && serverPid.pid) {
      try {
        process.kill(serverPid.pid);
        log('Shutting down dev server...');
        log('Shutdown complete.');
      } catch (e) {
        // Process already dead
      }
    }
    if (fs.existsSync(flagFileDevServerRunning)) {
      fs.unlinkSync(flagFileDevServerRunning);
    }
  };

  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(1);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(1);
  });

  if (fs.existsSync(flagFileDevServerRunning)) {
    log('!!!');
    log(`!!! Cannot start tests - flag file already exists at ${flagFileDevServerRunning}`);
    log('!!! Are tests running in another process?');
    log('!!!');
    process.exit(1);
  }

  if (cmdArgs.length < 1) {
    console.log(`
    DESCRIPTION
      Repeatedly run the performance test suite against one or more versions of the codebase.

    USAGE
      [PERF_REPEATS=<N>] repeatPerfTest ...tree-ish:adapter
`);
    process.exit(1);
  }

  console.log();
  if (!process.env.PERF_REPEATS) {
    log('Running perf tests ENDLESSLY on:');
  } else {
    log(`Running perf tests ${process.env.PERF_REPEATS} times on:`);
  }
  log('');

  const commits: string[] = [];
  const adapters: string[] = [];
  let i = 0;
  for (const treeishAdapter of cmdArgs) {
    const colonIndex = treeishAdapter.indexOf(':');
    const adapter = treeishAdapter.substring(colonIndex + 1);
    const treeish = treeishAdapter.substring(0, colonIndex);
    adapters[i] = adapter;
    commits[i] = execSync(`git rev-parse "${treeish}"`, { encoding: 'utf8' }).trim();
    const description = execSync(`git show --oneline --no-patch "${treeish}"`, { encoding: 'utf8' }).trim();
    log(`  ${i + 1}. ${adapter}: ${description} (${treeish})`);
    i++;
  }
  log('');
  log('!!! This may cause strange issues if you have uncomitted changes. !!!');
  log('');
  log('Press <enter> to continue.');
  console.log();

  // Wait for user input
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  
  await new Promise<void>((resolve) => {
    rl.question('', () => {
      rl.close();
      resolve();
    });
  });
  
  await continuePerfTest();

  async function continuePerfTest() {
    await waitForCouch('20');

    const distBundlesDir = path.join(process.cwd(), 'dist-bundles');
    if (!fs.existsSync(distBundlesDir)) {
      fs.mkdirSync(distBundlesDir, { recursive: true });
    }

    log('Building bundles...');
    for (const commit of commits) {
      const targetDir = path.join(distBundlesDir, commit);
      if (fs.existsSync(targetDir)) {
        log(`Skipping build for ${commit} - dist files already found at ${targetDir}.`);
      } else {
        log(`Building commit ${commit}...`);
        exec(`git checkout "${commit}"`);
        npmInstall(); // in case of different deps on different branches
        await buildModules();
        await buildTest();

        if (!fs.existsSync(targetDir)) {
          fs.mkdirSync(targetDir, { recursive: true });
        }
        const pouchdbDist = path.join(process.cwd(), 'packages', 'node_modules', 'pouchdb', 'dist');
        if (fs.existsSync(pouchdbDist)) {
          fs.cpSync(pouchdbDist, targetDir, { recursive: true });
        }

        exec('git checkout -');
      }
    }

    log('Building tests...');
    npmInstall(); // in case of different deps on different branches
    await buildTest();

    const iterateTests = async () => {
      for (let i = 0; i < commits.length; i++) {
        const commit = commits[i];
        const adapter = adapters[i];
        log(`Running perf tests on ${commit} with adapter-${adapter}...`);
        const env = {
          ...process.env,
          SRC_ROOT: `../../dist-bundles/${commit}`,
          JSON_REPORTER: '1',
          TYPE: 'performance',
          USE_MINIFIED: '1',
          MANUAL_DEV_SERVER: '1',
          ADAPTERS: adapter,
        };
        // Set environment and call testBrowser
        const originalEnv = { ...process.env };
        Object.assign(process.env, env);
        await testBrowser();
        Object.assign(process.env, originalEnv);
        // sleep 1
        sleepSync(1);
      }
    };

    log('Installing playwright brower...');
    exec(`npx playwright install "${process.env.CLIENT || 'firefox'}"`);

    log('Starting dev server...');
    startDevServer(() => {
      console.log(`[${scriptName}] Dev server ready.`);
      fs.writeFileSync(flagFileDevServerRunning, '');
    });
    serverPid = { pid: undefined } as any; // Mark as started

    // Wait for flag file
    while (!fs.existsSync(flagFileDevServerRunning)) {
      sleepSync(1);
    }
    log('Dev server started OK!');

    log('Running tests...');
    if (!process.env.PERF_REPEATS) {
      while (true) {
        await iterateTests();
      }
    } else {
      let repeats = parseInt(process.env.PERF_REPEATS, 10);
      while (repeats-- > 0) {
        await iterateTests();
        log(`Iterations remaining: ${repeats}`);
      }
    }

    log('All tests complete.');
  }
}

export async function runDev(...cmdArgs: string[]) {
  await buildPouchDB();
  await buildTest();
  process.env.CLIENT = 'dev';
  await runTest();
}

export async function runTest(...cmdArgs: string[]) {
  let serverPid: ChildProcess | null = null;

  const cleanup = () => {
    if (serverPid && serverPid.pid) {
      try {
        process.kill(serverPid.pid);
      } catch (e) {
        // Process already dead
      }
    }
  };

  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(1);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(1);
  });

  // Run tests against a local setup of pouchdb-express-router
  // by default unless COUCH_HOST is specified.
  if (!process.env.COUCH_HOST && !process.env.SERVER) {
    process.env.SERVER = 'pouchdb-express-router';
  }

  process.env.CLIENT = process.env.CLIENT || 'node';
  process.env.COUCH_HOST = process.env.COUCH_HOST || 'http://127.0.0.1:5984';
  process.env.VIEW_ADAPTERS = process.env.VIEW_ADAPTERS || 'memory';

  const pouchdbSetupServer = () => {
    // in CI, link pouchdb-servers dependencies on pouchdb
    // modules to the current implementations
    const serverInstallDir = path.join(process.cwd(), 'pouchdb-server-install');
    if (fs.existsSync(serverInstallDir)) {
      fs.rmSync(serverInstallDir, { recursive: true, force: true });
    }
    fs.mkdirSync(serverInstallDir, { recursive: true });
    process.chdir(serverInstallDir);
    exec('npm init -y');
    exec('npm install pouchdb-server');
    process.chdir('..');

    const packagesDir = path.join(process.cwd(), 'packages', 'node_modules');
    const packages = fs.readdirSync(packagesDir);
    for (const pkg of packages) {
      pouchdbLinkServerModules(pkg);
    }

    const testDir = path.join(process.cwd(), 'tests', 'pouchdb_server');
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    fs.mkdirSync(testDir, { recursive: true });

    const flags = (process.env.POUCHDB_SERVER_FLAGS || '').split(' ').filter(f => f);
    flags.push('--dir', testDir);
    console.log(`Starting up pouchdb-server with flags: ${flags.join(' ')} \n`);

    const serverProcess = spawn(
      path.join(serverInstallDir, 'node_modules', '.bin', 'pouchdb-server'),
      ['-n', '-p', '6984', ...flags],
      { stdio: 'inherit', detached: false }
    );
    serverPid = serverProcess;
    process.env.SERVER_PID = String(serverProcess.pid);
  };

  const pouchdbLinkServerModules = (pkg: string) => {
    const pkgPath = path.join(process.cwd(), 'packages', 'node_modules', pkg);
    process.chdir(pkgPath);
    exec('npm link');
    process.chdir(path.join(process.cwd(), '..', '..', '..', 'pouchdb-server-install'));

    // node_modules of pouchdb-server-install
    const pkgNodeModulesPath = path.join(process.cwd(), 'node_modules', pkg);
    if (fs.existsSync(pkgNodeModulesPath)) {
      console.log(`\nnpm link ${pkg} for pouchdb-server-install`);
      exec(`npm link "${pkg}"`);
    }

    // internal node_modules of other packages
    function findSubPackages(dir: string, pkgName: string, results: string[] = []): string[] {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules') {
            const pkgPath = path.join(fullPath, pkgName);
            if (fs.existsSync(pkgPath)) {
              results.push(pkgPath);
            }
          }
          findSubPackages(fullPath, pkgName, results);
        }
      }
      return results;
    }
    const subPkgs = findSubPackages(path.join(process.cwd(), 'node_modules'), pkg);
    for (const subPkg of subPkgs) {
      const parentPath = path.dirname(path.dirname(subPkg));
      process.chdir(parentPath);
      console.log(`\nnpm link ${pkg} for ${subPkg}`);
      exec(`npm link "${pkg}"`);
      process.chdir(path.join(process.cwd(), '..', '..'));
    }

    process.chdir('..');
  };

  const searchFreePort = async () => {
    const port = await findFreePort(3000);
    process.env.PORT = String(port);
    return port;
  };

  const pouchdbBuildNode = async () => {
    if (process.env.BUILD_NODE_DONE !== '1') {
      await buildNode();
      process.env.BUILD_NODE_DONE = '1';
    }
  };

  if (process.env.CI === 'true' && process.env.CLIENT !== 'node') {
    exec(`npx playwright install --with-deps "${process.env.CLIENT}"`);
  }

  if (process.env.SERVER) {
    if (process.env.SERVER === 'pouchdb-server') {
      process.env.COUCH_HOST = 'http://127.0.0.1:6984';
      if (process.env.GITHUB_REPOSITORY || process.env.COVERAGE === '1') {
        pouchdbSetupServer();
      } else {
        console.log(`pouchdb-server should be running on ${process.env.COUCH_HOST}\n`);
      }
    } else if (process.env.SERVER === 'couchdb-master') {
      if (!process.env.COUCH_HOST) {
        process.env.COUCH_HOST = 'http://127.0.0.1:5984';
      }
    } else if (process.env.SERVER === 'pouchdb-express-router') {
      await pouchdbBuildNode();
      const port = await searchFreePort();
      const expressProcess = spawn('node', ['./tests/misc/pouchdb-express-router.js'], {
        stdio: 'inherit',
        detached: false,
        env: { ...process.env, PORT: String(port) },
      });
      serverPid = expressProcess;
      process.env.COUCH_HOST = `http://127.0.0.1:${port}`;
    } else if (process.env.SERVER === 'express-pouchdb-minimum') {
      await pouchdbBuildNode();
      const expressProcess = spawn('node', ['./tests/misc/express-pouchdb-minimum-for-pouchdb.js'], {
        stdio: 'inherit',
        detached: false,
      });
      serverPid = expressProcess;
      process.env.COUCH_HOST = 'http://127.0.0.1:3000';
    } else {
      // I mistype pouchdb-server a lot
      console.error(`Unknown SERVER ${process.env.SERVER}. Did you mean pouchdb-server?\n`);
      process.exit(1);
    }
  }

  await waitForCouch('20');

  if (process.env.SERVER === 'couchdb-master') {
    console.log('\nEnabling CORS...');
    exec('./node_modules/.bin/add-cors-to-couchdb', { env: { COUCH_HOST: process.env.COUCH_HOST } });
  }

  if (process.env.CLIENT === 'unit') {
    exec('npm run test-unit'); // Keep this as it's just mocha
  } else if (process.env.CLIENT === 'node') {
    await pouchdbBuildNode();
    await testNode();
  } else if (process.env.CLIENT === 'dev') {
    startDevServer();
  } else {
    await testBrowser();
  }
}

export async function testCoverage(...cmdArgs: string[]) {
  process.env.COVERAGE = '1';
  await runTest();
}

export async function testNode(...cmdArgs: string[]) {
  process.env.TIMEOUT = process.env.TIMEOUT || '5000';
  process.env.REPORTER = process.env.REPORTER || 'spec';
  process.env.BAIL = process.env.BAIL || '1';
  process.env.TYPE = process.env.TYPE || 'integration';

  const bailOpt = process.env.BAIL === '1' ? '--bail' : '';

  let testsPath = '';
  let downServerPid: ChildProcess | null = null;

  if (process.env.TYPE === 'integration') {
    if (await isPortInUse(3010)) {
      console.log('down-server port already in use');
    } else {
      // Start down server in background
      const httpModule = require('http') as typeof import('http');
      const server = httpModule.createServer((request: any, response: any) => {
        response.writeHead(500, { 'Content-Type': 'application/json' });
        response.end('{}');
      });
      server.listen(3010, () => {
        console.log('Down server listening on port 3010');
      });
      downServerPid = { pid: undefined } as any; // Mark as started
      process.env.DOWN_SERVER_PID = '1';
    }
    testsPath = 'tests/integration/test.*.js';
  }
  if (process.env.TYPE === 'fuzzy') {
    testsPath = 'tests/fuzzy/test.*.js';
  }
  if (process.env.TYPE === 'mapreduce') {
    testsPath = 'tests/mapreduce/test.*.js';
  }
  if (process.env.TYPE === 'find') {
    testsPath = 'tests/find/*/test.*.js';
  }
  if (process.env.COVERAGE) {
    // run all tests when testing for coverage
    testsPath = 'tests/{unit,integration,mapreduce,component}/test*.js tests/find/*/test.*.js';
  }

  let exitStatus = 0;

  try {
    if (process.env.TYPE === 'performance') {
      exec('node tests/performance/index.js');
    } else if (!process.env.COVERAGE) {
      // --exit required to workaround #8839
      const mochaCmd = `./node_modules/.bin/mocha --exit ${bailOpt} --timeout "${process.env.TIMEOUT}" --require=./tests/integration/node.setup.js --reporter="${process.env.REPORTER}" --grep="${process.env.GREP || ''}" "${testsPath}"`;
      exec(mochaCmd);
    } else {
      // --exit required to workaround #8839
      const istanbulCmd = `./node_modules/.bin/istanbul cover --no-default-excludes -x 'tests/**' -x 'node_modules/**' ./node_modules/mocha/bin/_mocha -- --exit ${bailOpt} --timeout "${process.env.TIMEOUT}" --require=./tests/integration/node.setup.js --reporter="${process.env.REPORTER}" --grep="${process.env.GREP || ''}" "${testsPath}"`;
      exec(istanbulCmd);
      exec('./node_modules/.bin/istanbul check-coverage --line 100');
    }
  } catch (error: any) {
    exitStatus = error.status || 1;
  }

  if (downServerPid && downServerPid.pid) {
    try {
      process.kill(downServerPid.pid);
    } catch (e) {
      // Process already dead
    }
  }

  if (exitStatus !== 0) {
    process.exit(exitStatus);
  }
}

export async function testWebpack(...cmdArgs: string[]) {
  //
  // Build PouchDB with Webpack instead of Browserify, and test that.
  // We have this test because there are enough differences between
  // Webpack and Browserify to justify it.
  //

  // If this script is run _after_ bin/update-package-json-for-publish.js is run,
  // `npm run build` may fail with:
  //
  // > Error: 'default' is not exported by node_modules/inherits/inherits.js
  //
  // To avoid this, fail if this script is run in a non-clean git repo:
  const gitDiff = execSync('git diff -- package.json packages/node_modules/*/package.json', { encoding: 'utf8' });
  if (gitDiff.trim() !== '') {
    execSync('git status --untracked-files=no -- package.json packages/node_modules/*/package.json', { stdio: 'inherit' });
    console.error('!!!');
    console.error('!!! Your git working directory has changes to package.json file(s) !!!');
    console.error('!!! Please revert/stage/commit changes, and re-run the command !!!');
    console.error('!!!');
    process.exit(1);
  }

  await buildModules();
  await buildTest();
  exec('npm i webpack@5.66.0 webpack-cli@4.9.2'); // do this on-demand to avoid slow installs
  updatePackageJsonForPublish();
  exec('./node_modules/.bin/webpack');
  process.env.BUILD_NODE_DONE = '1';
  process.env.POUCHDB_SRC = '../../pouchdb-webpack.js';
  await runTest();
}

export async function verifyBuild(...cmdArgs: string[]) {
  // Verify various aspects of the build to make sure everything was
  // built correctly.

  await buildModules();
  await buildTest();
  verifyDependencies();
  verifyBundleSize();
}

export function verifyBundleSize(...cmdArgs: string[]) {
  // Max size in bytes that we find acceptable.
  // We might have to change this later.
  const MAX = 50000;

  // testing pouchdb.js instead of pouchdb.min.js because minification isn't run in Travis
  // in order to make our builds faster
  const pouchdbJsPath = path.join(process.cwd(), 'packages', 'node_modules', 'pouchdb', 'dist', 'pouchdb.js');
  const terserOutput = execSync(`./node_modules/.bin/terser -mc < "${pouchdbJsPath}"`, { encoding: 'utf8' });
  
  // Use Node.js zlib for cross-platform gzip
  const gzipOutput = zlib.gzipSync(terserOutput);
  const SIZE = gzipOutput.length;

  console.log(`Checking that pouchdb.min.js size ${SIZE} is less than ${MAX} and greater than 20`);

  if (SIZE < 21) {
    console.error('Failure');
    process.exit(1);
  } else if (SIZE < MAX) {
    console.log('Success');
  } else {
    console.error('Failure');
    process.exit(1);
  }
}

export function verifyPackageLock(...cmdArgs: string[]) {
  const lockfile = 'package-lock.json';
  const log = (msg: string) => console.log(`[verify-package-lock] ${msg}`);

  log('Pruning dependencies...');
  exec('npm prune --fund=false --audit=false');

  log(`Checking for changes to ${lockfile}...`);
  const gitStatus = execSync(`git status --porcelain -- "${lockfile}"`, { encoding: 'utf8' });
  if (gitStatus.trim() !== '') {
    execSync(`git --no-pager diff -- "${lockfile}"`, { stdio: 'inherit' });
    log('!!!');
    log(`!!! Unexpected changes to ${lockfile} found; see above`);
    log('!!!');
    process.exit(1);
  }

  log('Dependencies verified OK.');
}

export async function waitForCouch(...cmdArgs: string[]) {
  const maxWait = cmdArgs.length > 0 ? parseInt(cmdArgs[0], 10) : 0;
  const couchHost = process.env.COUCH_HOST || 'http://127.0.0.1:5984';

  process.stdout.write(`Waiting for host to start on ${couchHost}...`);

  let waiting = 0;
  while (true) {
    try {
      const url = new URL(couchHost);
      const response = await new Promise<number>((resolve, reject) => {
        const req = http.request({
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname,
          method: 'HEAD',
          timeout: 1000,
        }, (res) => {
          resolve(res.statusCode || 0);
        });
        req.on('error', reject);
        req.on('timeout', () => {
          req.destroy();
          reject(new Error('timeout'));
        });
        req.end();
      });
      
      if (response === 200) {
        break;
      }
    } catch (e) {
      // Request failed, continue waiting
    }

    waiting++;
    if (maxWait > 0 && waiting >= maxWait) {
      console.log('\nHost failed to start');
      process.exit(1);
    }
    process.stdout.write('.');
    await sleepAsync(1000);
  }

  console.log('\nHost started :)');
}

// Build test function (builds test utils and perf bundles)
async function buildTest(): Promise<void> {
  // Build test utils
  const browserifyModule = require('browserify') as any;
  const utilsSrc = path.join(process.cwd(), 'tests', 'integration', 'utils.js');
  const utilsDest = path.join(process.cwd(), 'tests', 'integration', 'utils-bundle.js');
  
  await new Promise<void>((resolve, reject) => {
    browserifyModule(utilsSrc, { debug: true }).bundle()
      .pipe(fs.createWriteStream(utilsDest))
      .on('finish', resolve)
      .on('error', reject);
  });

  // Build perf
  const perfSrc = path.join(process.cwd(), 'tests', 'performance', 'index.js');
  const perfDest = path.join(process.cwd(), 'tests', 'performance-bundle.js');
  
  await new Promise<void>((resolve, reject) => {
    browserifyModule(perfSrc, { debug: true }).bundle()
      .pipe(fs.createWriteStream(perfDest))
      .on('finish', resolve)
      .on('error', reject);
  });
}

// Verify dependencies function
function verifyDependencies(): void {
  function getReqs(thisPath: string): string[] {
    const fullPath = path.join('./packages/node_modules', thisPath);
    return findRequires(fs.readFileSync(fullPath, 'utf8'));
  }

  console.log('Verifying dependencies...');

  // pouchdb package is aggressively bundled, shouldn't
  // contain e.g. pouchdb-mapreduce
  const pouchdbIndexReqs = getReqs('pouchdb/lib/index.js');
  assert.ok(pouchdbIndexReqs.includes('vm'), 'pouchdb/lib/index.js should contain vm');
  assert.ok(!pouchdbIndexReqs.includes('pouchdb-mapreduce'), 'pouchdb/lib/index.js should not contain pouchdb-mapreduce');
  assert.ok(!pouchdbIndexReqs.includes('pouchdb'), 'pouchdb/lib/index.js should not contain pouchdb');
  assert.ok(!pouchdbIndexReqs.includes('pouchdb-core'), 'pouchdb/lib/index.js should not contain pouchdb-core');
  
  const pouchdbBrowserReqs = getReqs('pouchdb/lib/index-browser.js');
  assert.ok(!pouchdbBrowserReqs.includes('vm'), 'pouchdb/lib/index-browser.js should not contain vm');
  assert.ok(!pouchdbBrowserReqs.includes('pouchdb-mapreduce'), 'pouchdb/lib/index-browser.js should not contain pouchdb-mapreduce');
  assert.ok(!pouchdbBrowserReqs.includes('pouchdb'), 'pouchdb/lib/index-browser.js should not contain pouchdb');
  assert.ok(!pouchdbBrowserReqs.includes('leveldown'), 'pouchdb/lib/index-browser.js should not contain leveldown');
  assert.ok(!pouchdbBrowserReqs.includes('pouchdb-core'), 'pouchdb/lib/index-browser.js should not contain pouchdb-core');

  // pouchdb-node and pouchdb-browser are also aggressively bundled
  const pouchdbNodeReqs = getReqs('pouchdb-node/lib/index.js');
  assert.ok(!pouchdbNodeReqs.includes('pouchdb-core'), 'pouchdb-node/lib/index.js should not contain pouchdb-core');
  assert.ok(pouchdbNodeReqs.includes('leveldown'), 'pouchdb-node/lib/index.js should contain leveldown');
  
  const pouchdbBrowserPkgReqs = getReqs('pouchdb-browser/lib/index.js');
  assert.ok(!pouchdbBrowserPkgReqs.includes('pouchdb-core'), 'pouchdb-browser/lib/index.js should not contain pouchdb-core');

  // pouchdb-for-coverage is super-duper aggressively bundled
  const pouchdbForCoverageReqs = getReqs('pouchdb-for-coverage/lib/index.js');
  assert.ok(!pouchdbForCoverageReqs.includes('pouchdb'), 'pouchdb-for-coverage/lib/index.js should not contain pouchdb');
  assert.ok(!pouchdbForCoverageReqs.includes('pouchdb-core'), 'pouchdb-for-coverage/lib/index.js should not contain pouchdb-core');
  assert.ok(!pouchdbForCoverageReqs.includes('pouchdb-utils'), 'pouchdb-for-coverage/lib/index.js should not contain pouchdb-utils');

  console.log('Dependencies look good!');
}

// Update package.json for publish function
function updatePackageJsonForPublish(): void {
  const topPkg = JSON.parse(fs.readFileSync('./package.json', 'utf8'));
  const modules = fs.readdirSync('./packages/node_modules');

  modules.forEach((mod) => {
    const pkgDir = path.join('./packages/node_modules', mod);
    const pkgPath = path.join(pkgDir, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

    // for the dependencies, find all require() calls
    const srcFiles = glob.sync(path.join(pkgDir, 'lib/**/*.js'));
    const uniqDeps = uniq(srcFiles.map((srcFile: string) => {
      const code = fs.readFileSync(srcFile, 'utf8');
      try {
        return findRequires(code);
      } catch (e) {
        return []; // happens if this is an es6 module, parsing fails
      }
    }).flat()).filter((dep: string) => {
      // some modules require() themselves, e.g. for plugins
      return dep !== pkg.name &&
        // exclude built-ins like 'inherits', 'fs', etc.
        builtInModules.indexOf(dep) === -1;
    }).sort();

    const deps: Record<string, string> = {};
    uniqDeps.forEach((dep: string) => {
      if (topPkg.dependencies && topPkg.dependencies[dep]) {
        deps[dep] = topPkg.dependencies[dep];
      } else if (modules.indexOf(dep) !== -1) { // core pouchdb-* module
        deps[dep] = topPkg.version;
      } else {
        throw new Error('Unknown dependency ' + dep);
      }
    });
    pkg.dependencies = deps;

    // add "browser" switches for both CJS and ES modules
    if (pkg.browser) {
      pkg.browser = {
        './lib/index.js': './lib/index-browser.js',
        './lib/index.es.js': './lib/index-browser.es.js',
      };
    }
    // Update "module" to point to `lib/` rather than `src/`.
    // `src/` is only used for building, not publishing.
    // Also add "module" member: https://github.com/rollup/rollup/wiki/pkg.module
    pkg.module = './lib/index.es.js';
    // whitelist the files we'll actually publish
    pkg.files = ['lib', 'dist'];

    const jsonString = JSON.stringify(pkg, null, '  ') + '\n';
    fs.writeFileSync(pkgPath, jsonString, 'utf8');
  });
}

// Set version function
export function setVersion(...cmdArgs: string[]) {
  const version = cmdArgs[cmdArgs.length - 1] || process.argv[process.argv.length - 1];
  if (!version || version.startsWith('-')) {
    console.error('Usage: setVersion <version>');
    process.exit(1);
  }

  const packages = fs.readdirSync('packages/node_modules');

  const jsonFiles = packages.map((pkg: string) => {
    return path.resolve(process.cwd(), 'packages/node_modules', pkg, 'package.json');
  }).concat([
    path.resolve(process.cwd(), 'packages/node_modules/pouchdb/component.json'),
    path.resolve(process.cwd(), 'packages/node_modules/pouchdb/bower.json'),
    path.resolve(process.cwd(), 'package.json'),
  ]);

  jsonFiles.forEach((jsonFile: string) => {
    const json = JSON.parse(fs.readFileSync(jsonFile, 'utf-8'));
    json.version = version;
    fs.writeFileSync(jsonFile, JSON.stringify(json, null, '  ') + '\n', 'utf-8');
  });

  const versionFile = path.resolve(process.cwd(),
    'packages/node_modules/pouchdb-core/src/version.js');
  const versionFileContents = '// managed automatically by set-version.js\n' +
    `export default "${version}";\n`;

  fs.writeFileSync(versionFile, versionFileContents, 'utf-8');

  console.log('done');
}

// Down server function (simple HTTP server that returns 500)
export function downServer(...cmdArgs: string[]) {
  const httpModule = require('http') as typeof import('http');
  const port = cmdArgs[0] || process.argv[2] || '3010';

  const server = httpModule.createServer((request: any, response: any) => {
    response.writeHead(500, { 'Content-Type': 'application/json' });
    response.end('{}');
  });

  server.listen(port, () => {
    console.log(`Down server listening on port ${port}`);
  });
}

// Internal dev server function
function startDevServer(callback?: () => void | Promise<void>): void {
  const watch = require('glob-watcher') as any;
  const http_server = require('http-server') as any;
  const browserify = require('browserify') as any;

  const queryParams: Record<string, any> = {};

  if (process.env.ADAPTERS) {
    queryParams.adapters = process.env.ADAPTERS;
  }
  if (process.env.VIEW_ADAPTERS) {
    queryParams.viewAdapters = process.env.VIEW_ADAPTERS;
  }
  if (process.env.AUTO_COMPACTION) {
    queryParams.autoCompaction = true;
  }
  if (process.env.POUCHDB_SRC) {
    queryParams.src = process.env.POUCHDB_SRC;
  }
  if (process.env.PLUGINS) {
    queryParams.plugins = process.env.PLUGINS;
  }
  if (process.env.COUCH_HOST) {
    queryParams.couchHost = process.env.COUCH_HOST;
  }
  if (process.env.ITERATIONS) {
    queryParams.iterations = process.env.ITERATIONS;
  }
  if (process.env.SRC_ROOT) {
    queryParams.srcRoot = process.env.SRC_ROOT;
  }
  if (process.env.USE_MINIFIED) {
    queryParams.useMinified = process.env.USE_MINIFIED;
  }

  let rebuildPromise = Promise.resolve();

  function rebuildPouch() {
    rebuildPromise = rebuildPromise.then(() => buildPouchDB()).then(() => {
      console.log('Rebuilt packages/node_modules/pouchdb');
    }).catch(console.error);
    return rebuildPromise;
  }

  function browserifyPromise(src: string, dest: string) {
    return new Promise<void>((resolve, reject) => {
      browserify(src, { debug: true }).bundle().pipe(fs.createWriteStream(dest))
        .on('finish', resolve)
        .on('error', reject);
    });
  }

  function rebuildTestUtils() {
    rebuildPromise = rebuildPromise.then(() => {
      return browserifyPromise('tests/integration/utils.js',
        'tests/integration/utils-bundle.js');
    }).then(() => {
      console.log('Rebuilt tests/integration/utils-bundle.js');
    }).catch(console.error);
    return rebuildPromise;
  }

  function rebuildPerf() {
    rebuildPromise = rebuildPromise.then(() => {
      return browserifyPromise('tests/performance/index.js',
        'tests/performance-bundle.js');
    }).then(() => {
      console.log('Rebuilt tests/performance-bundle.js');
    }).catch(console.error);
    return rebuildPromise;
  }

  function watchAll() {
    watch(['packages/node_modules/*/src/**/*.js'],
      debounce(rebuildPouch, 700, { leading: true }));
    watch(['tests/integration/utils.js'],
      debounce(rebuildTestUtils, 700, { leading: true }));
    watch(['tests/performance/**/*.js'],
      debounce(rebuildPerf, 700, { leading: true }));
  }

  const HTTP_PORT = 8000;

  let serversStarted: boolean | undefined;
  let readyCallback: (() => void) | undefined;

  function startServers(cb?: () => void) {
    readyCallback = cb;
    http_server.createServer().listen(HTTP_PORT, () => {
      const testRoot = `http://127.0.0.1:${HTTP_PORT}`;
      const query = new URLSearchParams(queryParams);
      console.log(`Integration  tests: ${testRoot}/tests/integration/?${query}`);
      console.log(`Map/reduce   tests: ${testRoot}/tests/mapreduce/?${query}`);
      console.log(`pouchdb-find tests: ${testRoot}/tests/find/?${query}`);
      console.log(`Performance  tests: ${testRoot}/tests/performance/?${query}`);
      serversStarted = true;
      checkReady();
    });
  }

  function checkReady() {
    if (serversStarted && readyCallback) {
      readyCallback();
    }
  }

  startServers(callback);
  watchAll();
}

// Dev server function (exported for CLI)
export function devServer(...cmdArgs: string[]): void {
  startDevServer();
}

// Test browser function
export async function testBrowser(...cmdArgs: string[]) {
  const MochaSpecReporter = mocha.reporters.Spec;
  const createMochaStatsCollector = require('mocha/lib/stats-collector');

  // BAIL=0 to disable bailing
  const bail = process.env.BAIL !== '0';

  // Track if the browser has closed at the request of this script, or due to an external event.
  let closeRequested: boolean | undefined;

  // Playwright BrowserType whitelist.
  const SUPPORTED_BROWSERS = ['chromium', 'firefox', 'webkit'];
  const browserName = process.env.CLIENT || 'firefox';
  if (!SUPPORTED_BROWSERS.includes(browserName)) {
    console.log(`
    !!! Requested browser not supported: '${browserName}'.
    !!! Available browsers: ${SUPPORTED_BROWSERS.map((b: string) => `'${b}'`).join(', ')}
  `);
    process.exit(1);
  }

  let testRoot = 'http://127.0.0.1:8000/tests/';
  let testUrl: string;
  if (process.env.TYPE === 'performance') {
    testUrl = testRoot + 'performance/index.html';
  } else if (process.env.TYPE === 'fuzzy') {
    testUrl = testRoot + 'fuzzy/index.html';
  } else if (process.env.TYPE === 'mapreduce') {
    testUrl = testRoot + 'mapreduce/index.html';
  } else if (process.env.TYPE === 'find') {
    testUrl = testRoot + 'find/index.html';
  } else {
    testUrl = testRoot + 'integration/index.html';
  }

  const qs: Record<string, any> = {
    remote: 1,
    invert: process.env.INVERT,
    grep: process.env.GREP,
    adapters: process.env.ADAPTERS,
    viewAdapters: process.env.VIEW_ADAPTERS,
    autoCompaction: process.env.AUTO_COMPACTION,
    SERVER: process.env.SERVER,
    SKIP_MIGRATION: process.env.SKIP_MIGRATION,
    srcRoot: process.env.SRC_ROOT,
    src: process.env.POUCHDB_SRC,
    useMinified: process.env.USE_MINIFIED,
    plugins: process.env.PLUGINS,
    couchHost: process.env.COUCH_HOST,
    iterations: process.env.ITERATIONS,
  };

  testUrl += '?';
  testUrl += new URLSearchParams(pickBy(qs, identity));

  let stackConsumer: any;

  class ArrayMap extends Map {
    get(key: any) {
      if (!this.has(key)) {
        this.set(key, []);
      }
      return super.get(key);
    }
  }

  class RemoteRunner {
    failed: boolean;
    browser: any;
    handlers: ArrayMap;
    onceHandlers: ArrayMap;

    constructor(browser: any) {
      this.failed = false;
      this.browser = browser;
      this.handlers = new ArrayMap();
      this.onceHandlers = new ArrayMap();
      (this as any).handleEvent = (this as any).handleEvent.bind(this);
      (createMochaStatsCollector as any)(this);
    }

    once(name: string, handler: any) {
      this.onceHandlers.get(name).push(handler);
    }

    on(name: string, handler: any) {
      this.handlers.get(name).push(handler);
    }

    triggerHandlers(eventName: string, handlerArgs: any[]) {
      const triggerHandler = (handler: any) => handler.apply(null, handlerArgs);

      this.onceHandlers.get(eventName).forEach(triggerHandler);
      this.onceHandlers.delete(eventName);

      this.handlers.get(eventName).forEach(triggerHandler);
    }

    async handleEvent(event: any) {
      try {
        const additionalProps = ['pass', 'fail', 'pending'].indexOf(event.name) === -1 ? {} : {
          slow: event.obj.slow ? () => event.obj.slow : () => 60,
          fullTitle: event.obj.fullTitle ? () => event.obj.fullTitle : undefined,
          titlePath: event.obj.titlePath ? () => event.obj.titlePath : undefined,
        };
        const obj = Object.assign({}, event.obj, additionalProps);

        this.triggerHandlers(event.name, [obj, event.err]);

        if (event.err && stackConsumer) {
          let stackMapped: boolean | undefined;
          const mappedStack = stacktraceParser
            .parse(event.err.stack)
            .map((v: any) => {
              if (v.file === 'http://127.0.0.1:8000/packages/node_modules/pouchdb/dist/pouchdb.min.js') {
                const NON_UGLIFIED_HEADER_LENGTH = 6; // number of lines of header added in build-pouchdb.js
                const target = { line: v.lineNumber - NON_UGLIFIED_HEADER_LENGTH, column: v.column - 1 };
                const mapped = stackConsumer.originalPositionFor(target);
                v.file = 'packages/node_modules/pouchdb/dist/pouchdb.js';
                v.lineNumber = mapped.line;
                v.column = mapped.column + 1;
                if (mapped.name !== null) {
                  v.methodName = mapped.name;
                }
                stackMapped = true;
              }
              return v;
            })
            .map((v: any) => `at ${v.methodName} (${v.file}:${v.lineNumber}:${v.column})`)
            .join('\n          ');
          if (stackMapped) {
            console.log(`      [${obj.title}] Minified error stacktrace mapped to:`);
            console.log(`        ${event.err.name || 'Error'}: ${event.err.message}`);
            console.log(`          ${mappedStack}`);
          }
        }

        switch (event.name) {
          case 'fail': this.handleFailed(); break;
          case 'end': this.handleEnd(); break;
        }
      } catch (e) {
        console.error('Tests failed:', e);

        closeRequested = true;
        await this.browser.close();
        process.exit(3);
      }
    }

    async handleEnd() {
      closeRequested = true;
      await this.browser.close();
      process.exit(this.failed ? 1 : 0);
    }

    handleFailed() {
      this.failed = true;
      if (bail) {
        try {
          this.triggerHandlers('end', []);
        } catch (e) {
          console.log('An error occurred while bailing:', e);
        } finally {
          this.handleEnd();
        }
      }
    }
  }

  function BenchmarkConsoleReporter(runner: any) {
    runner.on('benchmark:result', (obj: any) => {
      console.log('      ', obj);
    });
  }

  function BenchmarkJsonReporter(runner: any) {
    runner.on('end', (results: any) => {
      if (runner.failed) {
        console.log('Runner failed; JSON will not be writted.');
      } else {
        results.srcRoot = process.env.SRC_ROOT;

        const resultsDir = 'perf-test-results';
        fs.mkdirSync(resultsDir, { recursive: true });

        const jsonPath = `${resultsDir}/${new Date().toISOString()}.json`;
        fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));
        console.log('Wrote JSON results to:', jsonPath);
      }
    });
  }

  async function startTest() {
    if (qs.src === '../../packages/node_modules/pouchdb/dist/pouchdb.min.js') {
      const mapPath = './packages/node_modules/pouchdb/dist/pouchdb.min.js.map';
      const rawMap = fs.readFileSync(mapPath, { encoding: 'utf8' });
      const jsonMap = JSON.parse(rawMap);
      stackConsumer = await new sourceMap.SourceMapConsumer(jsonMap);
    }

    try {
      console.log('Starting', browserName, 'on', testUrl);

      const options = {
        headless: true,
      };
      const browser = await playwright[browserName].launch(options);

      const runner = new RemoteRunner(browser);
      new MochaSpecReporter(runner as any);
      new BenchmarkConsoleReporter(runner);

      if (process.env.JSON_REPORTER) {
        if (process.env.TYPE !== 'performance') {
          console.log('!!! JSON_REPORTER should only be set if TYPE is set to "performance".');
          process.exit(1);
        }
        new BenchmarkJsonReporter(runner);
      }

      // Workaround: create a BrowserContext to handle init scripts.
      const ctx = await browser.newContext();

      ctx.on('close', () => {
        if (!closeRequested) {
          console.log('!!! Browser closed by external event.');
          process.exit(1);
        }
      });

      ctx.exposeFunction('handleMochaEvent', runner.handleEvent);
      ctx.addInitScript(`() => {
        window.addEventListener('message', (e) => {
          if (e.data.type === 'mocha') {
            window.handleMochaEvent(e.data.details);
          }
        });
      }`);

      ctx.on('pageerror', (err: any) => {
        if (browserName === 'webkit' && err.toString()
          .match(/^Fetch API cannot load http.* due to access control checks.$/)) {
          console.log('Ignoring error:', err);
          return;
        }

        console.log('Unhandled error in test page:', err);
        console.log('  stack:', err.stack);
        console.log('  cause:', err.cause);
        process.exit(1);
      });

      ctx.on('console', (message: any) => {
        console.log(message.text());
      });

      const page = await ctx.newPage();
      await page.goto(testUrl);

      const userAgent = await page.evaluate('navigator.userAgent');
      console.log('Testing on:', userAgent);
    } catch (err) {
      console.log('Error starting tests:', err);
      process.exit(1);
    }
  }

  if (process.env.MANUAL_DEV_SERVER) {
    await startTest();
  } else {
    // dev-server.js rebuilds bundles when required
    startDevServer(startTest);
  }
}

// CLI interface
const isMainModule = typeof require !== 'undefined' && (require as any).main === module;
if (isMainModule) {
  const scriptName = process.argv[2];
  const args = process.argv.slice(3);

  const functionMap: Record<string, (...args: string[]) => void | Promise<void>> = {
    'buildNode': buildNode,
    'installJekyll': installJekyll,
    'publishPackages': publishPackages,
    'publishSite': publishSite,
    'release': release,
    'repeatPerfTest': repeatPerfTest,
    'runDev': runDev,
    'runTest': runTest,
    'testCoverage': testCoverage,
    'testNode': testNode,
    'testWebpack': testWebpack,
    'verifyBuild': verifyBuild,
    'verifyBundleSize': verifyBundleSize,
    'verifyPackageLock': verifyPackageLock,
    'waitForCouch': waitForCouch,
    'setVersion': setVersion,
    'downServer': downServer,
    'devServer': devServer,
    'testBrowser': testBrowser,
    'buildModules': buildModules,
    'buildSite': buildSite,
  };

  const func = functionMap[scriptName];
  if (!func) {
    console.error(`Unknown script: ${scriptName}`);
    console.error(`Available scripts: ${Object.keys(functionMap).join(', ')}`);
    process.exit(1);
  }

  // Execute the function and handle async functions
  const result = func(...args);
  if (result instanceof Promise) {
    result.catch((error) => {
      console.error(error);
      process.exit(1);
    });
  }
}
