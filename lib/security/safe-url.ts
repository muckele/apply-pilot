import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";

const defaultTimeoutMs = 10_000;
const defaultMaxBytes = 1_500_000;
const defaultMaxRedirects = 3;

type SafeFetchTextOptions = {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  next?: {
    revalidate?: number | false;
    tags?: string[];
  };
};

type ResolvedSafeUrl = {
  url: URL;
  address: string;
  family: number;
};

function normalizeHostname(hostname: string) {
  return hostname.toLowerCase().replace(/\.$/, "");
}

function isPrivateIpv4(ip: string) {
  const parts = ip.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }

  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a === 169 && b === 254 ||
    a === 172 && b >= 16 && b <= 31 ||
    a === 192 && b === 168 ||
    a === 100 && b >= 64 && b <= 127 ||
    a === 192 && b === 0 ||
    a === 198 && (b === 18 || b === 19) ||
    a >= 224
  );
}

function normalizeIpv4MappedIpv6(ip: string) {
  const lower = ip.toLowerCase();
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped?.[1] ?? ip;
}

function isPrivateIpv6(ip: string) {
  const lower = ip.toLowerCase();
  return (
    lower === "::1" ||
    lower === "::" ||
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    lower.startsWith("fe8") ||
    lower.startsWith("fe9") ||
    lower.startsWith("fea") ||
    lower.startsWith("feb")
  );
}

function isPrivateOrReservedIp(ip: string) {
  const normalized = normalizeIpv4MappedIpv6(ip);
  const family = net.isIP(normalized);

  if (family === 4) {
    return isPrivateIpv4(normalized);
  }

  if (family === 6) {
    return isPrivateIpv6(normalized);
  }

  return true;
}

async function resolveSafePublicHttpUrl(value: string): Promise<ResolvedSafeUrl> {
  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Source URL is invalid.");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only http and https source URLs are allowed.");
  }

  if (parsed.username || parsed.password) {
    throw new Error("Source URLs with embedded credentials are not allowed.");
  }

  const hostname = normalizeHostname(parsed.hostname);

  if (
    hostname === "localhost" ||
    hostname === "localhost.localdomain" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new Error("Local or internal source hosts are not allowed.");
  }

  if (net.isIP(hostname)) {
    if (isPrivateOrReservedIp(hostname)) {
      throw new Error("Private, local, or reserved source IP addresses are not allowed.");
    }

    return { url: parsed, address: hostname, family: net.isIP(hostname) };
  }

  let records: Array<{ address: string; family: number }>;
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: false });
  } catch {
    throw new Error("Source host could not be resolved.");
  }

  if (!records.length || records.some((record) => isPrivateOrReservedIp(record.address))) {
    throw new Error("Source host resolves to a private, local, or reserved address.");
  }

  return { url: parsed, address: records[0].address, family: records[0].family };
}

export async function assertSafePublicHttpUrl(value: string) {
  return (await resolveSafePublicHttpUrl(value)).url;
}

async function requestPinnedText(resolved: ResolvedSafeUrl, timeoutMs: number, maxBytes: number) {
  const client = resolved.url.protocol === "https:" ? https : http;

  return new Promise<{
    status: number;
    ok: boolean;
    headers: http.IncomingHttpHeaders;
    text: string;
  }>((resolve, reject) => {
    const request = client.request(
      resolved.url,
      {
        method: "GET",
        lookup: (_hostname, _options, callback) => {
          callback(null, resolved.address, resolved.family);
        },
        timeout: timeoutMs,
        headers: {
          "user-agent": "JobMatchCRM/1.0 (+https://jobmatch.local)",
          accept: "text/html,application/rss+xml,application/xml,text/xml,text/plain;q=0.8"
        }
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;

        response.on("data", (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > maxBytes) {
            response.destroy(new Error("Source response is too large."));
            return;
          }

          chunks.push(chunk);
        });

        response.on("end", () => {
          const status = response.statusCode ?? 0;
          resolve({
            status,
            ok: status >= 200 && status < 300,
            headers: response.headers,
            text: Buffer.concat(chunks).toString("utf8")
          });
        });
      }
    );

    request.on("timeout", () => {
      request.destroy(new Error("Source request timed out."));
    });
    request.on("error", reject);
    request.end();
  });
}

export async function fetchTextFromSafeUrl(url: string, options: SafeFetchTextOptions = {}) {
  const {
    timeoutMs = defaultTimeoutMs,
    maxBytes = defaultMaxBytes,
    maxRedirects = defaultMaxRedirects
  } = options;
  let current = await resolveSafePublicHttpUrl(url);

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const response = await requestPinnedText(current, timeoutMs, maxBytes);

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.location;
      if (!location) {
        throw new Error(`Source redirected without a location header.`);
      }

      if (redirectCount === maxRedirects) {
        throw new Error("Source redirected too many times.");
      }

      current = await resolveSafePublicHttpUrl(new URL(location, current.url).toString());
      continue;
    }

    return {
      response,
      text: response.text,
      finalUrl: current.url.toString()
    };
  }

  throw new Error("Source request failed.");
}
