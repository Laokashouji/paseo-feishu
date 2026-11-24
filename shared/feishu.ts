/**
 * paseo-feishu 的 RPC 契约（前后端共用）。
 *
 * RPC 名规则由宿主强制：/^[a-z][a-z0-9._-]*$/ —— 全小写，动词短语用 `-` 连接。
 * 大写字母会让插件在 reload 时直接报 "Invalid plugin RPC method"。
 */
import { defineRpc, PluginAttachmentSearchPayloadSchema } from "@getpaseo/plugin";
import { z } from "zod";

// ============ 飞书 / Lark 原生能力 ============

const chatItem = z.object({
  id: z.string(),
  name: z.string(),
  mode: z.string(),
  targetType: z.string().optional(),
  external: z.boolean().optional(),
  appLink: z.string().optional(),
  /** 本地记录的最近附加时间（ISO），没附加过则缺省 */
  lastAttachedAt: z.string().optional(),
});

/**
 * 会话列表。分页拉取——首屏只拉一页，用户滚到底再点「加载更多」。
 */
export const listChats = defineRpc({
  name: "feishu.chats.list",
  input: z.object({
    pageSize: z.number().optional(),
    pageToken: z.string().optional(),
  }),
  output: z.object({
    chats: z.array(chatItem),
    hasMore: z.boolean(),
    nextPageToken: z.string().optional(),
  }),
});

/**
 * 服务端搜索会话。
 *
 * 飞书 / Lark 的 `im +chat-search` 只覆盖群聊和话题群，搜不到单聊（p2p）。
 * 单聊由后端从最近活跃会话分页中做本地过滤补充，并用 scope 标明来源。
 */
export const searchChats = defineRpc({
  name: "feishu.chats.search",
  input: z.object({ query: z.string() }),
  output: z.object({
    chats: z.array(chatItem),
    /** server = 服务端搜索命中（仅群聊）；local = 本地过滤兜底；mixed = 两者合并 */
    scope: z.enum(["server", "local", "mixed"]),
    error: z.string().optional(),
  }),
});

export const listTasks = defineRpc({
  name: "feishu.tasks.list",
  input: z.object({ completed: z.boolean().optional() }),
  output: z.object({
    available: z.boolean(),
    error: z.string().optional(),
    tasks: z.array(
      z.object({
        guid: z.string(),
        summary: z.string(),
        dueAt: z.string().optional(),
        createdAt: z.string().optional(),
        url: z.string().optional(),
        overdue: z.boolean().optional(),
      }),
    ),
  }),
});

export const getAgenda = defineRpc({
  name: "feishu.agenda.get",
  input: z.object({ start: z.string().optional(), end: z.string().optional() }),
  output: z.object({
    available: z.boolean(),
    error: z.string().optional(),
    events: z.array(
      z.object({
        id: z.string(),
        summary: z.string(),
        start: z.string().optional(),
        end: z.string().optional(),
        allDay: z.boolean().optional(),
        location: z.string().optional(),
        isVc: z.boolean().optional(),
      }),
    ),
  }),
});

// ============ 附件源 ============

export const searchFeishu = defineRpc({
  name: "feishu.search",
  input: z.object({ query: z.string() }),
  output: PluginAttachmentSearchPayloadSchema,
});

/** 记录一次附加，用于会话排序「最近附加过优先」。 */
export const recordAttach = defineRpc({
  name: "feishu.attach.record",
  input: z.object({ chatId: z.string() }),
  output: z.object({ ok: z.boolean() }),
});

// ============ UI 状态 ============

/** 只记导航位置。轮询等配置在 settings。 */
const uiStateShape = z.object({
  activeTab: z.enum(["chats", "tasks", "agenda"]).optional(),
});

export const getUiState = defineRpc({
  name: "feishu.uistate.get",
  input: z.object({}),
  output: uiStateShape,
});

export const setUiState = defineRpc({
  name: "feishu.uistate.set",
  input: uiStateShape,
  output: z.object({ ok: z.boolean() }),
});

// ============ 插件设置 ============

/**
 * 单个来源（会话 / 待办 / 日程）的新对话配置。
 * 三类信息的处理方式不同：会话常需多轮查消息，待办偏向执行，日程偏向会前准备。
 */
const sourceLaunchConfig = z.object({
  /** 新对话开在哪：复用默认工作区 / 每次新建 workspace / 固定一个 */
  workspaceMode: z.enum(["reuse", "new", "fixed"]).optional(),
  /** reuse / new 模式下的默认目录；留空则自动使用 Paseo 首个可用工作区目录 */
  defaultDirectory: z.string().optional(),
  fixedWorkspaceId: z.string().optional(),
  /** "provider/model" 完整串。留空则自动选择 Paseo 默认可用模型 */
  provider: z.string().optional(),
  /** 思考强度。挂在 model 上，各 model 可选项不同 */
  thinkingOptionId: z.string().optional(),
  /** 权限等级。挂在 provider 上，各 provider 差异很大 */
  modeId: z.string().optional(),
  /** 附在正文后的一句话，告诉 agent 拿到这些信息要做什么 */
  openingLine: z.string().optional(),
});

const pluginSettingsShape = z.object({
  /** 自动刷新间隔（毫秒）。0 = 不轮询 */
  pollIntervalMs: z.number().optional(),
  chat: sourceLaunchConfig.optional(),
  task: sourceLaunchConfig.optional(),
  agenda: sourceLaunchConfig.optional(),
});

export const getSettings = defineRpc({
  name: "feishu.settings.get",
  input: z.object({}),
  output: pluginSettingsShape,
});

export const setSettings = defineRpc({
  name: "feishu.settings.set",
  input: pluginSettingsShape,
  output: z.object({ ok: z.boolean() }),
});

/** 组装某条信息的首条 prompt。创建 agent 在前端做（需要 client 侧 navigation 与 composer 控制）。 */
export const buildPrompt = defineRpc({
  name: "feishu.prompt.build",
  input: z.object({
    kind: z.enum(["chat", "task", "agenda"]),
    id: z.string(),
    title: z.string(),
  }),
  output: z.object({
    ok: z.boolean(),
    title: z.string(),
    text: z.string(),
    error: z.string().optional(),
  }),
});
