import type { PluginClientContext, PluginComposer, PluginComposerSelector } from "@getpaseo/plugin/client";

type PaseoApi = PluginClientContext["paseo"];
type PaseoAgentHandle = ReturnType<PaseoApi["agents"]["ref"]>;
type PaseoAgentConfig = Parameters<PaseoApi["agents"]["create"]>[0]["config"];

export type ComposerResolver = (selector: PluginComposerSelector) => readonly PluginComposer[];

let defaultComposers: ComposerResolver | null = null;

export function bindComposerResolver(resolver: ComposerResolver | null): () => void {
  defaultComposers = resolver;
  return () => {
    if (defaultComposers === resolver) defaultComposers = null;
  };
}

export type LaunchPlacement = {
  workspaceMode?: "reuse" | "new" | "fixed";
  defaultDirectory?: string;
  fixedWorkspaceId?: string;
};

export async function waitForAgentComposer(
  resolveComposers: ComposerResolver,
  agentId: string,
  timeoutMs = 2_000,
  intervalMs = 40,
): Promise<PluginComposer | null> {
  const immediate = resolveComposers({ agentId })[0];
  if (immediate) return immediate;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const found = resolveComposers({ agentId })[0];
    if (found) return found;
  }
  return resolveComposers({ agentId })[0] ?? null;
}

export async function createConversation(
  paseo: PaseoApi,
  input: LaunchPlacement & {
    title: string;
    text: string;
    kind: "chat" | "task" | "agenda";
    sourceId?: string;
    delivery?: "send" | "draft";
    openAgent?: (agentId: string) => void;
    composers?: ComposerResolver;
    draftTimeoutMs?: number;
    config: PaseoAgentConfig;
  },
): Promise<PaseoAgentHandle> {
  if (!input.text.trim()) throw new Error("消息不能为空");
  const delivery = input.delivery ?? "send";
  const resolveComposers = input.composers ?? defaultComposers;
  if (delivery === "draft" && !resolveComposers) {
    throw new Error("当前客户端暂不支持输入框草稿预填，请使用「创建并发送」");
  }

  const mode = input.workspaceMode ?? "reuse";
  let workspace;
  if (mode === "fixed") {
    if (!input.fixedWorkspaceId) throw new Error("请先在设置中选择固定工作区");
    workspace = paseo.workspaces.ref(input.fixedWorkspaceId);
    const snapshot = await workspace.refresh();
    if (!snapshot || snapshot.archivingAt) {
      throw new Error("固定工作区已不存在，请在设置中重新选择");
    }
  } else {
    let cwd = input.defaultDirectory?.trim() || undefined;
    if (!cwd) {
      const list = await paseo.workspaces.list();
      cwd = list.entries
        .map((entry) => paseo.workspaces.ref(entry).directory)
        .find((directory): directory is string => Boolean(directory));
    }
    if (!cwd) throw new Error("找不到可用目录，请先在 Paseo 建一个工作区或在设置中填写默认目录");
    // create 始终新建工作区；open 复用同目录工作区。新建工作区不会复制或隔离文件。
    workspace =
      mode === "new"
        ? await paseo.workspaces.create({ title: input.title, source: { kind: "directory", path: cwd } })
        : await paseo.workspaces.open(cwd);
  }

  const metadata = input.sourceId
    ? { "feishu-bridge.kind": input.kind, "feishu-bridge.sourceId": input.sourceId }
    : undefined;
  const agent = await workspace.agents.create({
    config: input.config,
    title: input.title,
    labels: { source: "feishu-bridge", feishuKind: input.kind },
    ...(metadata ? { metadata } : {}),
  });

  if (delivery === "draft") {
    try {
      input.openAgent?.(agent.id);
    } catch {
      // 即使导航调用失败，仍尝试通过 agentId 定位输入框句柄写入草稿。
    }
    const composer = await waitForAgentComposer(resolveComposers!, agent.id, input.draftTimeoutMs);
    if (!composer) {
      throw new Error(`对话已创建，但输入框尚未就绪。请打开「${input.title}」（${agent.id}）手动粘贴发送。`);
    }
    try {
      composer.setPrompt(input.text);
      await composer.focus().catch(() => undefined);
    } catch {
      throw new Error(`对话已创建，但草稿写入失败。请打开「${input.title}」（${agent.id}）后重新操作。`);
    }
    return agent;
  }

  try {
    await agent.send(input.text);
  } catch {
    // 不自动重发：断线时发送结果可能未知，用户应先查看已创建的对话。
    throw new Error(`对话已创建，但首条消息发送未确认。请到侧边栏查看「${input.title}」（${agent.id}），确认后再发送。`);
  }
  return agent;
}
