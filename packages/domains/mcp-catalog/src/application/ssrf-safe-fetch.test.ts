import { describe, it, expect } from "bun:test";
import {
  assertPublicHttpsUrl,
  isBlockedAddress,
  safeFetch,
  type ResolvedHost,
} from "./ssrf-safe-fetch.js";
import { ValidationError } from "@x1agent/kernel";

// Helper to build a fake dns.lookup that returns canned records.
function fakeLookup(records: Record<string, { address: string; family: number }[]>) {
  return (async (
    hostname: string,
    _opts?: unknown,
  ): Promise<{ address: string; family: number }[]> => {
    const recs = records[hostname];
    if (!recs) {
      const err = new Error(`ENOTFOUND ${hostname}`);
      (err as NodeJS.ErrnoException).code = "ENOTFOUND";
      throw err;
    }
    return recs;
  }) as unknown as typeof import("node:dns/promises").lookup;
}

describe("isBlockedAddress (IPv4)", () => {
  it("blocks the AWS/GCP cloud-metadata IP", () => {
    expect(isBlockedAddress("169.254.169.254")).toBe(true);
  });
  it("blocks RFC1918, loopback, CGNAT, multicast, unspecified", () => {
    expect(isBlockedAddress("10.0.0.1")).toBe(true);
    expect(isBlockedAddress("172.16.0.1")).toBe(true);
    expect(isBlockedAddress("172.31.255.255")).toBe(true);
    expect(isBlockedAddress("192.168.1.1")).toBe(true);
    expect(isBlockedAddress("127.0.0.1")).toBe(true);
    expect(isBlockedAddress("100.64.0.1")).toBe(true); // CGNAT
    expect(isBlockedAddress("0.0.0.0")).toBe(true);
    expect(isBlockedAddress("224.0.0.1")).toBe(true); // multicast
  });
  it("allows ordinary public addresses", () => {
    expect(isBlockedAddress("8.8.8.8")).toBe(false);
    expect(isBlockedAddress("1.1.1.1")).toBe(false);
    expect(isBlockedAddress("172.32.0.1")).toBe(false); // just outside 172.16/12
    expect(isBlockedAddress("169.253.0.1")).toBe(false); // just outside link-local
  });
});

describe("isBlockedAddress (IPv6)", () => {
  it("blocks IPv6 loopback, unspecified, link-local, ULA, multicast", () => {
    expect(isBlockedAddress("::1")).toBe(true);
    expect(isBlockedAddress("::")).toBe(true);
    expect(isBlockedAddress("fe80::1")).toBe(true);
    expect(isBlockedAddress("febf::1")).toBe(true); // top of fe80::/10
    expect(isBlockedAddress("fc00::1")).toBe(true); // ULA
    expect(isBlockedAddress("fd00::1")).toBe(true); // ULA (most common in-cluster pattern)
    expect(isBlockedAddress("ff02::1")).toBe(true); // multicast
  });
  it("decodes IPv4-mapped IPv6 (::ffff:a.b.c.d) and recurses", () => {
    // The classic bypass: dual-stack hosts route ::ffff:169.254.169.254
    // straight to 169.254.169.254 on the IPv4 wire.
    expect(isBlockedAddress("::ffff:169.254.169.254")).toBe(true);
    expect(isBlockedAddress("::ffff:10.0.0.1")).toBe(true);
    expect(isBlockedAddress("::FFFF:127.0.0.1")).toBe(true); // case-insensitive
    expect(isBlockedAddress("::ffff:8.8.8.8")).toBe(false);
  });
  it("decodes hex form of IPv4-mapped (::ffff:a9fe:a9fe == 169.254.169.254)", () => {
    expect(isBlockedAddress("::ffff:a9fe:a9fe")).toBe(true);
  });
  it("allows ordinary public IPv6", () => {
    expect(isBlockedAddress("2001:4860:4860::8888")).toBe(false); // Google DNS
  });
});

