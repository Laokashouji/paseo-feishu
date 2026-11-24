/**
 * paseo-feishu 侧边栏面板与设置页。
 *
 * 提供飞书 / Lark 的会话、待办与今日日程浏览，以及带预览确认的一键新建对话。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { Modal } from "@getpaseo/plugin/client/react-native";
import {
  buildPrompt,
  getAgenda,
  getSettings,
  getUiState,
  listChats,
  listTasks,
  searchChats,
  setSettings,
  setUiState,
} from "../shared/feishu";
import { createConversation } from "./launch";
import { LoadError, LoadingState } from "./loading";
import { chatsQueryOptions, listQueryDefaults, requireAvailable, uniqueChats } from "./queries";

type Theme = PluginSurfaceProps["theme"];
type Layout = PluginSurfaceProps["layout"];
type TabKey = "chats" | "tasks" | "agenda";
type SourceKind = "chat" | "task" | "agenda";
type PluginNavigation = PluginSurfaceProps["navigation"];

type SourceLaunchConfig = {
  workspaceMode?: "reuse" | "new" | "fixed";
  defaultDirectory?: string;
  fixedWorkspaceId?: string;
  /** "provider/model" 完整串 */
  provider?: string;
  thinkingOptionId?: string;
  modeId?: string;
  openingLine?: string;
};

/** 三类信息的默认开场白——对应不同的协作场景。 */
const DEFAULT_OPENING: Record<SourceKind, string> = {
  chat: "先用上面的命令读一下这个会话的最近消息，了解在聊什么，然后等我提问。",
  task: "帮我分析这个待办要做什么，需要的话先查相关资料，然后给我一个执行方案。",
  agenda: "帮我准备这个会议：整理议题、可能要用的材料，以及我该提前想清楚的问题。",
};

const SOURCE_LABEL: Record<SourceKind, string> = { chat: "会话", task: "待办", agenda: "日程" };

const LAUNCH_FALLBACK: Required<Pick<SourceLaunchConfig, "workspaceMode">> = {
  workspaceMode: "reuse",
};

/** 轮询档位。0 = 不轮询。 */
const POLL_OPTIONS: { ms: number; label: string }[] = [
  { ms: 0, label: "不轮询" },
  { ms: 5_000, label: "5 秒" },
  { ms: 10_000, label: "10 秒" },
  { ms: 30_000, label: "30 秒" },
  { ms: 60_000, label: "1 分钟" },
];

// ============ 样式 ============

function useStyles(theme: Theme, layout: Layout) {
  const c = theme.colors;
  const pad = layout.compact ? 14 : 20;
  return useMemo(
    () => ({
      screen: { flex: 1, padding: pad, gap: layout.compact ? 10 : 14, backgroundColor: c.surface0 },
      row: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8, alignItems: "center" as const },
      rowBetween: {
        flexDirection: "row" as const,
        justifyContent: "space-between" as const,
        alignItems: "center" as const,
        gap: 8,
      },

      // Tab chip
      chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, backgroundColor: c.foreground + "14" },
      chipActive: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, backgroundColor: c.accent },
      chipText: { color: c.foreground, fontSize: 13 },
      chipTextActive: { color: c.accentForeground, fontSize: 13, fontWeight: "600" as const },

      // 小按钮
      smallBtn: {
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: 6,
        backgroundColor: c.foreground + "12",
      },
      smallBtnText: { color: c.foreground, fontSize: 12 },
      primaryBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6, backgroundColor: c.accent },
      primaryBtnText: { color: c.accentForeground, fontSize: 12, fontWeight: "600" as const },

      // 卡片
      card: {
        borderRadius: 10,
        padding: 12,
        gap: 8,
        backgroundColor: c.foreground + "08",
        borderWidth: 1,
        borderColor: c.foregroundMuted + "22",
      },
      sectionLabel: {
        color: c.foregroundMuted,
        fontSize: 11,
        fontWeight: "600" as const,
        textTransform: "uppercase" as const,
        letterSpacing: 0.5,
        marginTop: 4,
      },

      // 配置行
      cfgRow: {
        paddingVertical: 8,
        borderBottomWidth: 1,
        borderBottomColor: c.foregroundMuted + "1A",
        gap: 6,
      },
      cfgLabel: { color: c.foreground, fontSize: 13 },
      cfgHint: { color: c.foregroundMuted, fontSize: 11 },

      // 选项按钮
      opt: {
        paddingHorizontal: 9,
        paddingVertical: 4,
        borderRadius: 6,
        backgroundColor: c.foreground + "10",
      },
      optActive: { paddingHorizontal: 9, paddingVertical: 4, borderRadius: 6, backgroundColor: c.accent },
      optText: { color: c.foreground, fontSize: 12 },
      optTextActive: { color: c.accentForeground, fontSize: 12, fontWeight: "600" as const },

      // 输入框
      searchInput: {
        borderWidth: 1,
        borderColor: c.foregroundMuted + "44",
        borderRadius: 6,
        paddingHorizontal: 8,
        paddingVertical: 4,
        color: c.foreground,
        fontSize: 12,
        minWidth: 140,
        flex: 1,
      },
      wideInput: {
        borderWidth: 1,
        borderColor: c.foregroundMuted + "44",
        borderRadius: 6,
        paddingHorizontal: 8,
        paddingVertical: 5,
        color: c.foreground,
        fontSize: 12,
      },
      textArea: {
        borderWidth: 1,
        borderColor: c.foregroundMuted + "44",
        borderRadius: 6,
        paddingHorizontal: 8,
        paddingVertical: 6,
        color: c.foreground,
        fontSize: 12,
        minHeight: 56,
        textAlignVertical: "top" as const,
      },

      // 列表项
      item: {
        paddingVertical: 9,
        borderBottomWidth: 1,
        borderBottomColor: c.foregroundMuted + "1A",
        flexDirection: "row" as const,
        alignItems: "flex-start" as const,
        gap: 8,
      },
      itemMain: { flex: 1, gap: 3 },
      itemTitle: { color: c.foreground, fontSize: 13 },
      itemMeta: { color: c.foregroundMuted, fontSize: 11 },

      // 一键新建对话
      askBtn: {
        paddingHorizontal: 9,
        paddingVertical: 5,
        borderRadius: 6,
        backgroundColor: c.accent + "22",
        borderWidth: 1,
        borderColor: c.accent + "55",
      },
      askBtnText: { color: c.accent, fontSize: 11, fontWeight: "600" as const },
      askBtnBusy: {
        paddingHorizontal: 9,
        paddingVertical: 5,
        borderRadius: 6,
        backgroundColor: c.foregroundMuted + "18",
      },
      askBtnBusyText: { color: c.foregroundMuted, fontSize: 11 },

      // 选择器字段与弹窗
      pickerField: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        borderWidth: 1,
        borderColor: c.foregroundMuted + "44",
        borderRadius: 6,
        paddingHorizontal: 10,
        paddingVertical: 7,
        gap: 8,
      },
      pickerValue: { color: c.foreground, fontSize: 12, flex: 1 },
      pickerPlaceholder: { color: c.foregroundMuted, fontSize: 12, flex: 1 },
      pickerCaret: { color: c.foregroundMuted, fontSize: 10 },
      pickerClear: { paddingVertical: 2 },
      pickerClearText: { color: c.foregroundMuted, fontSize: 11 },
      pickerScroll: { maxHeight: 380 },
      pickerRow: { paddingHorizontal: 10, paddingVertical: 8, borderRadius: 6 },
      pickerRowActive: {
        paddingHorizontal: 10,
        paddingVertical: 8,
        borderRadius: 6,
        backgroundColor: c.accent + "22",
      },
      pickerRowText: { color: c.foreground, fontSize: 13 },
      pickerRowTextActive: { color: c.accent, fontSize: 13, fontWeight: "600" as const },
      pickerRowHint: { color: c.foregroundMuted, fontSize: 11 },

      loadMore: {
        paddingVertical: 10,
        alignItems: "center" as const,
        borderRadius: 8,
        backgroundColor: c.foreground + "0C",
      },
      loadMoreText: { color: c.foreground, fontSize: 12 },

      // 标签
      tag: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, backgroundColor: c.foreground + "14" },
      tagText: { color: c.foregroundMuted, fontSize: 10 },
      tagWarn: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, backgroundColor: c.statusDanger + "22" },
      tagWarnText: { color: c.statusDanger, fontSize: 10 },

      empty: { color: c.foregroundMuted, fontSize: 12, paddingVertical: 12 },
      errorText: { color: c.statusDanger, fontSize: 12 },
      mono: { color: c.foregroundMuted, fontSize: 11, fontFamily: "monospace" },
    }),
    [c, pad, layout.compact],
  );
}
type Styles = ReturnType<typeof useStyles>;

