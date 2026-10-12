import { ASSISTANT_CITATION_MAX_COMMENT_LENGTH, type AssistantCitation } from "@supacode/contracts";
import { withAssistantCitationComment } from "@supacode/shared/assistantCitations";
import { useState } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppSheet } from "./AppSheet";
import { AppText as Text, AppTextInput } from "./AppText";

export function AssistantCitationSheet(props: {
  readonly citation: AssistantCitation;
  readonly onClose: () => void;
  readonly onSave?: (citation: AssistantCitation) => boolean;
  readonly onRemove?: () => void;
  readonly saveLabel?: string;
}) {
  const [comment, setComment] = useState(props.citation.comment ?? "");
  const insets = useSafeAreaInsets();
  return (
    <AppSheet title="Assistant quote" onClose={props.onClose}>
      <ScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="always"
        contentContainerStyle={{ padding: 20, gap: 16, paddingBottom: Math.max(20, insets.bottom) }}
      >
        <View className="rounded-xl bg-subtle p-4">
          <Text selectable className="text-base text-foreground">
            {props.citation.text}
          </Text>
        </View>
        <View className="gap-2">
          <Text className="text-sm text-foreground-muted">Comment (optional)</Text>
          <AppTextInput
            accessibilityLabel="Citation comment"
            multiline
            editable={props.onSave !== undefined}
            maxLength={ASSISTANT_CITATION_MAX_COMMENT_LENGTH}
            value={comment}
            onChangeText={setComment}
            placeholder="What would you like the agent to do with this quote?"
            textAlignVertical="top"
            className="min-h-24 rounded-xl border border-border bg-subtle p-4 text-base text-foreground"
          />
        </View>
        {props.onSave ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={props.saveLabel ?? "Save citation comment"}
            onPress={() => {
              if (props.onSave?.(withAssistantCitationComment(props.citation, comment)))
                props.onClose();
            }}
            className="items-center rounded-xl bg-primary p-4 active:opacity-65"
          >
            <Text className="font-supacode-bold text-primary-foreground">
              {props.saveLabel ?? "Save"}
            </Text>
          </Pressable>
        ) : null}
        {props.onRemove ? (
          <Pressable
            accessibilityRole="button"
            onPress={props.onRemove}
            className="items-center rounded-xl bg-subtle p-4"
          >
            <Text className="text-foreground">Remove from draft</Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </AppSheet>
  );
}
