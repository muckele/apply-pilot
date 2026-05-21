import dns from "node:dns/promises";
import net from "node:net";

const defaultTimeoutMs = 10_000;
const defaultMaxBytes = 1_500_000;
const defaultMaxRedirects = 3;

type SafeFetchTextOptions = Omit<RequestInit, "redirect" | "signal"> & {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  next?: {
    revalidate?: number | false;
    tags?: string[];
  };
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

export async function assertSafePublicHttpUrl(value: string) {
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

    return parsed;
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

  return parsed;
}

async function readLimitedText(response: Response, maxBytes: number) {
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) {
      throw new Error("Source response is too large.");
    }

    return Buffer.from(buffer).toString("utf8");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error("Source response is too large.");
    }

    chunks.push(value);
  }

  return Buffer.concat(chunks).toString("utf8");
}

export async function fetchTextFromSafeUrl(url: string, options: SafeFetchTextOptions = {}) {
  const {
    timeoutMs = defaultTimeoutMs,
    maxBytes = defaultMaxBytes,
    maxRedirects = defaultMaxRedirects,
    ...fetchOptions
  } = options;
  let currentUrl = await assertSafePublicHttpUrl(url);

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(currentUrl, {
        ...fetchOptions,
        redirect: "manual",
        signal: controller.signal
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) {
          throw new Error(`Source redirected without a location header.`);
        }

        if (redirectCount === maxRedirects) {
          throw new Error("Source redirected too many times.");
        }

        currentUrl = await assertSafePublicHttpUrl(new URL(location, currentUrl).toString());
        continue;
      }

      const text = await readLimitedText(response, maxBytes);
      return {
        response,
        text,
        finalUrl: currentUrl.toString()
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("Source request timed out.");
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error("Source request failed.");
}
