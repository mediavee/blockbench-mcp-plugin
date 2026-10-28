/**
 * Uploads a model to Blockbench's model sharing service (blckbn.ch), the way
 * the desktop app's File > Share dialog does (`share_model` in Blockbench's
 * `js/io/share.ts`): a JSON POST of `{name, expire_time, model, thumbnail}` to
 * `/api/model`, answered `{id}`, shared as `https://blckbn.ch/<id>`. The service
 * keeps the model publicly readable by anyone with the link until it expires.
 *
 * @module
 */

/** Where Blockbench's sharing service lives. */
export const DEFAULT_SHARE_URL = "https://blckbn.ch/";

/** Expiry choices of Blockbench's share dialog, with their length in milliseconds. */
export const SHARE_EXPIRY_MS = {
  "10m": 10 * 60_000,
  "1h": 60 * 60_000,
  "1d": 24 * 60 * 60_000,
  "2d": 2 * 24 * 60 * 60_000,
  "1w": 7 * 24 * 60 * 60_000,
  "2w": 14 * 24 * 60 * 60_000,
} as const;

/** One expiry choice. */
export type ShareExpiry = keyof typeof SHARE_EXPIRY_MS;

/** Expiry choices, shortest first. */
export const SHARE_EXPIRIES = Object.keys(SHARE_EXPIRY_MS) as [ShareExpiry, ...ShareExpiry[]];

/** The dialog's default expiry. */
export const DEFAULT_SHARE_EXPIRY: ShareExpiry = "2d";

/** What to upload. */
export interface IShareRequest {
  name: string;
  expire: ShareExpiry;
  /** The `.bbmodel` text. */
  model: string;
  /** PNG data URL shown as the link's preview. */
  thumbnail?: string;
}

/** A shared model. */
export interface IShareResult {
  url: string;
  id: string;
  /** When the service deletes the model, counted from the upload on this machine's clock. */
  expires: string;
}

const UPLOAD_TIMEOUT_MS = 60_000;

/** Short text from an error answer, for the tool error. */
async function answerExcerpt(response: Response): Promise<string> {
  const text = (await response.text().catch(() => "")).trim().replace(/\s+/g, " ");
  return text === "" ? "" : `: ${text.slice(0, 200)}`;
}

/**
 * Uploads a model and returns its public link.
 *
 * @param baseUrl - Service root, `https://blckbn.ch/` outside tests.
 * @throws Error naming the HTTP status (413 when the model is over the service's size limit), or the network failure.
 */
export async function shareModel(request: IShareRequest, baseUrl: string = DEFAULT_SHARE_URL): Promise<IShareResult> {
  const endpoint = new URL("api/model", baseUrl).href;
  // JSON.stringify drops an undefined thumbnail, as in Blockbench's request.
  const body = JSON.stringify({ name: request.name, expire_time: request.expire, model: request.model, thumbnail: request.thumbnail });
  const started = Date.now();
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8", Accept: "application/json" },
      body,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`Could not reach the sharing service at ${endpoint}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (response.status === 413) {
    throw new Error(
      `The sharing service refused the model as too large (HTTP 413, ${Math.ceil(body.length / 1024)} KB sent). Share it without a thumbnail, or with smaller or fewer textures and reference images.`,
    );
  }
  if (!response.ok) throw new Error(`The sharing service failed with HTTP ${response.status}${await answerExcerpt(response)}`);
  const answer: unknown = await response.json().catch(() => undefined);
  const id = typeof answer === "object" && answer !== null ? (answer as { id?: unknown }).id : undefined;
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error(`The sharing service answered HTTP ${response.status} without a model id: ${JSON.stringify(answer)?.slice(0, 200)}`);
  }
  return { url: new URL(id, baseUrl).href, id, expires: new Date(started + SHARE_EXPIRY_MS[request.expire]).toISOString() };
}
