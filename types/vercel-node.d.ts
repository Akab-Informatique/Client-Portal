/**
 * Request/response shapes used by the handlers in api/.
 * server/prod-server.mjs and vite-plugins/api-dev-server.ts build these
 * objects; the "@vercel/node" package itself is no longer a dependency
 * (Vercel hosting is unsupported — see README).
 */
declare module "@vercel/node" {
  import type { IncomingMessage, ServerResponse } from "http";

  export type VercelRequestCookies = { [key: string]: string };
  export type VercelRequestQuery = { [key: string]: string | string[] };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type VercelRequestBody = any;

  export type VercelRequest = IncomingMessage & {
    query: VercelRequestQuery;
    cookies: VercelRequestCookies;
    body: VercelRequestBody;
  };

  export type VercelResponse = ServerResponse & {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    send: (body: any) => VercelResponse;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    json: (jsonBody: any) => VercelResponse;
    status: (statusCode: number) => VercelResponse;
    redirect: (statusOrUrl: string | number, url?: string) => VercelResponse;
  };
}
