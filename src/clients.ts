/**
 * Builds the two MAPI clients (dev read, prod write) and, in debug mode, wraps
 * each in a transparent instrumentation Proxy that logs every call
 * (resource.method, space id, key args — never token values — plus HTTP status
 * and duration). When debug is off the wrapper early-returns the bare client so
 * it adds no overhead.
 */
import { createManagementApiClient } from '@storyblok/management-api-client';
import type { Config } from './config';
import type { Logger } from './logger';
import type { SyncClient } from './types';

/** The regions the MAPI client accepts; `config.region` is validated against this. */
type Region = 'eu' | 'us' | 'ca' | 'ap' | 'cn';

const RESOURCE_KEYS = [
  'stories',
  'components',
  'componentFolders',
  'presets',
  'internalTags',
  'assets',
  'assetFolders',
] as const;

const truncate = (value: string, max = 40): string => (value.length > max ? `${value.slice(0, max)}…` : value);

/** Summarises a single call argument without ever touching token/secret values. */
function summarizeArg(arg: unknown): string {
  if (arg == null) { return String(arg); }
  if (typeof arg === 'number' || typeof arg === 'string') { return String(arg); }
  if (typeof arg === 'object') {
    const a = arg as Record<string, any>;
    const parts: string[] = [];
    if (a.query?.page != null) { parts.push(`page=${a.query.page}`); }
    if (a.query?.search != null) { parts.push(`search=${truncate(String(a.query.search))}`); }
    if (a.query?.by_slugs != null) { parts.push(`by_slugs=${truncate(String(a.query.by_slugs))}`); }
    if (a.query?.by_ids != null) { parts.push(`by_ids=${truncate(String(a.query.by_ids))}`); }
    if (a.query?.reference_search != null) { parts.push(`reference_search=${truncate(String(a.query.reference_search))}`); }
    if (a.body && typeof a.body === 'object') { parts.push(`body={${Object.keys(a.body).join(',')}}`); }
    if (a.file != null) { parts.push('file=<binary>'); }
    return parts.length > 0 ? `{${parts.join(' ')}}` : '{…}';
  }
  return '';
}

const summarizeArgs = (args: unknown[]): string => args.map(summarizeArg).join(', ');

function instrumentResource<T extends object>(
  resourceName: string,
  resource: T,
  spaceId: number,
  logger: Logger,
): T {
  return new Proxy(resource, {
    get(target, prop, receiver) {
      const original = Reflect.get(target, prop, receiver);
      if (typeof original !== 'function') {
        return original;
      }
      return async (...args: unknown[]) => {
        const start = performance.now();
        const argSummary = summarizeArgs(args);
        try {
          const result = await original.apply(target, args);
          const status = (result as { response?: { status?: number } })?.response?.status;
          logger.debug(
            `MAPI ${resourceName}.${String(prop)}(${argSummary}) space=${spaceId} → ${status ?? 'ok'} (${Math.round(performance.now() - start)}ms)`,
          );
          return result;
        }
        catch (error) {
          logger.debug(
            `MAPI ${resourceName}.${String(prop)}(${argSummary}) space=${spaceId} → threw (${Math.round(performance.now() - start)}ms)`,
          );
          throw error;
        }
      };
    },
  });
}

/**
 * Wraps a client's resource objects in instrumentation Proxies. Returns the
 * bare client unchanged when debug logging is off.
 */
export function createInstrumentedClient(client: SyncClient, spaceId: number, logger: Logger): SyncClient {
  if (!logger.isDebug) {
    return client;
  }
  const wrapped = {} as Record<string, unknown>;
  for (const key of RESOURCE_KEYS) {
    const resource = (client as Record<string, unknown>)[key];
    wrapped[key] = resource && typeof resource === 'object'
      ? instrumentResource(key, resource, spaceId, logger)
      : resource;
  }
  return wrapped as unknown as SyncClient;
}

export interface Clients {
  dev: SyncClient;
  prod: SyncClient;
}

/** Creates the dev + prod clients, instrumented when debug is on. */
export function createClients(config: Config, logger: Logger): Clients {
  const dev = createManagementApiClient({
    personalAccessToken: config.devToken,
    spaceId: config.devSpaceId,
    region: config.region as Region,
  });
  const prod = createManagementApiClient({
    personalAccessToken: config.prodToken,
    spaceId: config.prodSpaceId,
    region: config.region as Region,
  });

  return {
    dev: createInstrumentedClient(dev, config.devSpaceId, logger),
    prod: createInstrumentedClient(prod, config.prodSpaceId, logger),
  };
}
