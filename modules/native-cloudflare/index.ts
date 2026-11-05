import { requireOptionalNativeModule } from 'expo-modules-core';

export type CloudflareSolveRequest = {
  url: string;
  method: string;
  /** Headers a WebView can send; cookies come from the shared cookie store. */
  headers: Record<string, string>;
  body?: string;
  /**
   * Whether the request may be answered from inside the WebView when the page
   * loads without a challenge and no clearance is issued.
   */
  captureResponse: boolean;
  userAgent: string;
  timeoutMs: number;
  maxResponseLength: number;
};

export type CloudflareSolveResult =
  | { type: 'clearance' }
  | {
      type: 'response';
      status: number;
      statusText: string;
      url: string;
      headers: Record<string, string>;
      body: string;
    }
  | { type: 'failed' };

type NativeCloudflareModule = {
  /**
   * Runs the Cloudflare challenge for the request in an off-screen WebView.
   * Resolves `clearance` once a new `cf_clearance` cookie is stored, or
   * `response` when the site served the request to the WebView without one.
   */
  solveChallenge(
    request: CloudflareSolveRequest,
  ): Promise<CloudflareSolveResult>;
};

export default requireOptionalNativeModule<NativeCloudflareModule>(
  'NativeCloudflare',
);