// ============ 时间格式化 ============

/** ISO → HH:MM */
function hhmm(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(11, 16);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** ISO → MM-DD HH:MM */
function shortTime(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 16);
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hhmm(iso)}`;
}

function todayRange(): { start: string; end: string } {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  // 使用本地时区偏移，避免 UTC 跨天误差
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const oh = String(Math.floor(Math.abs(off) / 60)).padStart(2, "0");
  const om = String(Math.abs(off) % 60).padStart(2, "0");
  const tz = `${sign}${oh}:${om}`;
  return { start: `${y}-${m}-${day}T00:00:00${tz}`, end: `${y}-${m}-${day}T23:59:59${tz}` };
}

// ============ Provider / 模型选择 ============

async function listAvailableProviders(paseo: ReturnType<typeof usePaseo>): Promise<string[]> {
  const av = await paseo.providers.listAvailable();
  const list = ((av as unknown as { providers?: unknown[] }).providers ?? []) as Array<
    Record<string, unknown>
  >;
  return list.filter((p) => p.available === true).map((p) => String(p.provider));
}

/** 查某个 provider 的 model 列表，连带每个 model 的 thinkingOptions。 */
async function fetchModels(paseo: ReturnType<typeof usePaseo>, provider: string) {
  const r = await paseo.providers.listModels(provider as never);
  const list = ((r as unknown as { models?: unknown[] }).models ?? r) as Array<
    Record<string, unknown>
  >;
  return (Array.isArray(list) ? list : []).map((m) => ({
    id: String(m.id ?? ""),
    label: typeof m.label === "string" ? m.label : String(m.id ?? ""),
    isDefault: m.isDefault === true,
    thinkingOptions: (Array.isArray(m.thinkingOptions) ? m.thinkingOptions : []).map(
      (t: Record<string, unknown>) => ({
        id: String(t.id ?? ""),
        label: typeof t.label === "string" ? t.label : String(t.id ?? ""),
        description: typeof t.description === "string" ? t.description : undefined,
        isDefault: t.isDefault === true,
      }),
    ),
  }));
}

/** 从 Paseo 当前可用 provider 中自动挑选一个默认 "provider/model"。 */
async function resolveAutoProviderModel(paseo: ReturnType<typeof usePaseo>): Promise<string | undefined> {
  const providers = await listAvailableProviders(paseo);
  for (const provider of providers) {
    try {
      const models = await fetchModels(paseo, provider);
      const pick = models.find((m) => m.isDefault) ?? models[0];
      if (pick?.id) return `${provider}/${pick.id}`;
    } catch {
      // 跳过暂时不可查询模型的 provider
    }
  }
  return undefined;
}

/**
 * 校验存下来的思考强度和权限模式在当前 model/provider 上还有效，
 * 避免切换模型后传入失效 ID 被 daemon 静默忽略。
 */
async function validateRunOptions(
  paseo: ReturnType<typeof usePaseo>,
  providerModel: string,
  cfg: SourceLaunchConfig,
): Promise<{ thinkingOptionId?: string; modeId?: string }> {
  const [providerName, ...rest] = providerModel.split("/");
  const modelId = rest.join("/");
  const out: { thinkingOptionId?: string; modeId?: string } = {};

  if (cfg.thinkingOptionId) {
    try {
      const models = await fetchModels(paseo, providerName);
      const m = models.find((x) => x.id === modelId);
      if (m?.thinkingOptions.some((o) => o.id === cfg.thinkingOptionId)) {
        out.thinkingOptionId = cfg.thinkingOptionId;
      }
    } catch {
      // 查不到就不传，让 provider 使用默认
    }
  }

  if (cfg.modeId) {
    try {
      const r = await paseo.providers.listModes(providerName as never);
      const modes = ((r as unknown as { modes?: unknown[] }).modes ?? []) as Array<
        Record<string, unknown>
      >;
      if (modes.some((x) => x.id === cfg.modeId)) out.modeId = cfg.modeId;
    } catch {
      // 同上
    }
  }
  return out;
}

/** 通用弹窗单选列表。provider / model / 思考强度 / 权限四个选择器共用。 */
function PickerModal(props: {
  theme: Theme;
  styles: Styles;
  title: string;
  open: boolean;
  onClose: () => void;
  loading: boolean;
  error: boolean;
  options: Array<{ id: string; label: string; hint?: string; tier?: string }>;
  value: string | undefined;
  onPick: (id: string) => void;
  searchThreshold?: number;
}) {
  const { theme, styles, title, open, onClose, loading, error, options, value, onPick } = props;
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? options.filter(
        (o) => o.id.toLowerCase().includes(needle) || o.label.toLowerCase().includes(needle),
      )
    : options;

  return (
    <Modal
      title={title}
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setFilter("");
          onClose();
        }
      }}
    >
      <Modal.Content>
        {options.length > (props.searchThreshold ?? 12) ? (
          <TextInput
            accessibilityLabel="过滤选项"
            style={styles.wideInput}
            value={filter}
            onChangeText={setFilter}
            placeholder={`在 ${options.length} 项里搜`}
            placeholderTextColor={theme.colors.foregroundMuted}
          />
        ) : null}
        {loading ? (
          <ActivityIndicator color={theme.colors.accent} />
        ) : error ? (
          <Text style={styles.errorText}>读取失败。</Text>
        ) : (
          <ScrollView style={styles.pickerScroll}>
            <View style={{ gap: 4 }}>
              {shown.slice(0, 60).map((o) => {
                const on = value === o.id;
                return (
                  <Pressable
                    key={o.id}
                    accessibilityRole="button"
                    accessibilityLabel={`选择 ${o.label}`}
                    onPress={() => {
                      setFilter("");
                      onPick(o.id);
                    }}
                    style={on ? styles.pickerRowActive : styles.pickerRow}
                  >
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text
                        style={on ? styles.pickerRowTextActive : styles.pickerRowText}
                        numberOfLines={1}
                      >
                        {o.label}
                        {o.tier === "dangerous" ? "  ⚠" : ""}
                      </Text>
                      {o.hint ? (
                        <Text style={styles.pickerRowHint} numberOfLines={2}>
                          {o.hint}
                        </Text>
                      ) : null}
                    </View>
                  </Pressable>
                );
              })}
              {shown.length > 60 ? (
                <Text style={styles.cfgHint}>
                  还有 {shown.length - 60} 项，输入关键词缩小范围。
                </Text>
              ) : null}
              {shown.length === 0 ? <Text style={styles.cfgHint}>没有匹配项。</Text> : null}
            </View>
          </ScrollView>
        )}
      </Modal.Content>
    </Modal>
  );
}

/** 模型、思考强度与权限等级的联动选择器。 */
function ModelSettings(props: {
  theme: Theme;
  styles: Styles;
  draft: SourceLaunchConfig;
  patch: (next: Partial<SourceLaunchConfig>) => void;
  autoDefault?: string;
}) {
  const { theme, styles, draft, patch, autoDefault } = props;
  const paseo = usePaseo();
  const [openPicker, setOpenPicker] = useState<"model" | "thinking" | "mode" | null>(null);
  const [drillProvider, setDrillProvider] = useState<string | null>(null);

  const effective = draft.provider || autoDefault;
  const providerName = effective?.split("/")[0];
  const modelId = effective?.split("/").slice(1).join("/");

  const providersQuery = useQuery({
    queryKey: ["feishu", "paseo-providers"],
    queryFn: () => listAvailableProviders(paseo),
    staleTime: 5 * 60_000,
  });

  const modelsQuery = useQuery({
    queryKey: ["feishu", "paseo-models", drillProvider],
    queryFn: () => fetchModels(paseo, drillProvider as string),
    enabled: !!drillProvider,
    staleTime: 5 * 60_000,
  });

  const currentModelsQuery = useQuery({
    queryKey: ["feishu", "paseo-models", providerName],
    queryFn: () => fetchModels(paseo, providerName as string),
    enabled: !!providerName,
    staleTime: 5 * 60_000,
  });
  const thinkingOptions =
    currentModelsQuery.data?.find((m) => m.id === modelId)?.thinkingOptions ?? [];

  const modesQuery = useQuery({
    queryKey: ["feishu", "paseo-modes", providerName],
    queryFn: async () => {
      const r = await paseo.providers.listModes(providerName as never);
      const list = ((r as unknown as { modes?: unknown[] }).modes ?? []) as Array<
        Record<string, unknown>
      >;
      return list.map((x) => ({
        id: String(x.id ?? ""),
        label: typeof x.label === "string" ? x.label : String(x.id ?? ""),
        hint: typeof x.description === "string" ? x.description : undefined,
        tier: typeof x.colorTier === "string" ? x.colorTier : undefined,
      }));
    },
    enabled: !!providerName,
    staleTime: 5 * 60_000,
  });
  const modes = modesQuery.data ?? [];

  const thinkingLabel = draft.thinkingOptionId
    ? (thinkingOptions.find((t) => t.id === draft.thinkingOptionId)?.label ??
      `${draft.thinkingOptionId}（当前模型不支持）`)
    : null;
  const modeLabel = draft.modeId
    ? (modes.find((m) => m.id === draft.modeId)?.label ?? `${draft.modeId}（当前 provider 不支持）`)
    : null;

  return (
    <>
      <View style={styles.cfgRow}>
        <Text style={styles.cfgLabel}>模型</Text>
        <Text style={styles.cfgHint}>
          {autoDefault
            ? `不选就自动使用当前可用模型：${autoDefault}`
            : "不选就自动使用 Paseo 默认可用模型"}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="选择模型"
          onPress={() => {
            setDrillProvider(null);
            setOpenPicker("model");
          }}
          style={styles.pickerField}
        >
          <Text
            style={draft.provider ? styles.pickerValue : styles.pickerPlaceholder}
            numberOfLines={1}
          >
            {draft.provider || "自动选择可用模型（点击指定）"}
          </Text>
          <Text style={styles.pickerCaret}>▾</Text>
        </Pressable>
        {draft.provider ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="恢复为自动选择可用模型"
            onPress={() =>
              patch({ provider: undefined, thinkingOptionId: undefined, modeId: undefined })
            }
            style={styles.pickerClear}
          >
            <Text style={styles.pickerClearText}>✕ 恢复自动默认</Text>
          </Pressable>
        ) : null}
      </View>

      {effective ? (
        <>
          <View style={styles.cfgRow}>
            <Text style={styles.cfgLabel}>思考强度</Text>
            <Text style={styles.cfgHint}>
              {thinkingOptions.length > 0
                ? "推理深度。不选就用这个模型的默认值。"
                : "这个模型没有可调的思考强度。"}
            </Text>
            {thinkingOptions.length > 0 ? (
              <>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="选择思考强度"
                  onPress={() => setOpenPicker("thinking")}
                  style={styles.pickerField}
                >
                  <Text
                    style={thinkingLabel ? styles.pickerValue : styles.pickerPlaceholder}
                    numberOfLines={1}
                  >
                    {thinkingLabel ?? "模型默认（点击选择）"}
                  </Text>
                  <Text style={styles.pickerCaret}>▾</Text>
                </Pressable>
                {draft.thinkingOptionId ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="恢复模型默认思考强度"
                    onPress={() => patch({ thinkingOptionId: undefined })}
                    style={styles.pickerClear}
                  >
                    <Text style={styles.pickerClearText}>✕ 用模型默认</Text>
                  </Pressable>
                ) : null}
              </>
            ) : null}
          </View>

          <View style={styles.cfgRow}>
            <Text style={styles.cfgLabel}>权限等级</Text>
            <Text style={styles.cfgHint}>
              Agent 能做什么。不选就用 provider 默认。带 ⚠ 的会跳过审批。
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="选择权限等级"
              onPress={() => setOpenPicker("mode")}
              style={styles.pickerField}
            >
              <Text
                style={modeLabel ? styles.pickerValue : styles.pickerPlaceholder}
                numberOfLines={1}
              >
                {modeLabel ?? "provider 默认（点击选择）"}
              </Text>
              <Text style={styles.pickerCaret}>▾</Text>
            </Pressable>
            {draft.modeId ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="恢复 provider 默认权限"
                onPress={() => patch({ modeId: undefined })}
                style={styles.pickerClear}
              >
                <Text style={styles.pickerClearText}>✕ 用 provider 默认</Text>
              </Pressable>
            ) : null}
          </View>
        </>
      ) : null}

      <PickerModal
        theme={theme}
        styles={styles}
        title={drillProvider ? `选择 ${drillProvider} 的模型` : "选择 provider"}
        open={openPicker === "model"}
        onClose={() => {
          setOpenPicker(null);
          setDrillProvider(null);
        }}
        loading={drillProvider ? modelsQuery.isLoading : providersQuery.isLoading}
        error={drillProvider ? modelsQuery.isError : providersQuery.isError}
        options={
          drillProvider
            ? (modelsQuery.data ?? []).map((m) => ({
                id: `${drillProvider}/${m.id}`,
                label: m.isDefault ? `${m.label}  ★ 默认` : m.label,
              }))
            : (providersQuery.data ?? []).map((p) => ({ id: p, label: p, hint: "点击查看模型" }))
        }
        value={drillProvider ? draft.provider : undefined}
        onPick={(id) => {
          if (!drillProvider) {
            setDrillProvider(id);
            return;
          }
          patch({ provider: id, thinkingOptionId: undefined, modeId: undefined });
          setOpenPicker(null);
          setDrillProvider(null);
        }}
      />

      <PickerModal
        theme={theme}
        styles={styles}
        title="选择思考强度"
        open={openPicker === "thinking"}
        onClose={() => setOpenPicker(null)}
        loading={currentModelsQuery.isLoading}
        error={currentModelsQuery.isError}
        options={thinkingOptions.map((t) => ({
          id: t.id,
          label: t.isDefault ? `${t.label}  ★ 默认` : t.label,
          hint: t.description,
        }))}
        value={draft.thinkingOptionId}
        onPick={(id) => {
          patch({ thinkingOptionId: id });
          setOpenPicker(null);
        }}
      />

      <PickerModal
        theme={theme}
        styles={styles}
        title="选择权限等级"
        open={openPicker === "mode"}
        onClose={() => setOpenPicker(null)}
        loading={modesQuery.isLoading}
        error={modesQuery.isError}
        options={modes}
        value={draft.modeId}
        onPick={(id) => {
          patch({ modeId: id });
          setOpenPicker(null);
        }}
      />
    </>
  );
}

// ============ 一键新建对话 ============

/** 补全 "provider/model"。未配置时自动从 Paseo 可用 provider 中选取默认模型。 */
async function resolveProviderModel(
  paseo: ReturnType<typeof usePaseo>,
  configured: string | undefined,
): Promise<string> {
  const raw = configured?.trim();
  if (raw) {
    if (raw.includes("/")) return raw;
    const list = await fetchModels(paseo, raw);
    const pick = list.find((m) => m.isDefault) ?? list[0];
    if (!pick?.id) {
      throw new Error(`provider ${raw} 没有可用 model，请在设置页填完整的 provider/model`);
    }
    return `${raw}/${pick.id}`;
  }
  const auto = await resolveAutoProviderModel(paseo);
  if (auto) return auto;
  throw new Error("没有可用的模型 provider，请先在 Paseo 配置至少一个可用 provider，或在飞书设置页手动指定模型");
}

function AskButton(props: {
  styles: Styles;
  kind: SourceKind;
  id: string;
  title: string;
  config: SourceLaunchConfig | undefined;
  navigation?: PluginNavigation;
  onNote: (text: string, error: boolean) => void;
}) {
  const { styles, kind, id, title, config, navigation, onNote } = props;
  const callBuild = useRpc(buildPrompt);
  const paseo = usePaseo();
  const [state, setState] = useState<"idle" | "busy" | "done" | "fail">("idle");
  const [preview, setPreview] = useState<{ title: string; text: string } | null>(null);
  const pending = useRef(false);

  async function prepare() {
    if (pending.current) return;
    pending.current = true;
    setState("busy");
    try {
      const brief = await callBuild({ kind, id, title });
      if (!brief.ok) throw new Error(brief.error ?? "组装内容失败");
      const opening = (config?.openingLine ?? DEFAULT_OPENING[kind]).trim();
      setPreview({ title: brief.title, text: opening ? `${brief.text}\n\n---\n\n${opening}` : brief.text });
      setState("idle");
    } catch (error) {
      setState("fail");
      onNote(error instanceof Error ? error.message : String(error), true);
    } finally {
      pending.current = false;
    }
  }

  async function confirm(delivery: "send" | "draft") {
    if (!preview || pending.current || !preview.text.trim()) return;
    pending.current = true;
    setState("busy");
    try {
      const providerModel = await resolveProviderModel(paseo, config?.provider);
      const options = await validateRunOptions(paseo, providerModel, config ?? {});
      let navigated = false;
      const openAgent = (agentId: string) => {
        if (!navigation) return;
        navigation.openAgent({ agentId });
        navigated = true;
      };
      const handle = await createConversation(paseo, {
        ...config,
        kind,
        sourceId: id,
        delivery,
        openAgent,
        title: preview.title,
        text: preview.text,
        config: { provider: providerModel, ...options },
      });
      if (!navigated) {
        try {
          openAgent(handle.id);
        } catch {
          // 对话已创建，导航失败仍可从侧边栏进入。
        }
      }
      setState("done");
      setPreview(null);
      if (delivery === "draft") {
        onNote(navigated ? "已打开新对话并填入输入框草稿" : "草稿已填入新对话，请从侧边栏打开查看", false);
      } else {
        onNote(navigated ? "已发送并打开新对话" : "已发送，请到侧边栏打开新对话", false);
      }
      setTimeout(() => setState("idle"), 3000);
    } catch (error) {
      setState("fail");
      setPreview(null);
      onNote(error instanceof Error ? error.message : String(error), true);
    } finally {
      pending.current = false;
    }
  }

  const label =
    state === "busy" ? "处理中…" : state === "done" ? "✓" : state === "fail" ? "✗" : "新对话";
  const busy = state === "busy" || state === "done";

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`为「${title}」新建对话`}
        disabled={busy}
        onPress={() => void prepare()}
        style={busy ? styles.askBtnBusy : styles.askBtn}
      >
        <Text style={busy ? styles.askBtnBusyText : styles.askBtnText}>{label}</Text>
      </Pressable>
      <Modal
        title="确认首条消息"
        open={preview !== null}
        onOpenChange={(open) => {
          if (!open && state !== "busy") setPreview(null);
        }}
      >
        <Modal.Content>
          <Text style={styles.cfgHint}>
            可先编辑信息和开场白。可选「创建并填入输入框」（跳转后在原生输入框继续编辑或加附件再发）或直接「创建并发送」。
          </Text>
          <TextInput
            accessibilityLabel="首条消息"
            multiline
            editable={state !== "busy"}
            value={preview?.text ?? ""}
            onChangeText={(text) => setPreview((value) => (value ? { ...value, text } : value))}
            style={[styles.textArea, { minHeight: 180 }]}
          />
          <View style={styles.row}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="取消创建"
              disabled={state === "busy"}
              onPress={() => setPreview(null)}
              style={styles.smallBtn}
            >
              <Text style={styles.smallBtnText}>取消</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="创建并填入输入框"
              disabled={state === "busy" || !preview?.text.trim()}
              onPress={() => void confirm("draft")}
              style={styles.smallBtn}
            >
              <Text style={styles.smallBtnText}>{state === "busy" ? "处理中…" : "创建并填入输入框"}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="创建并发送"
              disabled={state === "busy" || !preview?.text.trim()}
              onPress={() => void confirm("send")}
              style={styles.primaryBtn}
            >
              <Text style={styles.primaryBtnText}>{state === "busy" ? "处理中…" : "创建并发送"}</Text>
            </Pressable>
          </View>
        </Modal.Content>
      </Modal>
    </>
  );
}

// ============ Tab 1: 会话 ============

function ChatsTab(props: {
  theme: Theme;
  styles: Styles;
  launch: SourceLaunchConfig | undefined;
  navigation?: PluginNavigation;
  onNote: (t: string, e: boolean) => void;
}) {
  const { theme, styles, launch, navigation, onNote } = props;
  const callList = useRpc(listChats);
  const callSearch = useRpc(searchChats);

  const [keyword, setKeyword] = useState("");
  const [submitted, setSubmitted] = useState("");

  const q = useInfiniteQuery(chatsQueryOptions(callList, callSearch, submitted));
  const chats = useMemo(() => uniqueChats(q.data?.pages ?? []), [q.data]);
  const scope = q.data?.pages[0]?.scope;
  const hasMore = q.hasNextPage;

  function doSearch() {
    const term = keyword.trim();
    if (term === submitted) return;
    setSubmitted(term);
  }

  return (
    <View style={{ gap: 8 }}>
      <View style={styles.row}>
        <TextInput
          value={keyword}
          onChangeText={setKeyword}
          onSubmitEditing={() => void doSearch()}
          placeholder="搜索会话名"
          placeholderTextColor={theme.colors.foregroundMuted}
          style={styles.searchInput}
          accessibilityLabel="搜索会话"
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="搜索"
          disabled={keyword.trim() === submitted}
          accessibilityState={{ disabled: keyword.trim() === submitted }}
          onPress={() => void doSearch()}
          style={[styles.primaryBtn, { opacity: keyword.trim() === submitted ? 0.5 : 1 }]}
        >
          <Text style={styles.primaryBtnText}>搜索</Text>
        </Pressable>
        {submitted ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="清空搜索"
            onPress={() => {
              setKeyword("");
              setSubmitted("");
            }}
            style={styles.smallBtn}
          >
            <Text style={styles.smallBtnText}>清空</Text>
          </Pressable>
        ) : null}
      </View>

      {q.data ? (
        <View style={[styles.row, { minHeight: 22 }]}>
          {q.isFetching && !q.isFetchingNextPage ? (
            <ActivityIndicator size="small" color={theme.colors.accent} />
          ) : null}
          <Text style={styles.cfgHint}>
            {submitted
              ? `搜索「${submitted}」命中 ${chats.length} 个` +
                (scope === "server"
                  ? " · 仅群聊（飞书搜索 API 不支持单聊）"
                  : scope === "mixed"
                    ? " · 群聊来自服务端搜索，单聊从最近活跃里匹配"
                    : " · 服务端搜索不可用，仅匹配了最近活跃的会话")
              : `已加载 ${chats.length} 个${hasMore ? "（还有更多）" : "（全部）"} · 最近附加过的排最前`}
            {q.isFetching && !q.isFetchingNextPage ? " · 刷新中，仍显示上次结果" : ""}
          </Text>
        </View>
      ) : null}

      {q.isLoading ? (
        <LoadingState theme={theme} label={submitted ? `正在搜索「${submitted}」…` : "正在加载会话…"} />
      ) : null}
      {q.isError ? (
        <LoadError
          theme={theme}
          label={q.isFetchNextPageError ? "加载更多会话失败" : q.data ? "刷新失败，已保留上次结果" : "加载会话失败"}
          error={q.error}
          busy={q.isFetching}
          retry={() =>
            void (q.isFetchNextPageError
              ? q.fetchNextPage({ cancelRefetch: false })
              : q.refetch({ cancelRefetch: false }))
          }
        />
      ) : null}

      {chats.map((c) => (
        <View key={c.id} style={styles.item}>
          <View style={styles.itemMain}>
            <View style={styles.row}>
              <Text style={styles.itemTitle}>{c.name}</Text>
              <View style={styles.tag}>
                <Text style={styles.tagText}>
                  {c.mode === "p2p" ? (c.targetType === "bot" ? "机器人" : "单聊") : "群"}
                </Text>
              </View>
              {c.external ? (
                <View style={styles.tag}>
                  <Text style={styles.tagText}>外部</Text>
                </View>
              ) : null}
              {c.lastAttachedAt ? (
                <View style={styles.tag}>
                  <Text style={styles.tagText}>附加过</Text>
                </View>
              ) : null}
            </View>
          </View>
          <AskButton
            styles={styles}
            kind="chat"
            id={c.id}
            title={c.name}
            config={launch}
            navigation={navigation}
            onNote={onNote}
          />
        </View>
      ))}

      {hasMore && !submitted ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="加载更多会话"
          disabled={q.isFetching}
          accessibilityState={{ disabled: q.isFetching, busy: q.isFetchingNextPage }}
          onPress={() => void q.fetchNextPage({ cancelRefetch: false })}
          style={[styles.loadMore, { opacity: q.isFetching ? 0.6 : 1 }]}
        >
          <Text style={styles.loadMoreText}>{q.isFetchingNextPage ? "正在加载更多…" : "加载更多"}</Text>
        </Pressable>
      ) : null}

      {q.isSuccess && chats.length === 0 ? (
        <Text style={styles.empty}>{submitted ? "没有匹配的会话。" : "没有会话。"}</Text>
      ) : null}
    </View>
  );
}

// ============ Tab 2: 待办 ============

function TasksTab(props: {
  theme: Theme;
  styles: Styles;
  pollMs: number;
  launch: SourceLaunchConfig | undefined;
  navigation?: PluginNavigation;
  onNote: (t: string, e: boolean) => void;
}) {
  const { theme, styles, pollMs, launch, navigation, onNote } = props;
  const callList = useRpc(listTasks);
  const q = useQuery({
    ...listQueryDefaults,
    queryKey: ["feishu", "tasks"],
    queryFn: async () => requireAvailable(await callList({ completed: false })),
    refetchInterval: pollMs > 0 ? Math.max(pollMs, 30_000) : false,
  });

  if (q.isLoading) return <LoadingState theme={theme} label="正在加载待办…" />;
  const d = q.data;

  return (
    <View style={{ gap: 4 }}>
      {q.isError ? (
        <LoadError
          theme={theme}
          label={d ? "刷新失败，已保留上次待办" : "加载待办失败"}
          error={q.error}
          busy={q.isFetching}
          retry={() => void q.refetch({ cancelRefetch: false })}
        />
      ) : null}
      {d ? (
        <View style={[styles.row, { minHeight: 22 }]}>
          {q.isFetching ? <ActivityIndicator size="small" color={theme.colors.accent} /> : null}
          <Text style={styles.cfgHint}>
            {d.tasks.length} 项未完成{q.isFetching ? " · 刷新中…" : ""}
          </Text>
        </View>
      ) : null}
      {q.isSuccess && d?.tasks.length === 0 ? <Text style={styles.empty}>没有未完成的待办。</Text> : null}
      {d?.tasks.map((t) => (
        <View key={t.guid} style={styles.item}>
          <View style={styles.itemMain}>
            <Text style={styles.itemTitle}>{t.summary}</Text>
            {t.dueAt ? (
              <View style={styles.row}>
                <View style={t.overdue ? styles.tagWarn : styles.tag}>
                  <Text style={t.overdue ? styles.tagWarnText : styles.tagText}>
                    {t.overdue ? "已逾期 " : "截止 "}
                    {shortTime(t.dueAt)}
                  </Text>
                </View>
              </View>
            ) : null}
            {t.url ? (
              <Text style={styles.mono} selectable>
                {t.url}
              </Text>
            ) : null}
          </View>
          <AskButton
            styles={styles}
            kind="task"
            id={t.guid}
            title={t.summary}
            config={launch}
            navigation={navigation}
            onNote={onNote}
          />
        </View>
      ))}
    </View>
  );
}

// ============ Tab 3: 日程 ============

function AgendaTab(props: {
  theme: Theme;
  styles: Styles;
  pollMs: number;
  launch: SourceLaunchConfig | undefined;
  navigation?: PluginNavigation;
  onNote: (t: string, e: boolean) => void;
}) {
  const { theme, styles, pollMs, launch, navigation, onNote } = props;
  const callAgenda = useRpc(getAgenda);
  const range = useMemo(() => todayRange(), []);
  const q = useQuery({
    ...listQueryDefaults,
    queryKey: ["feishu", "agenda", range.start],
    queryFn: async () => requireAvailable(await callAgenda(range)),
    refetchInterval: pollMs > 0 ? Math.max(pollMs, 60_000) : false,
  });

  if (q.isLoading) return <LoadingState theme={theme} label="正在加载今日日程…" />;
  const d = q.data;

  return (
    <View style={{ gap: 4 }}>
      {q.isError ? (
        <LoadError
          theme={theme}
          label={d ? "刷新失败，已保留上次日程" : "加载日程失败"}
          error={q.error}
          busy={q.isFetching}
          retry={() => void q.refetch({ cancelRefetch: false })}
        />
      ) : null}
      {d ? (
        <View style={[styles.row, { minHeight: 22 }]}>
          {q.isFetching ? <ActivityIndicator size="small" color={theme.colors.accent} /> : null}
          <Text style={styles.cfgHint}>
            今天 {d.events.length} 项{q.isFetching ? " · 刷新中…" : ""}
          </Text>
        </View>
      ) : null}
      {q.isSuccess && d?.events.length === 0 ? <Text style={styles.empty}>今天没有日程。</Text> : null}
      {d?.events.map((e) => (
        <View key={e.id} style={styles.item}>
          <View style={styles.itemMain}>
            <View style={styles.row}>
              <Text style={styles.itemTitle}>{e.summary}</Text>
              {e.isVc ? (
                <View style={styles.tag}>
                  <Text style={styles.tagText}>视频会议</Text>
                </View>
              ) : null}
            </View>
            <Text style={styles.itemMeta}>
              {e.allDay ? "全天" : `${hhmm(e.start)} - ${hhmm(e.end)}`}
              {e.location ? ` · ${e.location}` : ""}
            </Text>
          </View>
          <AskButton
            styles={styles}
            kind="agenda"
            id={e.id}
            title={e.summary}
            config={launch}
            navigation={navigation}
            onNote={onNote}
          />
        </View>
      ))}
    </View>
  );
}

// ============ 设置页 ============

function SettingsTab(props: { theme: Theme; styles: Styles }) {
  const { theme, styles } = props;
  const callGet = useRpc(getSettings);
  const callSet = useRpc(setSettings);
  const paseo = usePaseo();
  const qc = useQueryClient();

  const q = useQuery({
    queryKey: ["feishu", "settings"],
    queryFn: () => callGet({}),
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: "always",
  });

  const autoModelQ = useQuery({
    queryKey: ["feishu", "auto-default-model"],
    queryFn: () => resolveAutoProviderModel(paseo),
    staleTime: 5 * 60_000,
    retry: false,
  });

  const wsQ = useQuery({
    queryKey: ["feishu", "paseo-workspaces"],
    queryFn: async () => {
      const list = await paseo.workspaces.list();
      const entries = (list as unknown as { entries?: unknown[] }).entries ?? [];
      return entries
        .map((e) => (e as { workspace?: Record<string, unknown> }).workspace ?? e)
        .map((w) => {
          const o = w as Record<string, unknown>;
          return { id: String(o.id ?? ""), name: String(o.name ?? o.title ?? o.id ?? "?") };
        })
        .filter((w) => w.id);
    },
  });

  const [draft, setDraft] = useState<Awaited<ReturnType<typeof callGet>> | null>(null);
  const [sub, setSub] = useState<SourceKind>("chat");
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);

  useEffect(() => {
    if (draft === null && !q.isLoading && q.data) setDraft(q.data);
  }, [draft, q.isLoading, q.data]);

  if (q.isError && draft === null) {
    return (
      <View style={styles.cfgRow}>
        <Text style={styles.cfgHint}>无法读取飞书插件设置：{q.error.message}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="重试加载设置"
          onPress={() => void q.refetch()}
          style={styles.smallBtn}
        >
          <Text style={styles.smallBtnText}>重试</Text>
        </Pressable>
      </View>
    );
  }
  if (q.isLoading || draft === null) return <LoadingState theme={theme} label="正在读取插件设置…" />;

  const cur: SourceLaunchConfig = draft[sub] ?? {};

  function patchSource(next: Partial<SourceLaunchConfig>) {
    setDraft((d) => ({ ...(d ?? {}), [sub]: { ...((d ?? {})[sub] ?? {}), ...next } }));
    setNote(null);
  }

  async function save() {
    setSaving(true);
    setNote(null);
    try {
      const r = await callSet(draft ?? {});
      if (!r.ok) throw new Error("写盘失败，请检查配置目录权限");
      await qc.refetchQueries({ queryKey: ["feishu", "settings"] });
      setNote({ text: "已保存", error: false });
    } catch (e) {
      setNote({ text: e instanceof Error ? e.message : String(e), error: true });
    } finally {
      setSaving(false);
    }
  }

  const wsMode = cur.workspaceMode ?? LAUNCH_FALLBACK.workspaceMode;
  const workspaces = wsQ.data ?? [];

  return (
    <View style={{ gap: 12 }}>
      <Text style={styles.sectionLabel}>自动刷新</Text>
      <View style={styles.card}>
        <Text style={styles.cfgHint}>每次刷新会调用 lark-cli 子进程，间隔太短会有开销</Text>
        <View style={styles.row}>
          {POLL_OPTIONS.map((o) => {
            const active = (draft.pollIntervalMs ?? 0) === o.ms;
            return (
              <Pressable
                key={o.ms}
                accessibilityRole="button"
                accessibilityLabel={`轮询设为 ${o.label}`}
                onPress={() => {
                  setDraft((d) => ({ ...(d ?? {}), pollIntervalMs: o.ms }));
                  setNote(null);
                }}
                style={active ? styles.optActive : styles.opt}
              >
                <Text style={active ? styles.optTextActive : styles.optText}>{o.label}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <Text style={styles.sectionLabel}>新对话配置</Text>
      <View style={styles.row}>
        {(["chat", "task", "agenda"] as const).map((k) => {
          const active = sub === k;
          return (
            <Pressable
              key={k}
              accessibilityRole="button"
              accessibilityLabel={`配置${SOURCE_LABEL[k]}的新对话`}
              onPress={() => setSub(k)}
              style={active ? styles.chipActive : styles.chip}
            >
              <Text style={active ? styles.chipTextActive : styles.chipText}>{SOURCE_LABEL[k]}</Text>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.card}>
        <View style={styles.cfgRow}>
          <Text style={styles.cfgLabel}>新对话开在哪</Text>
          <Text style={styles.cfgHint}>
            点{SOURCE_LABEL[sub]}右侧「新对话」时，新对话归属哪个工作区（新建工作区仍使用原目录，不复制或隔离文件）
          </Text>
          <View style={styles.row}>
            {(
              [
                ["reuse", "复用默认工作区"],
                ["new", "每次新建"],
                ["fixed", "固定一个"],
              ] as const
            ).map(([v, label]) => (
              <Pressable
                key={v}
                accessibilityRole="button"
                accessibilityLabel={`workspace 归属：${label}`}
                onPress={() => patchSource({ workspaceMode: v })}
                style={wsMode === v ? styles.optActive : styles.opt}
              >
                <Text style={wsMode === v ? styles.optTextActive : styles.optText}>{label}</Text>
              </Pressable>
            ))}
          </View>
        </View>

        {wsMode === "fixed" ? (
          <View style={styles.cfgRow}>
            <Text style={styles.cfgLabel}>选一个工作区</Text>
            {wsQ.isLoading ? (
              <ActivityIndicator color={theme.colors.accent} />
            ) : workspaces.length === 0 ? (
              <Text style={styles.cfgHint}>没有可用工作区</Text>
            ) : (
              <View style={styles.row}>
                {workspaces.map((w) => {
                  const active = cur.fixedWorkspaceId === w.id;
                  return (
                    <Pressable
                      key={w.id}
                      accessibilityRole="button"
                      accessibilityLabel={`固定工作区：${w.name}`}
                      onPress={() => patchSource({ fixedWorkspaceId: w.id })}
                      style={active ? styles.optActive : styles.opt}
                    >
                      <Text style={active ? styles.optTextActive : styles.optText}>{w.name}</Text>
                    </Pressable>
                  );
                })}
              </View>
            )}
          </View>
        ) : (
          <View style={styles.cfgRow}>
            <Text style={styles.cfgLabel}>默认目录（可选）</Text>
            <Text style={styles.cfgHint}>留空时自动使用 Paseo 首个可用工作区的目录</Text>
            <TextInput
              value={cur.defaultDirectory ?? ""}
              onChangeText={(v) => patchSource({ defaultDirectory: v || undefined })}
              placeholder="例如 /Users/you/workspace"
              placeholderTextColor={theme.colors.foregroundMuted}
              style={styles.wideInput}
              accessibilityLabel="默认目录"
            />
          </View>
        )}

        <ModelSettings
          theme={theme}
          styles={styles}
          draft={cur}
          patch={patchSource}
          autoDefault={autoModelQ.data ?? undefined}
        />

        <View style={styles.cfgRow}>
          <Text style={styles.cfgLabel}>开场白</Text>
          <Text style={styles.cfgHint}>附在{SOURCE_LABEL[sub]}信息后面，告诉 agent 要做什么</Text>
          <TextInput
            value={cur.openingLine ?? ""}
            onChangeText={(v) => patchSource({ openingLine: v })}
            placeholder={DEFAULT_OPENING[sub]}
            placeholderTextColor={theme.colors.foregroundMuted}
            multiline
            style={styles.textArea}
            accessibilityLabel="开场白"
          />
        </View>
      </View>

      <View style={styles.row}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="保存设置"
          disabled={saving}
          onPress={() => void save()}
          style={styles.primaryBtn}
        >
          <Text style={styles.primaryBtnText}>{saving ? "保存中…" : "保存"}</Text>
        </Pressable>
        {note ? (
          <Text style={note.error ? styles.errorText : styles.cfgHint}>{note.text}</Text>
        ) : null}
      </View>
    </View>
  );
}

// ============ 主面板 ============

export function FeishuPanel({
  theme,
  layout,
  navigation,
  openSettings,
}: PluginSurfaceProps & { openSettings: () => void }) {
  const styles = useStyles(theme, layout);
  const qc = useQueryClient();

  const callGetUi = useRpc(getUiState);
  const callSetUi = useRpc(setUiState);
  const callGetSettings = useRpc(getSettings);

  const [activeTab, setActiveTab] = useState<TabKey>("chats");
  const [restored, setRestored] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  const [countdown, setCountdown] = useState(0);
  const lastFetchRef = useRef(Date.now());

  // 面板位置和设置不设长缓存，避免关闭重开时读到旧存档。
  const uiQ = useQuery({
    queryKey: ["feishu", "uistate"],
    queryFn: () => callGetUi({}),
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: "always",
  });

  const settingsQ = useQuery({
    queryKey: ["feishu", "settings"],
    queryFn: () => callGetSettings({}),
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: "always",
  });

  const settings = settingsQ.data ?? {};
  const pollMs = settings.pollIntervalMs ?? 0;

  useEffect(() => {
    if (restored || uiQ.isLoading) return;
    if (uiQ.data?.activeTab) setActiveTab(uiQ.data.activeTab);
    setRestored(true);
  }, [restored, uiQ.isLoading, uiQ.data]);

  useEffect(() => {
    if (!restored) return;
    const t = setTimeout(() => {
      void callSetUi({ activeTab }).catch(() => {});
    }, 1_000);
    return () => clearTimeout(t);
  }, [restored, activeTab, callSetUi]);

  useEffect(() => {
    if (pollMs <= 0) return;
    const t = setInterval(() => {
      const left = Math.ceil((pollMs - (Date.now() - lastFetchRef.current)) / 1000);
      setCountdown(left > 0 ? left : 0);
    }, 1_000);
    return () => clearInterval(t);
  }, [pollMs]);

  useEffect(() => {
    lastFetchRef.current = Date.now();
    setCountdown(pollMs > 0 ? Math.ceil(pollMs / 1000) : 0);
  }, [pollMs]);

  async function refreshAll() {
    if (refreshing) return;
    setRefreshing(true);
    lastFetchRef.current = Date.now();
    try {
      await qc.refetchQueries(
        {
          type: "active",
          predicate: (q2) => {
            const k = q2.queryKey;
            return Array.isArray(k) && k[0] === "feishu" && k[1] !== "uistate" && k[1] !== "settings";
          },
        },
        { cancelRefetch: false },
      );
    } catch {
      // 各 query 自身的错误态会展示
    } finally {
      setRefreshing(false);
    }
  }

  function onNote(text: string, error: boolean) {
    setNote({ text, error });
    setTimeout(() => setNote(null), 5_000);
  }

  const tabs: { key: TabKey; label: string }[] = [
    { key: "chats", label: "会话" },
    { key: "tasks", label: "待办" },
    { key: "agenda", label: "日程" },
  ];

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <View style={styles.screen}>
        <View style={styles.rowBetween}>
          <View style={styles.row}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="刷新"
              disabled={refreshing}
              accessibilityState={{ disabled: refreshing, busy: refreshing }}
              onPress={refreshAll}
              style={styles.smallBtn}
            >
              <Text style={styles.smallBtnText}>{refreshing ? "刷新中…" : "↻ 刷新"}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="飞书插件设置"
              onPress={openSettings}
              style={styles.smallBtn}
            >
              <Text style={styles.smallBtnText}>⚙ 设置</Text>
            </Pressable>
            {pollMs > 0 ? <Text style={styles.cfgHint}>{countdown}s 后自动刷新</Text> : null}
          </View>
          {note ? (
            <Text style={note.error ? styles.errorText : styles.cfgHint}>{note.text}</Text>
          ) : null}
        </View>

        <View style={styles.row}>
          {tabs.map((t) => {
            const active = activeTab === t.key;
            return (
              <Pressable
                key={t.key}
                accessibilityRole="button"
                accessibilityLabel={`切到 ${t.label}`}
                onPress={() => {
                  setRestored(true);
                  setActiveTab(t.key);
                }}
                style={active ? styles.chipActive : styles.chip}
              >
                <Text style={active ? styles.chipTextActive : styles.chipText}>{t.label}</Text>
              </Pressable>
            );
          })}
        </View>

        {!restored ? <LoadingState theme={theme} label="正在打开飞书面板…" /> : null}
        {restored && activeTab === "chats" ? (
          <ChatsTab
            theme={theme}
            styles={styles}
            launch={settings.chat}
            navigation={navigation}
            onNote={onNote}
          />
        ) : null}
        {restored && activeTab === "tasks" ? (
          <TasksTab
            theme={theme}
            styles={styles}
            pollMs={pollMs}
            launch={settings.task}
            navigation={navigation}
            onNote={onNote}
          />
        ) : null}
        {restored && activeTab === "agenda" ? (
          <AgendaTab
            theme={theme}
            styles={styles}
            pollMs={pollMs}
            launch={settings.agenda}
            navigation={navigation}
            onNote={onNote}
          />
        ) : null}
      </View>
    </ScrollView>
  );
}

/** Paseo 管理标题、滚动和返回导航；此组件只渲染设置内容。 */
export function FeishuSettings({ theme, layout }: PluginSurfaceProps) {
  const styles = useStyles(theme, layout);
  return <SettingsTab theme={theme} styles={styles} />;
}
