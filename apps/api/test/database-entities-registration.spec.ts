import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const apiRoot = join(__dirname, '..');
// Every directory that declares TypeORM entities. A directory that is scanned
// here but missing from DATABASE_ENTITIES fails the first test below, so a new
// entity home must be added here in the same change that introduces it.
const entityDirs = [
  join(apiRoot, 'src', 'deadlock-live', 'entities'),
  join(apiRoot, 'src', 'match-history', 'entities'),
];

/**
 * `DATABASE_ENTITIES` is what the standalone `AppDataSource` knows about, and
 * it is the list that migrations and the `src/scripts/*` tools use directly.
 * An entity reachable only through a module's `TypeOrmModule.forFeature` looks
 * perfectly healthy inside the running app while being invisible to those
 * scripts, which fail at runtime with `EntityMetadataNotFoundError`.
 *
 * That is not hypothetical: `adaptive_feedback_v1` was in exactly that state
 * until the match-deletion tool tried to count it.
 */
function registeredEntityNames(): string[] {
  const source = readFileSync(join(apiRoot, 'src', 'database', 'database-entities.ts'), 'utf8');
  const body = source.slice(source.indexOf('export const DATABASE_ENTITIES'));
  const withoutComments = body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

  return [...withoutComments.matchAll(/^\s*([A-Za-z_$][\w$]*),/gm)].map((match) => match[1]);
}

function declaredEntityNames(): string[] {
  return entityDirs
    .flatMap((entitiesDir) =>
      readdirSync(entitiesDir)
        .filter((name) => name.endsWith('.entity.ts'))
        .map((name) => {
          const source = readFileSync(join(entitiesDir, name), 'utf8');
          const match = source.match(/export class ([A-Za-z_$][\w$]*)/);
          if (!match) {
            throw new Error(`${name} declares no exported entity class`);
          }
          return match[1];
        }),
    )
    .sort();
}

describe('DATABASE_ENTITIES registration', () => {
  it('registers every entity class declared under entities/', () => {
    const registered = new Set(registeredEntityNames());
    const missing = declaredEntityNames().filter((name) => !registered.has(name));

    expect(missing).toEqual([]);
  });

  it('lists no entity that does not exist', () => {
    const declared = new Set(declaredEntityNames());
    const stale = registeredEntityNames().filter((name) => !declared.has(name));

    expect(stale).toEqual([]);
  });

  it('parses the registration list rather than silently matching nothing', () => {
    // Without this, a parser regression would turn both assertions above into
    // vacuous passes.
    expect(registeredEntityNames().length).toBeGreaterThan(10);
    expect(declaredEntityNames().length).toBeGreaterThan(10);
  });
});
