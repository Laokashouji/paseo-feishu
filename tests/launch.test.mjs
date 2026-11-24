import assert from "node:assert/strict";
import test from "node:test";
import { createConversation } from "../client/launch.ts";

function setup({ sendError, missingFixed = false, empty = false } = {}) {
  const calls = [];
  const agent = {
    id: "agent-1",
    send: async (text) => {
      calls.push(["send", text]);
      if (sendError) throw new Error("connection lost");
    },
  };
  const workspace = (id) => ({
    id,
    directory: "/repo",
    refresh: async () => (missingFixed ? null : { id, status: "done", archivingAt: null }),
    agents: {
      create: async (options) => {
        calls.push(["agent", id, options]);
        return agent;
      },
    },
  });
  const paseo = {
    workspaces: {
      list: async () => ({ entries: empty ? [] : [{ id: "existing" }] }),
      ref: (value) => workspace(typeof value === "string" ? value : value.id),
      open: async (cwd) => {
        calls.push(["open", cwd]);
        return workspace("reused");
      },
      create: async (options) => {
        calls.push(["workspace", options]);
        return workspace("fresh");
      },
    },
  };
  return { paseo, calls, agent };
}

const input = {
  title: "测试会话",
  text: "用户编辑后的首条消息",
  kind: "chat",
  defaultDirectory: "/workspace",
  config: { provider: "codex/model", modeId: "read-only" },
};

test("固定工作区按 ID 复用，发送编辑后的消息，不通过 cwd 新建工作区", async () => {
  const { paseo, calls, agent } = setup();
  assert.equal(
    await createConversation(paseo, { ...input, workspaceMode: "fixed", fixedWorkspaceId: "chosen" }),
    agent,
  );
  assert.deepEqual(
    calls.map(([name]) => name),
    ["agent", "send"],
  );
  assert.equal(calls[0][1], "chosen");
  assert.equal(calls[0][2].config.modeId, "read-only");
  assert.deepEqual(calls[0][2].labels, { source: "feishu-bridge", feishuKind: "chat" });
  assert.deepEqual(calls[1], ["send", input.text]);
});

test("每次新建通过 workspace.create 创建独立工作区再创建对话", async () => {
  const { paseo, calls } = setup();
  await createConversation(paseo, { ...input, workspaceMode: "new" });
  assert.deepEqual(
    calls.map(([name]) => name),
    ["workspace", "agent", "send"],
  );
  assert.deepEqual(calls[0][1], { title: input.title, source: { kind: "directory", path: "/workspace" } });
  assert.equal(calls[1][1], "fresh");
});

test("默认复用模式优先使用配置的默认目录，缺省时回退到 Paseo 可用工作区目录", async () => {
  for (const [dir, expected] of [
    ["/workspace", "/workspace"],
    [undefined, "/repo"],
  ]) {
    const { paseo, calls } = setup();
    await createConversation(paseo, { ...input, defaultDirectory: dir });
    assert.deepEqual(calls[0], ["open", expected]);
  }
});

test("空消息、丢失的固定工作区和无目录均不产生创建或发送", async () => {
  for (const [overrides, fixture] of [
    [{ text: "  " }, {}],
    [{ workspaceMode: "fixed" }, {}],
    [{ workspaceMode: "fixed", fixedWorkspaceId: "missing" }, { missingFixed: true }],
    [{ defaultDirectory: undefined }, { empty: true }],
  ]) {
    const { paseo, calls } = setup(fixture);
    await assert.rejects(createConversation(paseo, { ...input, ...overrides }));
    assert.deepEqual(calls, []);
  }
});

test("发送失败保留可定位的对话信息，不自动重发或新建第二个对话", async () => {
  const { paseo, calls } = setup({ sendError: true });
  await assert.rejects(createConversation(paseo, input), /发送未确认.*agent-1/u);
  assert.equal(calls.filter(([name]) => name === "agent").length, 1);
  assert.equal(calls.filter(([name]) => name === "send").length, 1);
});

test("草稿模式只创建空对话并预填到原生输入框，不调用 agent.send，支持延迟就绪的输入框句柄", async () => {
  const { paseo, calls, agent } = setup();
  const events = [];
  let attempts = 0;
  const composer = {
    setPrompt(text) {
      events.push(["setPrompt", text]);
    },
    async focus() {
      events.push(["focus"]);
    },
  };
  const result = await createConversation(paseo, {
    ...input,
    sourceId: "oc_123",
    delivery: "draft",
    openAgent: (agentId) => events.push(["openAgent", agentId]),
    composers: ({ agentId }) => {
      attempts += 1;
      return agentId === "agent-1" && attempts >= 2 ? [composer] : [];
    },
    draftTimeoutMs: 300,
  });
  assert.equal(result, agent);
  assert.deepEqual(
    calls.map(([name]) => name),
    ["open", "agent"],
  );
  assert.deepEqual(calls[1][2].metadata, {
    "feishu-bridge.kind": "chat",
    "feishu-bridge.sourceId": "oc_123",
  });
  assert.deepEqual(events, [
    ["openAgent", "agent-1"],
    ["setPrompt", input.text],
    ["focus"],
  ]);
});

test("草稿模式下输入框超时未就绪时保留已建对话 ID 且不发送消息", async () => {
  const { paseo, calls } = setup();
  await assert.rejects(
    createConversation(paseo, {
      ...input,
      delivery: "draft",
      composers: () => [],
      draftTimeoutMs: 50,
    }),
    /输入框尚未就绪.*agent-1/u,
  );
  assert.equal(calls.filter(([name]) => name === "agent").length, 1);
  assert.equal(calls.filter(([name]) => name === "send").length, 0);
});
