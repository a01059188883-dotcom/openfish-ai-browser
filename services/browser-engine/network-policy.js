import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export function isPrivateIPv4(ip) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = p;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)) ||
    (a === 203 && b === 0 && c === 113) ||
    (a === 255 && b === 255 && c === 255);
}

export function isPrivateIPv6(ip) {
  const v = ip.toLowerCase().split("%")[0];
  return v === "::" || v === "::1" ||
    v.startsWith("fc") || v.startsWith("fd") ||
    /^fe[89ab]/.test(v) || v.startsWith("ff") ||
    v.startsWith("::ffff:") || v.startsWith("2001:db8:") ||
    v.startsWith("2001:0000:") || v.startsWith("2001:2:") ||
    v.startsWith("2002:") || v.startsWith("64:ff9b:");
}

const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".test", ".invalid", ".example"];
export async function validateTarget(raw) {
  let target;
  try { target = new URL(raw); } catch { throw new Error("请输入有效的网址"); }
  if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) {
    throw new Error("仅允许公开 HTTP/HTTPS 网页地址");
  }
  const host = target.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host || host === "localhost" || host === "metadata.google.internal" || LOCAL_SUFFIXES.some(s => host.endsWith(s))) {
    throw new Error("不能访问本机、内网或云元数据地址");
  }
  const ipVersion = isIP(host);
  if (ipVersion === 4 && isPrivateIPv4(host)) throw new Error("不能访问私有或保留 IP 地址");
  if (ipVersion === 6 && isPrivateIPv6(host)) throw new Error("不能访问私有或保留 IPv6 地址");
  if (!ipVersion) {
    let records;
    try { records = await lookup(host, { all: true, verbatim: true }); }
    catch { throw new Error("域名无法解析"); }
    if (!records.length || records.some(x => x.family === 4 ? isPrivateIPv4(x.address) : isPrivateIPv6(x.address))) {
      throw new Error("域名解析到私有或保留 IP，已阻止访问");
    }
  }
  return target.toString();
}
