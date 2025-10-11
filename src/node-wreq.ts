import type { RequestOptions, Response, BrowserProfile } from './types';
import { RequestError } from './types';

let nativeBinding: {
  request: (options: RequestOptions) => Promise<Response>;
  getProfiles: () => string[];
};

try {
  nativeBinding = require('../rust/index.node');
} catch (error) {
  throw new Error(
    `Failed to load native module: ${error}. ` +
      `Make sure the package is installed correctly and the native module is built for your platform (${process.platform}-${process.arch}).`
  );
}

/**
 * Make an HTTP request with browser impersonation
 *
 * @param options - Request options
 * @returns Promise that resolves to the response
 *
 * @example
 * ```typescript
 * import { request } from 'node-wreq';
 *
 * const response = await request({
 *   url: 'https://example.com/api',
 *   browser: 'chrome_137',
 *   headers: {
 *     'Custom-Header': 'value'
 *   }
 * });
 *
 * console.log(response.status); // 200
 * console.log(response.body);   // Response body
 * ```
 */
export async function request(options: RequestOptions): Promise<Response> {
  if (!options.url) {
    throw new RequestError('URL is required');
  }

  if (options.browser) {
    const profiles = getProfiles();
    if (!profiles.includes(options.browser)) {
      throw new RequestError(
        `Invalid browser profile: ${options.browser}. Available profiles: ${profiles.join(', ')}`
      );
    }
  }

  try {
    return await nativeBinding.request(options);
  } catch (error) {
    throw new RequestError(`Request failed: ${error}`);
  }
}

/**
 * Get list of available browser profiles
 *
 * @returns Array of browser profile names
 *
 * @example
 * ```typescript
 * import { getProfiles } from 'node-wreq';
 *
 * const profiles = getProfiles();
 * console.log(profiles); // ['chrome_120', 'chrome_131', 'firefox', ...]
 * ```
 */
export function getProfiles(): BrowserProfile[] {
  return nativeBinding.getProfiles() as BrowserProfile[];
}

/**
 * Convenience function for GET requests
 *
 * @param url - URL to request
 * @param options - Additional request options
 * @returns Promise that resolves to the response
 *
 * @example
 * ```typescript
 * import { get } from 'node-wreq';
 *
 * const response = await get('https://example.com/api');
 * ```
 */
export async function get(
  url: string,
  options?: Omit<RequestOptions, 'url' | 'method'>
): Promise<Response> {
  return request({ ...options, url, method: 'GET' });
}

/**
 * Convenience function for POST requests
 *
 * @param url - URL to request
 * @param body - Request body
 * @param options - Additional request options
 * @returns Promise that resolves to the response
 *
 * @example
 * ```typescript
 * import { post } from 'node-wreq';
 *
 * const response = await post(
 *   'https://example.com/api',
 *   JSON.stringify({ foo: 'bar' }),
 *   { headers: { 'Content-Type': 'application/json' } }
 * );
 * ```
 */
export async function post(
  url: string,
  body?: string,
  options?: Omit<RequestOptions, 'url' | 'method' | 'body'>
): Promise<Response> {
  return request({ ...options, url, method: 'POST', body });
}

export type { RequestOptions, Response, BrowserProfile, HttpMethod } from './types';

export type { RequestError };

export default {
  request,
  get,
  post,
  getProfiles,
};
