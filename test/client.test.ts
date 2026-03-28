import { describe, expect, it } from "vitest";
import { SLBatchRequest, ServiceLayerClient } from "../src/index.js";

describe("ServiceLayerClient", () => {
  it("applies fluent query parameters and headers", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];

    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, init });

      if (url.endsWith("/Login")) {
        return new Response(
          JSON.stringify({ SessionId: "session-id", Version: "10", SessionTimeout: 30 }),
          {
            status: 200,
            headers: {
              "content-type": "application/json"
            }
          }
        );
      }

      return new Response(JSON.stringify({ value: [{ DocEntry: 1 }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    const client = new ServiceLayerClient({
      baseUrl: "https://sapserver:50000/b1s/v2",
      companyDB: "SBODEMO",
      userName: "manager",
      password: "12345",
      fetch: mockFetch
    });

    const result = await client
      .request("Orders")
      .select("DocEntry")
      .filter("DocEntry gt 0")
      .orderBy("DocEntry asc")
      .top(1)
      .skip(2)
      .expand("DocumentLines")
      .withPageSize(50)
      .withCaseInsensitive()
      .withReplaceCollectionsOnPatch()
      .withReturnNoContent()
      .withHeader("X-Test", "ok")
      .get<Array<{ DocEntry: number }>>();

    expect(result).toEqual([{ DocEntry: 1 }]);

    const requestCall = calls.find((call) => call.url.includes("/Orders?"));
    expect(requestCall).toBeTruthy();
    expect(requestCall?.url).toContain("%24select=DocEntry");
    expect(requestCall?.url).toContain("%24filter=DocEntry+gt+0");
    expect(requestCall?.url).toContain("%24orderby=DocEntry+asc");
    expect(requestCall?.url).toContain("%24top=1");
    expect(requestCall?.url).toContain("%24skip=2");
    expect(requestCall?.url).toContain("%24expand=DocumentLines");

    const headers = new Headers(requestCall?.init?.headers);
    expect(headers.get("B1S-PageSize")).toBe("50");
    expect(headers.get("B1S-CaseInsensitive")).toBe("true");
    expect(headers.get("B1S-ReplaceCollectionsOnPatch")).toBe("true");
    expect(headers.get("Prefer")).toBe("return-no-content");
    expect(headers.get("X-Test")).toBe("ok");
  });

  it("loads all pages with getAll", async () => {
    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);

      if (url.endsWith("/Login")) {
        return new Response(
          JSON.stringify({ SessionId: "session-id", Version: "10", SessionTimeout: 30 }),
          {
            status: 200,
            headers: {
              "content-type": "application/json"
            }
          }
        );
      }

      if (url.includes("%24skip=0")) {
        return new Response(
          JSON.stringify({
            value: [{ DocEntry: 1 }, { DocEntry: 2 }],
            "@odata.nextLink": "Orders?$skip=2"
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }

      return new Response(JSON.stringify({ value: [{ DocEntry: 3 }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    const client = new ServiceLayerClient({
      baseUrl: "https://sapserver:50000/b1s/v2",
      companyDB: "SBODEMO",
      userName: "manager",
      password: "12345",
      fetch: mockFetch
    });

    const result = await client.request("Orders").withPageSize(2).getAll<{ DocEntry: number }>();

    expect(result).toEqual([{ DocEntry: 1 }, { DocEntry: 2 }, { DocEntry: 3 }]);
  });

  it("builds and parses batch requests", async () => {
    let batchBody = "";

    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);

      if (url.endsWith("/Login")) {
        return new Response(
          JSON.stringify({ SessionId: "session-id", Version: "10", SessionTimeout: 30 }),
          {
            status: 200,
            headers: {
              "content-type": "application/json"
            }
          }
        );
      }

      if (url.endsWith("/$batch")) {
        batchBody = String(init?.body ?? "");
        const responseBody = [
          "HTTP/1.1 201 Created",
          "Content-Type: application/json",
          "",
          '{"CardCode":"C00001"}',
          "",
          "HTTP/1.1 200 OK",
          "Content-Type: application/json",
          "",
          "{\"value\":[]}",
          "",
          "HTTP/1.1 204 No Content",
          "",
          ""
        ].join("\r\n");

        return new Response(responseBody, {
          status: 202,
          headers: { "content-type": "multipart/mixed" }
        });
      }

      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };

    const client = new ServiceLayerClient({
      baseUrl: "https://sapserver:50000/b1s/v2",
      companyDB: "SBODEMO",
      userName: "manager",
      password: "12345",
      fetch: mockFetch
    });

    const requests = [
      new SLBatchRequest("POST", "BusinessPartners", { CardCode: "C00001" }, 1),
      new SLBatchRequest("GET", "Orders"),
      new SLBatchRequest("PATCH", "BusinessPartners('C00001')", { CardName: "Updated" }, 2)
    ];

    const result = await client.postBatch(requests, true);
    expect(result).toHaveLength(3);
    expect(result[0]!.status).toBe(201);
    expect(result[1]!.status).toBe(200);
    expect(result[2]!.status).toBe(204);

    const postIndex = batchBody.indexOf("POST /b1s/v2/BusinessPartners HTTP/1.1");
    const getIndex = batchBody.indexOf("GET /b1s/v2/Orders HTTP/1.1");
    const patchIndex = batchBody.indexOf("PATCH /b1s/v2/BusinessPartners('C00001') HTTP/1.1");
    expect(postIndex).toBeGreaterThanOrEqual(0);
    expect(getIndex).toBeGreaterThan(postIndex);
    expect(patchIndex).toBeGreaterThan(getIndex);
  });
});
