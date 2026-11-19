import test from "node:test";
import assert from "node:assert/strict";
import { isPrivateIPv4, isPrivateIPv6, validateTarget } from "../network-policy.js";

test("blocks private, loopback, link-local and reserved IPv4 ranges", () => {
  for (const ip of ["0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "192.0.0.8", "192.0.2.1", "192.168.1.1", "198.18.0.1", "198.51.100.2", "203.0.113.8", "224.0.0.1", "255.255.255.255"]) {
    assert.equal(isPrivateIPv4(ip), true, ip);
  }
  assert.equal(isPrivateIPv4("8.8.8.8"), false);
  assert.equal(isPrivateIPv4("1.1.1.1"), false);
});

test("blocks private and special-purpose IPv6 ranges", () => {
  for (const ip of ["::", "::1", "fc00::1", "fd12::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "2001:db8::1", "2001:2::1", "2002::1", "64:ff9b::a00:1"]) {
    assert.equal(isPrivateIPv6(ip), true, ip);
  }
  assert.equal(isPrivateIPv6("2606:4700:4700::1111"), false);
});

test("rejects non-web protocols, credentials, local names and private IP literals", async () => {
  for (const url of [
    "file:///etc/passwd",
    "ftp://example.com",
    "https://user:pass@example.com",
    "http://localhost",
    "http://router.local",
    "http://metadata.google.internal",
    "http://127.0.0.1",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "http://[fd00::1]/"
  ]) {
    await assert.rejects(validateTarget(url), undefined, url);
  }
});

test("normalizes valid public web URLs", async () => {
  assert.equal(await validateTarget("https://example.com/path"), "https://example.com/path");
});
