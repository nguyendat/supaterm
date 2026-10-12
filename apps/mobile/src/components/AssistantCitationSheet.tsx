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
    <AppSheet
      title="Assistant quote"
      onClose={props.onClose}
      detents={[0.65, 0.9]}
      dismissAction={props.onSave ? "cancel" : "done"}
    >
      <ScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="always"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ padding: 20, gap: 24, paddingBottom: Math.max(20, insets.bottom) }}
      >
        <View className="gap-3">
          <Text className="text-sm font-supacode-medium text-foreground-muted">Selected text</Text>
          <View className="border-l-2 border-border py-1 pl-4">
            <Text selectable className="text-base leading-relaxed text-foreground">
              {props.citation.text}
            </Text>
          </View>
        </View>
        <View className="gap-2">
          <View className="flex-row items-baseline gap-2">
            <Text className="text-sm font-supacode-medium text-foreground">Comment</Text>
            {props.onSave ? <Text className="text-sm text-foreground-muted">Optional</Text> : null}
          </View>
          {props.onSave ? (
            <AppTextInput
              accessibilityLabel="Comment, optional"
              multiline
              maxLength={ASSISTANT_CITATION_MAX_COMMENT_LENGTH}
              value={comment}
              onChangeText={setComment}
              placeholder="Ask the agent about this quote…"
              textAlignVertical="top"
              className="min-h-[104px]"
            />
          ) : (
            <Text selectable className="text-base leading-relaxed text-foreground-muted">
              {comment || "No comment added."}
            </Text>
          )}
        </View>
        {props.onSave || props.onRemove ? (
          <View className="gap-2">
            {props.onSave ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={props.saveLabel ?? "Save comment"}
                onPress={() => {
                  if (props.onSave?.(withAssistantCitationComment(props.citation, comment)))
                    props.onClose();
                }}
                className="min-h-[48px] items-center justify-center rounded-full bg-primary px-5 py-3 active:scale-[0.96] active:opacity-80"
              >
                <Text className="text-center text-base font-supacode-medium text-primary-foreground">
                  {props.saveLabel ?? "Save comment"}
                </Text>
              </Pressable>
            ) : null}
            {props.onRemove ? (
              <Pressable
                accessibilityRole="button"
                onPress={props.onRemove}
                className="min-h-[48px] items-center justify-center rounded-full px-5 py-3 active:scale-[0.96] active:bg-subtle"
              >
                <Text className="text-center text-base font-supacode-medium text-danger-foreground">
                  Remove from draft
                </Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
      </ScrollView>
    </AppSheet>
  );
}
