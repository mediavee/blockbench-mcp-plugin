import { afterEach, describe, expect, test } from "bun:test";
import { type IShareStub, shareStub } from "../test-fixtures";
import { shareModel } from "./share";

describe("shareModel", () => {
  let stub: IShareStub | undefined;

  afterEach(() => stub?.stop());

  test("posts the fields of Blockbench's share dialog as JSON", async () => {
    stub = shareStub();
    await shareModel({ name: "chair", expire: "10m", model: '{"elements":[]}' }, stub.url);
    await shareModel({ name: "chair", expire: "2w", model: "{}", thumbnail: "data:image/png;base64,AAAA" }, stub.url);
    expect(stub.requests[0]).toEqual({
      method: "POST",
      path: "/api/model",
      contentType: "application/json; charset=utf-8",
      body: { name: "chair", expire_time: "10m", model: '{"elements":[]}' },
    });
    expect(stub.requests[1]?.body).toEqual({ name: "chair", expire_time: "2w", model: "{}", thumbnail: "data:image/png;base64,AAAA" });
  });

  test("builds the link from the id the service answers", async () => {
    stub = shareStub();
    const before = Date.now();
    const shared = await shareModel({ name: "chair", expire: "1h", model: "{}" }, stub.url);
    expect(shared.id).toBe("ABoX92");
    expect(shared.url).toBe(`${stub.url}ABoX92`);
    const expires = Date.parse(shared.expires);
    expect(expires).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(expires).toBeLessThanOrEqual(Date.now() + 3_600_000);
  });

  test("a model over the service's size limit fails with the status", async () => {
    stub = shareStub(() => new Response("Payload Too Large", { status: 413 }));
    await expect(shareModel({ name: "big", expire: "2d", model: "{}" }, stub.url)).rejects.toThrow(/too large \(HTTP 413/);
  });

  test("any other error status fails with the status and the answer", async () => {
    stub = shareStub(() => new Response("upstream down", { status: 502 }));
    await expect(shareModel({ name: "m", expire: "2d", model: "{}" }, stub.url)).rejects.toThrow("The sharing service failed with HTTP 502: upstream down");
  });

  test("a success without a model id is an error, not a link", async () => {
    stub = shareStub(() => Response.json({ text: "ok" }));
    await expect(shareModel({ name: "m", expire: "2d", model: "{}" }, stub.url)).rejects.toThrow("without a model id");
  });

  test("a network failure names the endpoint", async () => {
    stub = shareStub();
    const closed = stub.url;
    stub.stop();
    await expect(shareModel({ name: "m", expire: "2d", model: "{}" }, closed)).rejects.toThrow(`Could not reach the sharing service at ${closed}api/model`);
  });
});
