import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { request as httpRequest } from "node:http";
import { isIP } from "node:net";
import { ValidationError } from "@x1agent/kernel";

/**
 * SSRF-safe fetcher for OAuth-discovery and OAuth-flow URLs.
 *
 * Why this exists
 * ---------------
 * Every URL the MCP-catalog OAuth code hits is, in some sense, attacker-
 * controlled. The operator types a server URL, the protected-resource
 * metadata names an authorization server, the authorization-server
 * metadata names registration/token/revocation/jwks endpoints, and any
 * of those can 3xx-redirect to a different host. Without a hard guard,
 * the api pod will happily fetch
 *   http://169.254.169.254/latest/meta-data/...      (AWS metadata)
 *   http://metadata.google.internal/...              (GCP metadata)
 *   http://[fd00::]/...                              (ULA / on-cluster)
 *   http://[::ffff:169.254.169.254]/...              (IPv4-mapped IPv6 bypass)
 * and exfiltrate credentials to whoever set up the redirect chain.
 *
 * Defense
 * -------
 * 1. Every fetch first runs the URL through `assertPublicHttpsUrl`,
 *    which parses the URL, requires https (only http allowed in tests
 *    via injection — never in production), refuses `localhost` and
 *    IP literals in private ranges, and resolves the hostname to *all*
 *    A/AAAA records. If any address is in a blocked range, we reject.
 *
 * 2. The validated address is then used as the connect target — the
 *    TCP connection goes to the IP we already vetted, not to whatever
 *    DNS returns at fetch time. This defeats DNS rebinding (where the
 *    attacker's authoritative DNS flips the answer between validate
 *    and fetch). The TLS handshake still uses the original hostname
 *    for SNI + certificate verification, so we keep all of Web PKI.
 *
 * 3. Redirects are walked manually. Every hop re-runs the full host
 *    check. `fetch(..., { redirect: "follow" })` would let an attacker
 *    publish a public URL that 302s into 169.254.169.254 and we'd
 *    never see the final hop.
 *
 * The same helper is used by oauth-discovery, oauth-dcr, and oauth-flow
 * so the guard is consistent across the whole OAuth code path. There is
 * no "the discovery URL is already validated, the registration_endpoint
 * comes from a trusted document" — the registration_endpoint is *in*
 * the document and is itself attacker-controlled. Every external fetch
 * goes through safeFetch.
 */

/**
 * Returns true if `addr` is in a private, link-local, loopback, CGNAT,
 * multicast or otherwise non-public IP range.
 *
 * RFC 1918 + RFC 4193 + RFC 3927 + RFC 4291 + RFC 6890 coverage.
 *
 * IPv6 deserves special care: `::ffff:a.b.c.d` is an IPv4-mapped address
 * that, on a dual-stack stack, lands at the IPv4 host. An attacker can
 * use `::ffff:169.254.169.254` to bypass an IPv4-only allowlist. We
 * decode the mapped portion and recurse so the v4 blocks apply.
 */
export function isBlockedAddress(addr: string): boolean {
  if (isIP(addr) === 4) {
    const parts = addr.split(".").map((p) => Number.parseInt(p, 10));
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
    const [a, b] = parts as [number, number, number, number];
    if (a === 10) return true; //                            10.0.0.0/8
    if (a === 127) return true; //                           127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true; //              169.254.0.0/16 link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; //     172.16.0.0/12
    if (a === 192 && b === 168) return true; //              192.168.0.0/16
    if (a === 192 && b === 0 && parts[2] === 0) return true; // 192.0.0.0/24 IETF protocol assignments
    if (a === 100 && b >= 64 && b <= 127) return true; //     100.64.0.0/10 CGNAT
    if (a === 0) return true; //                              0.0.0.0/8 "this network"
    if (a >= 224) return true; //                             multicast + reserved
    return false;
  }
  if (isIP(addr) === 6) {
    const lower = addr.toLowerCase();
    if (lower === "::1") return true; //                     loopback
    if (lower === "::") return true; //                      unspecified
    if (lower.startsWith("fe80:") || lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) {
      return true; //                                         link-local fe80::/10
    }
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA fc00::/7
    if (lower.startsWith("ff")) return true; //               multicast ff00::/8
    // IPv4-mapped (::ffff:a.b.c.d) — decode and recurse so v4 blocks apply.
    const mapped = lower.match(/^::ffff:([\da-f.:]+)$/);
    if (mapped && mapped[1]) {
      const inner = mapped[1];
      // Dotted-quad form
      if (isIP(inner) === 4) return isBlockedAddress(inner);
      // Hex form (e.g. ::ffff:a9fe:a9fe == 169.254.169.254)
      const hex = inner.split(":");
      if (hex.length === 2 && hex[0] && hex[1] && hex[0].length <= 4 && hex[1].length <= 4) {
        const high = Number.parseInt(hex[0], 16);
        const low = Number.parseInt(hex[1], 16);
        if (!Number.isNaN(high) && !Number.isNaN(low)) {
          const v4 = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
          return isBlockedAddress(v4);
        }
      }
    }
    // IPv4-compatible (::a.b.c.d, deprecated but cheap to block)
    const compat = lower.match(/^::([\d.]+)$/);
    if (compat && compat[1] && isIP(compat[1]) === 4) {
      return isBlockedAddress(compat[1]);
    }
    return false;
  }
  return false;
}

