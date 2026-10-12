import type { ComponentProps } from "react";
import { Platform, Pressable } from "react-native";

import { AppActivityIndicator } from "../../../components/AppActivityIndicator";
import { SymbolView } from "../../../components/AppSymbol";
import { AppText as Text } from "../../../components/AppText";
import { MaterialListRow } from "../../../components/MaterialListRow";
import { cn } from "../../../lib/cn";

export function SettingsActionRow({
  icon,
  label,
  tone,
  loading,
  ...props
}: Omit<ComponentProps<typeof Pressable>, "children"> & {
  readonly icon: ComponentProps<typeof SymbolView>["name"];
  readonly label: string;
  readonly tone?: "default" | "danger";
  readonly loading?: boolean;
}) {
  const danger = tone === "danger";
  const textClassName = danger ? "tabular-nums text-danger-foreground" : "text-foreground";
  const iconColorClassName = danger ? "accent-danger-foreground" : "accent-icon";
  const symbol = (
    <SymbolView
      name={icon}
      size={Platform.OS === "android" ? 24 : 22}
      tintColorClassName={iconColorClassName}
      type="monochrome"
      weight="regular"
    />
  );
  const spinner = loading ? <AppActivityIndicator colorClassName={iconColorClassName} /> : null;

  if (Platform.OS === "android") {
    return (
      <MaterialListRow
        {...props}
        className="bg-grouped-card"
        title={label}
        titleClassName={textClassName}
        leading={symbol}
        trailing={spinner}
      />
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      {...props}
      className="flex-row items-center gap-4 p-4 disabled:opacity-40"
    >
      {symbol}
      <Text className={cn("flex-1 text-lg", textClassName)}>{label}</Text>
      {spinner}
    </Pressable>
  );
}
