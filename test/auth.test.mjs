import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { jwtAuthenticator } from "../dist/server.js";
test("JWT verifier accepts signed issuer/audience and rejects expired, foreign and forged tokens", async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test";
  jwk.alg = "RS256";
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const verify = jwtAuthenticator({
    jwksUrl: `http://127.0.0.1:${server.address().port}/jwks`,
    issuer: "https://issuer.example",
    audience: "platform",
  });
  const request = (token) =>
    new Request("https://platform.example", {
      headers: { Authorization: "Bearer " + token },
    });
  const sign = (
    issuer = "https://issuer.example",
    audience = "platform",
    expiry = "1h",
  ) =>
    new SignJWT({ email: "alice@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setSubject("alice")
      .setIssuer(issuer)
      .setAudience(audience)
      .setExpirationTime(expiry)
      .sign(privateKey);
  try {
    assert.equal((await verify(request(await sign()))).id, "alice");
    for (const token of [
      await sign("https://other.example"),
      await sign(undefined, "other"),
      await sign(undefined, undefined, "-1h"),
      "forged.token.value",
    ])
      await assert.rejects(
        () => verify(request(token)),
        (e) => e.status === 401,
      );
    assert.equal(await verify(new Request("https://platform.example")), null);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
