#!/usr/bin/env node
import * as fs from 'node:fs';
import path from 'node:path';
import {
  DAY, exists, assertPlainPath, localDate, validDate, git, freeSpace, parseLock, loadConfig, inside, isMain
} from './lib.mjs';

function parseArgs(args) {
  const values = {};
  const flags = new Set(['--no-public', '--no-node-modules']);
  const valued = new Set(['--repo', '--path', '--branch', '--new-branch', '--base', '--owner', '--purpose', '--until',
    '--node-modules']);
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i];
    if (Object.hasOwn(values, key)) throw Error(`duplicate argument: ${key}`);
    if (flags.has(key)) values[key] = true;
    else if (valued.has(key) && args[i + 1] && !args[i + 1].startsWith('--')) values[key] = args[++i];
    else throw Error(`unknown or incomplete argument: ${key}`);
  }
  for (const key of ['--repo', '--path', '--owner', '--purpose', '--until']) {
    if (!values[key]) throw Error(`required: ${key}`);
  }
  if (Boolean(values['--branch']) === Boolean(values['--new-branch'])) {
    throw Error('specify exactly one of --branch or --new-branch');
  }
  if (Boolean(values['--new-branch']) !== Boolean(values['--base'])) throw Error('--new-branch requires --base');
  if (values['--node-modules'] && values['--no-node-modules']) throw Error('conflicting node_modules options');
  return values;
}

function createWorktree(values) {
  const until = values['--until'];
  const today = localDate();
  if (!validDate(until) || until <= today) throw Error('--until must be a valid date in the future');
  if ((Date.parse(until) - Date.parse(today)) / DAY > 30) throw Error('--until must be at most 30 days ahead');
  const repo = path.resolve(values['--repo']);
  const target = path.resolve(values['--path']);
  assertPlainPath(repo);
  if (exists(target)) throw Error(`target already exists: ${target}`);
  let parent = path.dirname(target);
  while (!exists(parent)) parent = path.dirname(parent);
  assertPlainPath(parent);
  const config = loadConfig();
  if (inside(target, config.sources) || inside(config.sources, target)) throw Error('sources path protected');
  const space = freeSpace(target);
  if (space.freeGB < 10) throw Error(`insufficient free space on ${space.drive}: ${space.freeGB.toFixed(1)} GB (< 10 GB)`);
  const owner = values['--owner'].trim();
  const purpose = values['--purpose'].trim();
  if (/[;\r\n\0]/.test(owner + purpose)) throw Error('owner and purpose must not contain semicolons or line breaks');
  const reason = `owner=${owner}; purpose=${purpose}; until=${until}`;
  if (!parseLock(reason)) throw Error('invalid registration fields');
  let modules;
  if (values['--node-modules']) {
    modules = fs.realpathSync(path.resolve(values['--node-modules']));
    if (!fs.statSync(modules).isDirectory()) throw Error('--node-modules target must be a directory');
  }
  const args = ['worktree', 'add'];
  if (values['--no-public']) args.push('--no-checkout');
  if (values['--new-branch']) args.push('-b', values['--new-branch']);
  args.push('--', target, values['--branch'] || values['--base']);
  git(repo, args);
  // Register immediately so a failed checkout or symlink creation cannot leave an anonymous worktree.
  try {
    git(repo, ['worktree', 'lock', '--reason', reason, '--', target]);
    if (values['--no-public']) {
      git(target, ['sparse-checkout', 'set', '--no-cone', '/*', '!/public/']);
      git(target, ['checkout']);
    }
    if (!values['--no-node-modules']) {
      if (!modules) {
        const sourceLock = path.join(repo, 'package-lock.json');
        const targetLock = path.join(target, 'package-lock.json');
        if (exists(sourceLock) && exists(targetLock) &&
            fs.readFileSync(sourceLock).equals(fs.readFileSync(targetLock))) {
          const source = path.join(repo, 'node_modules');
          if (exists(source) && fs.statSync(source).isDirectory()) modules = fs.realpathSync(source);
        }
        if (!modules) process.stdout.write('No shared node_modules: npm ci is needed.\n');
      }
      if (modules) fs.symlinkSync(modules, path.join(target, 'node_modules'), 'dir');
    }
  } catch (error) {
    throw Error(`${error.message}\nWorktree retained at ${target}; inspect its registration before removal.`);
  }
  process.stdout.write(`${target}\n${reason}\n`);
}

if (isMain(import.meta.url)) {
  try { createWorktree(parseArgs(process.argv.slice(2))); }
  catch (error) { process.stderr.write(`wt-new: ${error.message}\n`); process.exitCode = 1; }
}