export interface ResolvedHost {
  /** Parsed URL — useful for caller without reparsing. */
  parsed: URL;
  /** The validated IP address to connect to. Used as the TCP target so
   *  DNS rebinding can't flip it between validate and fetch. */
  address: string;
  family: 4 | 6;
}

export interface AssertPublicHttpsUrlOptions {
  /** Test seam — defaults to `node:dns/promises#lookup`. */
  lookup?: typeof dnsLookup;
  /** Allow http (only ever true in tests). */
  allowHttp?: boolean;
}

/**
 * Parse `rawUrl`, require https, refuse private literals, resolve DNS,
 * refuse if any returned address sits in a blocked range. Returns the
 * first validated address — callers should TCP-connect to it directly.
 *
 * Throws `ValidationError("url", ...)` on rejection so the existing
 * error envelopes (DCR registration UI, MCP attach form) surface a
 * single, consistent error shape.
 */
export async function assertPublicHttpsUrl(
  rawUrl: string,
  options: AssertPublicHttpsUrlOptions = {},
): Promise<ResolvedHost> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ValidationError("url", `invalid URL: ${rawUrl}`);
  }
  const allowHttp = options.allowHttp ?? false;
  if (parsed.protocol !== "https:" && !(allowHttp && parsed.protocol === "http:")) {
    throw new ValidationError("url", "URL must use https");
  }
  // Strip brackets from IPv6 literals so dns + isIP see the raw form.
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (host === "" || host === "localhost" || host === "ip6-localhost") {
    throw new ValidationError("url", "URL host is not a valid MCP server");
  }
  // IP literal: check directly, no DNS.
  const literalFamily = isIP(host);
  if (literalFamily === 4 || literalFamily === 6) {
    if (isBlockedAddress(host)) {
      throw new ValidationError(
        "url",
        `URL resolves to a private or reserved address (${host})`,
      );
    }
    return { parsed, address: host, family: literalFamily as 4 | 6 };
  }
  const lookup = options.lookup ?? dnsLookup;
  let addrs: { address: string; family: number }[];
  try {
    addrs = await lookup(host, { all: true });
  } catch (err) {
    throw new ValidationError(
      "url",
      `DNS lookup failed for ${host}: ${(err as Error).message}`,
    );
  }
  if (addrs.length === 0) {
    throw new ValidationError("url", `DNS lookup returned no records for ${host}`);
  }
  // Reject if *any* record is in a blocked range — defense in depth
  // against multi-record rebinding where one of the answers points at
  // a metadata host and the OS's address-selection algorithm happens
  // to pick it.
  for (const a of addrs) {
    if (isBlockedAddress(a.address)) {
      throw new ValidationError(
        "url",
        `URL resolves to a private or reserved address (${a.address})`,
      );
    }
  }
  const chosen = addrs[0]!;
  const family = chosen.family === 6 ? 6 : 4;
  return { parsed, address: chosen.address, family };
}

export interface SafeFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Hard timeout for the request. Required — there is no implicit default
   *  to discourage forgetting it. */
  timeoutMs: number;
  /** Max redirects to follow. Each hop re-runs assertPublicHttpsUrl. */
  maxRedirects?: number;
  /** Max bytes the response body may contain. Defaults to 256 KiB which
   *  is plenty for OAuth metadata / DCR / token responses. */
  maxBodyBytes?: number;
}

export interface SafeFetchResponse {
  status: number;
  ok: boolean;
  /** Final URL after redirects. */
  url: string;
  headers: Record<string, string>;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
}

export type SafeFetch = (
  url: string,
  init: SafeFetchInit,
) => Promise<SafeFetchResponse>;

/**
 * Performs a single HTTP request to a pre-validated IP. Caller is
 * responsible for redirect handling.
 *
 * The connection targets `resolved.address` directly, so even if DNS
 * is flipped between validation and this call, we land where we
 * promised. SNI + certificate verification both use the original
 * hostname (`resolved.parsed.hostname`) so a legit cert chain still
 * validates.
 */
