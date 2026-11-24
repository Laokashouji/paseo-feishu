import { Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { defineAttachmentSource } from "@getpaseo/plugin";
import {
  useRpc,
  type PluginClientContext,
  type PluginScreenProps,
  type PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { bindComposerResolver } from "./client/launch";
import { FeishuPanel, FeishuSettings } from "./client/panel";
import { listTasks, searchFeishu } from "./shared/feishu";

const SCREEN_ID = "feishu-panel";

function FeishuSidebarItem({ currentScreen, openScreen, theme }: PluginSidebarItemProps) {
  const callTasks = useRpc(listTasks);
  const tasksQ = useQuery({
    queryKey: ["feishu", "tasks"],
    queryFn: async () => {
      const res = await callTasks({ completed: false });
      return res.available ? res : null;
    },
    staleTime: 60_000,
    refetchInterval: 300_000,
    retry: false,
  });

  const overdueCount = (tasksQ.data?.tasks ?? []).filter((task) => task.overdue).length;

  const trailing = overdueCount > 0 ? (
    <View
      style={{
        paddingHorizontal: 6,
        paddingVertical: 1,
        borderRadius: 999,
        backgroundColor: theme.colors.surface2,
        borderWidth: 1,
        borderColor: theme.colors.statusWarning,
      }}
    >
      <Text style={{ fontSize: 10.5, fontWeight: "600", color: theme.colors.statusWarning }}>
        {overdueCount}
      </Text>
    </View>
  ) : null;

  return (
    <SidebarRow
      icon="MessageSquare"
      label="飞书"
      active={currentScreen?.screenId === SCREEN_ID}
      onPress={() => openScreen({ screenId: SCREEN_ID })}
      trailing={trailing}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  const cleanups = [
    bindComposerResolver((selector) => client.composers(selector)),
    client.addScreen({
      id: SCREEN_ID,
      title: "飞书",
      Component: (props: PluginScreenProps) => (
        <FeishuPanel {...props} openSettings={() => client.openSettings("preferences")} />
      ),
    }),
    client.addSidebarHeaderItem({
      id: SCREEN_ID,
      title: "飞书",
      Component: FeishuSidebarItem,
    }),
    client.addSettingsScreen({
      id: "preferences",
      title: "飞书",
      icon: "MessageSquare",
      Component: FeishuSettings,
    }),
    client.addAttachmentSource(
      defineAttachmentSource({
        id: "feishu",
        title: "飞书",
        icon: "MessageSquare",
        pickerTitle: "附加飞书会话",
        searchPlaceholder: "搜索单聊 / 群聊",
        search: searchFeishu,
      }),
    ),
    client.addCommandCenterItem({
      id: "open-feishu",
      title: "打开飞书面板",
      icon: "MessageSquare",
      context: "global",
      onSelect: ({ openScreen }) => openScreen({ screenId: SCREEN_ID }),
    }),
    client.addCommandCenterItem({
      id: "feishu-settings",
      title: "飞书插件设置",
      icon: "Settings",
      context: "global",
      onSelect: ({ openSettings }) => openSettings("preferences"),
    }),
  ];
  return () => {
    for (const cleanup of cleanups.reverse()) void cleanup();
  };
}
