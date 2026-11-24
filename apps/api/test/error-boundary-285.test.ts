import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import type { AddressInfo } from "node:net";
import { createApiServer, clearAgents } from "../src/index.js";
import { API_ERRORS } from "../src/error-codes.js";
import { DevAuthProvider } from "@4evergent/shared";
import {
  InMemoryActivityStore,
  InMemoryAgentStore,
  InMemoryApprovalStore,
  InMemoryExecutionStore,
  InMemoryScheduleStore,
} from "@4evergent/database";
import { apiFetch, MockSigner } from "./helpers.js";

// Regression tests for issue #285: an unexpected throw in a routed handler
// must return a 500 in the standard error envelope instead of hanging the
// request, and a failing approve enqueue must return 500 instead of a
// false 200 claiming the execution was queued.

beforeEach(() => {
  clearAgents();
});

const TEST_AGENT = {
  id: "test-agent",
  displayName: "Test Agent",
  description: "test agent",
  ownerId: "test",
  stellarAddress: "GDI73WJ4SX7LOG3XZDJC3KCK6ED6E5NBYK2JUBQSPBCNNWEG3ZN7T75U",
  capabilities: ["payment"],
  status: "active" as const,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  active: true,
  metadata: {},
};

const POLICY_RULES = {
  maxTxAmount: { XLM: "1000" },
  requireHumanApprovalForAmountAbove: "10",
};

async function listen(
  server: Awaited<ReturnType<typeof createApiServer>>,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const http = server.server.listen(0, "127.0.0.1", () => {
      const addr = http.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () => server.close(),
      });
    });
  });
}

async function post(baseUrl: string, path: string, body: unknown) {
  const res = await apiFetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, body: await res.json() };
}

test("API_ERRORS defines INTERNAL_ERROR with status 500 and generic message", () => {
  assert.deepEqual(API_ERRORS.INTERNAL_ERROR, {
    status: 500,
    message: "internal_error",
    description: "An unexpected server error occurred.",
  });
});

test("unexpected throw in routed handler returns 500 INTERNAL_ERROR with X-Request-Id and no leaked internals", async () => {
  // The store throws with an internal-looking message; the client must
  // never see it.
  class FailingAgentStore extends InMemoryAgentStore {
    override async listByOwner(): Promise<never> {
      throw new Error(
        "SQLITE_CORRUPT: secret internal database path /var/data/prod.db",
      );
    }
  }

  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer: new MockSigner("err-boundary"),
    authProvider: new DevAuthProvider({ defaultOwnerId: "test" }),
    agentStore: new FailingAgentStore(),
    deferExecution: true,
  });

  const { baseUrl, close } = await listen(server);
  try {
    const res = await apiFetch(`${baseUrl}/agents`, {
      headers: { "X-Request-Id": "req-boundary-285" },
    });
    assert.equal(res.status, 500);
    assert.equal(res.headers.get("x-request-id"), "req-boundary-285");
    const body = (await res.json()) as Record<string, unknown>;
    assert.deepEqual(body, { code: "INTERNAL_ERROR", error: "internal_error" });
    assert.ok(!JSON.stringify(body).includes("SQLITE_CORRUPT"));
    assert.ok(!JSON.stringify(body).includes("/var/data/prod.db"));
  } finally {
    await close();
  }
});

test("approve with a failing queue store returns 500 and does not claim the execution was queued", async () => {
  // Only the write path fails: reads still work, so the approval can be
  // created and claimed, and only the enqueue throws.
  class FailingExecutionStore extends InMemoryExecutionStore {
    override async record(): Promise<never> {
      throw new Error("queue store unavailable");
    }
  }

  const executionStore = new FailingExecutionStore();
  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer: new MockSigner("err-boundary"),
    policyRules: POLICY_RULES,
    authProvider: new DevAuthProvider({ defaultOwnerId: "test" }),
    activityStore: new InMemoryActivityStore(),
    executionStore,
    approvalStore: new InMemoryApprovalStore(),
    scheduleStore: new InMemoryScheduleStore(),
    executionQueue: { enabled: true, intervalMs: 10_000 },
  });
  server.registerAgent(TEST_AGENT);

  const { baseUrl, close } = await listen(server);
  try {
    const intentRes = await post(baseUrl, "/agents/test-agent/intents", {
      type: "payment",
      asset: "XLM",
      destination: Keypair.random().publicKey(),
      amount: "50",
      reason: "error boundary approve test",
    });
    assert.equal(intentRes.status, 202);
    const approvalId = intentRes.body.approvalId as string;
    assert.ok(approvalId);

    const approveRes = await post(
      baseUrl,
      `/approvals/${approvalId}/approve`,
      {},
    );
    assert.equal(approveRes.status, 500);
    assert.equal(approveRes.body.code, "INTERNAL_ERROR");
    assert.ok(
      !JSON.stringify(approveRes.body).includes("queued for execution"),
    );

    // The execution was never recorded in the queue store.
    assert.equal(
      await executionStore.getByApprovalId(approvalId),
      null,
    );
  } finally {
    await close();
  }
});