async function doSinglePinnedRequest(
  resolved: ResolvedHost,
  init: SafeFetchInit,
): Promise<{
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}> {
  const { parsed, address, family } = resolved;
  const isHttps = parsed.protocol === "https:";
  const requestFn = isHttps ? httpsRequest : httpRequest;
  const port = parsed.port
    ? Number.parseInt(parsed.port, 10)
    : isHttps
      ? 443
      : 80;
  const headers: Record<string, string> = {
    Host: parsed.host,
    ...(init.headers ?? {}),
  };
  // Always provide an explicit Connection: close — we don't reuse
  // sockets across requests and we don't want a keep-alive ping
  // landing on a future-different process.
  if (!Object.keys(headers).some((k) => k.toLowerCase() === "connection")) {
    headers.Connection = "close";
  }
  const options: RequestOptions = {
    method: init.method ?? "GET",
    host: address,
    port,
    path: `${parsed.pathname}${parsed.search}`,
    headers,
    timeout: init.timeoutMs,
    // family forces the socket to the same address family we resolved
    // to — defense in depth so a v4 IP literal can't accidentally be
    // interpreted as a v6 form.
    family,
    // TLS hostname for SNI + cert verification stays the *original*
    // hostname, not the IP literal we connect to.
    servername: isHttps ? parsed.hostname : undefined,
  };
  const maxBytes = init.maxBodyBytes ?? 256 * 1024;
  return await new Promise((resolve, reject) => {
    const req = requestFn(options, (res) => {
      const chunks: Buffer[] = [];
      let received = 0;
      res.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > maxBytes) {
          req.destroy(
            new ValidationError(
              "url",
              `response body exceeded ${maxBytes} bytes`,
            ),
          );
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        const flat: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (Array.isArray(v)) flat[k.toLowerCase()] = v.join(", ");
          else if (typeof v === "string") flat[k.toLowerCase()] = v;
        }
        resolve({
          status: res.statusCode ?? 0,
          headers: flat,
          body: Buffer.concat(chunks),
        });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(
        new ValidationError(
          "url",
          `request to ${parsed.host} timed out after ${init.timeoutMs}ms`,
        ),
      );
    });
    if (init.body !== undefined && init.body !== "") {
      req.write(init.body);
    }
    req.end();
  });
}

export interface SafeFetchOptions {
  /** Test seam — defaults to `assertPublicHttpsUrl`. */
  validate?: typeof assertPublicHttpsUrl;
  /** Test seam — defaults to the IP-pinned `node:https.request` impl. */
  performRequest?: typeof doSinglePinnedRequest;
  /** Forward to validator. */
  validateOptions?: AssertPublicHttpsUrlOptions;
}

const DEFAULT_MAX_REDIRECTS = 5;

/**
 * SSRF-safe fetch:
 *   • Validates the URL (parse + https + DNS allowlist)
 *   • Connects to the validated IP (defeats DNS rebinding)
 *   • Manually follows 3xx redirects, re-validating each hop
 *   • Caps timeout + body size
 *
 * Returns a `Response`-shaped object with `text()` and `json()` helpers
 * so call sites read close to the standard fetch idiom.
 */
export async function safeFetch(
  rawUrl: string,
  init: SafeFetchInit,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResponse> {
  const validate = options.validate ?? assertPublicHttpsUrl;
  const performRequest = options.performRequest ?? doSinglePinnedRequest;
  const maxRedirects = init.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  let current = rawUrl;
  // GET-by-default; if a 3xx steers us to a new URL we keep the method
  // for 307/308 and downgrade to GET for 301/302/303 per RFC 7231 §6.4.
  let method = (init.method ?? "GET").toUpperCase();
  let body = init.body;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const resolved = await validate(current, options.validateOptions);
    const res = await performRequest(resolved, {
      ...init,
      method,
      body,
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers["location"];
      if (!loc) {
        throw new ValidationError(
          "url",
          `${current} returned HTTP ${res.status} with no Location header`,
        );
      }
      current = new URL(loc, current).toString();
      if (res.status === 301 || res.status === 302 || res.status === 303) {
        method = "GET";
        body = undefined;
      }
      continue;
    }
    const status = res.status;
    return {
      status,
      ok: status >= 200 && status < 300,
      url: current,
      headers: res.headers,
      text: async () => res.body.toString("utf-8"),
      json: async <T = unknown>() => JSON.parse(res.body.toString("utf-8")) as T,
    };
  }
  throw new ValidationError("url", `${rawUrl} exceeded ${maxRedirects} redirects`);
}
