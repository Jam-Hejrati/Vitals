import { describe, expect, it } from 'vitest';
import { LockfileError, findDependencyPaths, parseNpmLockfile } from '../src/index.js';

const lock = (packages: Record<string, object>) =>
  JSON.stringify({ name: 'app', version: '1.0.0', lockfileVersion: 3, packages });

describe('parseNpmLockfile', () => {
  const graph = parseNpmLockfile(
    lock({
      '': {
        name: 'app',
        version: '1.0.0',
        dependencies: { express: '^4.0.0', '@scope/util': '^2.0.0' },
        devDependencies: { vitest: '^1.0.0' },
      },
      'node_modules/express': { version: '4.18.0', dependencies: { debug: '2.6.9', ms: '^2.0.0' } },
      'node_modules/express/node_modules/debug': {
        version: '2.6.9',
        dependencies: { ms: '2.0.0' },
      },
      'node_modules/express/node_modules/debug/node_modules/ms': { version: '2.0.0' },
      'node_modules/ms': { version: '2.1.3' },
      'node_modules/debug': { version: '4.3.4', dependencies: { ms: '2.1.3' } },
      'node_modules/@scope/util': { version: '2.1.0', dependencies: { debug: '^4.0.0' } },
      'node_modules/vitest': { version: '1.6.0', dev: true, dependencies: { debug: '^4.0.0' } },
    }),
  );

  it('reads the root package', () => {
    expect(graph.root).toEqual({ name: 'app', version: '1.0.0' });
  });

  it('lists direct dependencies with their type', () => {
    expect(graph.directDependencies).toEqual([
      { id: 'express@4.18.0', type: 'prod' },
      { id: '@scope/util@2.1.0', type: 'prod' },
      { id: 'vitest@1.6.0', type: 'dev' },
    ]);
  });

  it('resolves nested installs before hoisted ones', () => {
    expect(graph.packages.get('express@4.18.0')?.dependencies).toEqual(['debug@2.6.9', 'ms@2.1.3']);
    expect(graph.packages.get('debug@2.6.9')?.dependencies).toEqual(['ms@2.0.0']);
    expect(graph.packages.get('@scope/util@2.1.0')?.dependencies).toEqual(['debug@4.3.4']);
  });

  it('keeps every installed version as its own package', () => {
    expect([...graph.packages.keys()].sort()).toEqual([
      '@scope/util@2.1.0',
      'debug@2.6.9',
      'debug@4.3.4',
      'express@4.18.0',
      'ms@2.0.0',
      'ms@2.1.3',
      'vitest@1.6.0',
    ]);
  });

  it('carries dev flags', () => {
    expect(graph.packages.get('vitest@1.6.0')?.dev).toBe(true);
    expect(graph.packages.get('express@4.18.0')?.dev).toBe(false);
  });

  it('merges dev flags across copies of the same version', () => {
    const merged = parseNpmLockfile(
      lock({
        '': { dependencies: { a: '1' }, devDependencies: { b: '1' } },
        'node_modules/a': { version: '1.0.0', dependencies: { shared: '1' } },
        'node_modules/a/node_modules/shared': { version: '1.0.0' },
        'node_modules/b': { version: '1.0.0', dev: true, dependencies: { shared: '1' } },
        'node_modules/b/node_modules/shared': { version: '1.0.0', dev: true },
      }),
    );
    expect(merged.packages.get('shared@1.0.0')?.dev).toBe(false);
  });

  it('follows workspace links', () => {
    const workspace = parseNpmLockfile(
      lock({
        '': { workspaces: ['packages/*'], dependencies: { lib: '*' } },
        'node_modules/lib': { resolved: 'packages/lib', link: true },
        'packages/lib': { name: 'lib', version: '0.1.0', dependencies: { left: '1' } },
        'node_modules/left': { version: '1.0.0' },
      }),
    );
    expect(workspace.directDependencies).toEqual([{ id: 'lib@0.1.0', type: 'prod' }]);
    expect(workspace.packages.get('lib@0.1.0')?.dependencies).toEqual(['left@1.0.0']);
  });

  it('ignores optional dependencies that are not installed', () => {
    const optional = parseNpmLockfile(
      lock({
        '': { dependencies: { a: '1' } },
        'node_modules/a': { version: '1.0.0', optionalDependencies: { fsevents: '2' } },
      }),
    );
    expect(optional.packages.get('a@1.0.0')?.dependencies).toEqual([]);
  });

  it('rejects lockfileVersion 1', () => {
    const v1 = JSON.stringify({ lockfileVersion: 1, dependencies: {} });
    expect(() => parseNpmLockfile(v1)).toThrow(LockfileError);
  });

  it('rejects invalid JSON', () => {
    expect(() => parseNpmLockfile('{')).toThrow(LockfileError);
  });
});

describe('findDependencyPaths', () => {
  const graph = parseNpmLockfile(
    lock({
      '': { dependencies: { a: '1', b: '1' }, devDependencies: { c: '1' } },
      'node_modules/a': { version: '1.0.0', dependencies: { x: '1' } },
      'node_modules/b': { version: '1.0.0', dependencies: { y: '1' } },
      'node_modules/c': { version: '1.0.0' },
      'node_modules/x': { version: '1.0.0', dependencies: { y: '1' } },
      'node_modules/y': { version: '1.0.0', dependencies: { target: '1', x: '1' } },
      'node_modules/target': { version: '1.0.0' },
    }),
  );

  it('returns the shortest chain per direct dependency, shortest first', () => {
    expect(findDependencyPaths(graph, 'target@1.0.0')).toEqual([
      ['b@1.0.0', 'y@1.0.0', 'target@1.0.0'],
      ['a@1.0.0', 'x@1.0.0', 'y@1.0.0', 'target@1.0.0'],
    ]);
  });

  it('returns the package itself when it is a direct dependency', () => {
    expect(findDependencyPaths(graph, 'c@1.0.0')).toEqual([['c@1.0.0']]);
  });

  it('returns nothing for unknown packages', () => {
    expect(findDependencyPaths(graph, 'nope@1.0.0')).toEqual([]);
  });
});
