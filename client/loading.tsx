import { ActivityIndicator, Pressable, Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";

type Theme = PluginSurfaceProps["theme"];

export function LoadingState({ theme, label, rows = 3 }: { theme: Theme; label: string; rows?: number }) {
  const c = theme.colors;
  return (
    <View accessibilityLabel={label} accessibilityState={{ busy: true }} style={{ gap: 10, paddingVertical: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <ActivityIndicator size="small" color={c.accent} />
        <Text accessibilityLiveRegion="polite" style={{ color: c.foregroundMuted, fontSize: 12 }}>
          {label}
        </Text>
      </View>
      {Array.from({ length: rows }, (_, index) => (
        <View
          key={index}
          accessible={false}
          importantForAccessibility="no-hide-descendants"
          style={{ paddingVertical: 10, gap: 8 }}
        >
          <View
            style={{
              width: index % 2 ? "48%" : "64%",
              height: 13,
              borderRadius: 4,
              backgroundColor: c.foreground + "12",
            }}
          />
          <View
            style={{
              width: "32%",
              height: 10,
              borderRadius: 4,
              backgroundColor: c.foreground + "08",
            }}
          />
        </View>
      ))}
    </View>
  );
}

export function LoadError({
  theme,
  label,
  error,
  retry,
  busy = false,
}: {
  theme: Theme;
  label: string;
  error: unknown;
  retry: () => void;
  busy?: boolean;
}) {
  const message = error instanceof Error ? error.message : String(error ?? "暂时无法读取");
  return (
    <View style={{ gap: 8, paddingVertical: 8 }}>
      <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger, fontSize: 12 }}>
        {label}：{message.slice(0, 180)}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="重试"
        accessibilityState={{ disabled: busy }}
        disabled={busy}
        onPress={retry}
        style={{
          alignSelf: "flex-start",
          paddingHorizontal: 12,
          paddingVertical: 7,
          borderRadius: 6,
          backgroundColor: theme.colors.foreground + "12",
          opacity: busy ? 0.5 : 1,
        }}
      >
        <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>{busy ? "重试中…" : "重试"}</Text>
      </Pressable>
    </View>
  );
}