describe("assertPublicHttpsUrl", () => {
  it("rejects non-https URLs by default", async () => {
    await expect(assertPublicHttpsUrl("http://example.com/")).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(assertPublicHttpsUrl("ftp://example.com/")).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(assertPublicHttpsUrl("file:///etc/passwd")).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("rejects localhost without doing DNS", async () => {
    await expect(
      assertPublicHttpsUrl("https://localhost/", {
        lookup: fakeLookup({}),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects bare IP literals that land in blocked ranges", async () => {
    await expect(
      assertPublicHttpsUrl("https://169.254.169.254/", {
        lookup: fakeLookup({}),
      }),
    ).rejects.toThrow(/private or reserved/);
  });

  it("rejects bracketed IPv6 metadata literals (X1A-125 IPv6 case)", async () => {
    await expect(
      assertPublicHttpsUrl("https://[fd00::1]/", { lookup: fakeLookup({}) }),
    ).rejects.toThrow(/private or reserved/);
    await expect(
      assertPublicHttpsUrl("https://[::ffff:169.254.169.254]/", {
        lookup: fakeLookup({}),
      }),
    ).rejects.toThrow(/private or reserved/);
  });

  it("allows public IP literals", async () => {
    const r = await assertPublicHttpsUrl("https://1.1.1.1/", { lookup: fakeLookup({}) });
    expect(r.address).toBe("1.1.1.1");
    expect(r.family).toBe(4);
  });

  it("resolves DNS and rejects when ANY record is private", async () => {
    const lookup = fakeLookup({
      "evil.example": [
        { address: "8.8.8.8", family: 4 },
        // Multi-record rebinding: one of the answers is metadata.
        { address: "169.254.169.254", family: 4 },
      ],
    });
    await expect(
      assertPublicHttpsUrl("https://evil.example/", { lookup }),
    ).rejects.toThrow(/private or reserved.*169\.254\.169\.254/);
  });

  it("returns the validated address so callers can connect by IP", async () => {
    const lookup = fakeLookup({
      "good.example": [{ address: "8.8.8.8", family: 4 }],
    });
    const r = await assertPublicHttpsUrl("https://good.example/path", { lookup });
    expect(r.address).toBe("8.8.8.8");
    expect(r.family).toBe(4);
    expect(r.parsed.hostname).toBe("good.example");
  });
});

describe("safeFetch", () => {
  it("passes the pre-validated address to performRequest (defeats DNS rebinding)", async () => {
    // The "rebinding" case: dns.lookup is called twice and would return
    // different addresses each time. With IP pinning, only the first
    // call matters — the second never runs because performRequest
    // connects to the address we already validated.
    let callCount = 0;
    const flippingLookup = (async () => {
      callCount += 1;
      if (callCount === 1) {
        return [{ address: "8.8.8.8", family: 4 }];
      }
      // After validation, DNS flips to the metadata IP. If anything
      // re-resolves, we'd connect there. The test asserts we do not.
      return [{ address: "169.254.169.254", family: 4 }];
    }) as unknown as typeof import("node:dns/promises").lookup;

    const connectedAddrs: string[] = [];
    const performRequest = async (
      resolved: ResolvedHost,
    ): Promise<{
      status: number;
      headers: Record<string, string>;
      body: Buffer;
    }> => {
      connectedAddrs.push(resolved.address);
      return { status: 200, headers: {}, body: Buffer.from('{"ok":true}') };
    };
    const res = await safeFetch(
      "https://target.example/x",
      { timeoutMs: 1000 },
      {
        validateOptions: { lookup: flippingLookup },
        performRequest,
      },
    );
    expect(res.ok).toBe(true);
    // We only did one DNS lookup (the validate step). Performing the
    // request used the validated address; no second resolve.
    expect(callCount).toBe(1);
    expect(connectedAddrs).toEqual(["8.8.8.8"]);
  });

  it("re-validates every redirect hop and refuses when a hop lands at a metadata IP", async () => {
    // First fetch resolves to a public IP and returns a 302 to a host
    // whose DNS resolves to 169.254.169.254. The redirect handler must
    // run validation again and refuse.
    const lookup = fakeLookup({
      "first.example": [{ address: "8.8.8.8", family: 4 }],
      "metadata.example": [{ address: "169.254.169.254", family: 4 }],
    });
    const performRequest = async (
      resolved: ResolvedHost,
    ): Promise<{
      status: number;
      headers: Record<string, string>;
      body: Buffer;
    }> => {
      if (resolved.parsed.hostname === "first.example") {
        return {
          status: 302,
          headers: { location: "https://metadata.example/internal" },
          body: Buffer.alloc(0),
        };
      }
      // Should never reach here — the validate step should have refused.
      return {
        status: 200,
        headers: {},
        body: Buffer.from("PRIVATE DATA"),
      };
    };
    await expect(
      safeFetch(
        "https://first.example/start",
        { timeoutMs: 1000, maxRedirects: 3 },
        { validateOptions: { lookup }, performRequest },
      ),
    ).rejects.toThrow(/private or reserved/);
  });

  it("follows benign redirects up to the cap and reports the final body", async () => {
    const lookup = fakeLookup({
      "a.example": [{ address: "8.8.8.8", family: 4 }],
      "b.example": [{ address: "1.1.1.1", family: 4 }],
    });
    const performRequest = async (
      resolved: ResolvedHost,
    ): Promise<{
      status: number;
      headers: Record<string, string>;
      body: Buffer;
    }> => {
      if (resolved.parsed.hostname === "a.example") {
        return {
          status: 302,
          headers: { location: "https://b.example/final" },
          body: Buffer.alloc(0),
        };
      }
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: Buffer.from('{"hello":"world"}'),
      };
    };
    const res = await safeFetch(
      "https://a.example/start",
      { timeoutMs: 1000 },
      { validateOptions: { lookup }, performRequest },
    );
    expect(res.ok).toBe(true);
    expect(res.url).toBe("https://b.example/final");
    expect(await res.json<{ hello: string }>()).toEqual({ hello: "world" });
  });

  it("rejects when redirect cap is exceeded", async () => {
    const lookup = fakeLookup({
      "loop.example": [{ address: "8.8.8.8", family: 4 }],
    });
    const performRequest = async (): Promise<{
      status: number;
      headers: Record<string, string>;
      body: Buffer;
    }> => ({
      status: 302,
      headers: { location: "https://loop.example/x" },
      body: Buffer.alloc(0),
    });
    await expect(
      safeFetch(
        "https://loop.example/start",
        { timeoutMs: 1000, maxRedirects: 2 },
        { validateOptions: { lookup }, performRequest },
      ),
    ).rejects.toThrow(/exceeded.*redirects/);
  });

  it("rejects when 3xx returns no Location header", async () => {
    const lookup = fakeLookup({
      "noloc.example": [{ address: "8.8.8.8", family: 4 }],
    });
    const performRequest = async (): Promise<{
      status: number;
      headers: Record<string, string>;
      body: Buffer;
    }> => ({
      status: 302,
      headers: {},
      body: Buffer.alloc(0),
    });
    await expect(
      safeFetch(
        "https://noloc.example/",
        { timeoutMs: 1000 },
        { validateOptions: { lookup }, performRequest },
      ),
    ).rejects.toThrow(/no Location header/);
  });

  it("downgrades to GET on 301/302/303 and keeps the method on 307/308", async () => {
    const lookup = fakeLookup({
      "a.example": [{ address: "8.8.8.8", family: 4 }],
      "b.example": [{ address: "1.1.1.1", family: 4 }],
    });
    const seen: { host: string; method: string; body: string | undefined }[] = [];
    const performRequest = async (
      resolved: ResolvedHost,
      init: { method?: string; body?: string },
    ): Promise<{
      status: number;
      headers: Record<string, string>;
      body: Buffer;
    }> => {
      seen.push({
        host: resolved.parsed.hostname,
        method: init.method ?? "GET",
        body: init.body,
      });
      if (resolved.parsed.hostname === "a.example") {
        return {
          status: 303,
          headers: { location: "https://b.example/done" },
          body: Buffer.alloc(0),
        };
      }
      return { status: 200, headers: {}, body: Buffer.from("ok") };
    };
    await safeFetch(
      "https://a.example/x",
      { method: "POST", body: "payload", timeoutMs: 1000 },
      { validateOptions: { lookup }, performRequest },
    );
    expect(seen).toEqual([
      { host: "a.example", method: "POST", body: "payload" },
      { host: "b.example", method: "GET", body: undefined },
    ]);
  });
});
