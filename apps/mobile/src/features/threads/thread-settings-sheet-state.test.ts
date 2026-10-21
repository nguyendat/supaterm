import { describe, expect, it } from "@effect/vitest";

import { ProviderInstanceId } from "@supaterm/contracts";

import type { ModelOption } from "../../lib/modelOptions";
import {
  canSelectModel,
  favoritesFirst,
  modelMatchesCatalogQuery,
} from "./thread-settings-sheet-state";

function modelOption(model: string): ModelOption {
  return {
    key: `codex:${model}`,
    label: model,
    subtitle: "",
    providerKey: "codex",
    providerLabel: "Codex",
    providerDriver: "codex",
    isDefault: false,
    isLegacy: false,
    capabilities: null,
    selection: {
      instanceId: ProviderInstanceId.make("codex"),
      model,
    },
  };
}

describe("thread settings sheet state", () => {
  it("keeps favorites in catalog order ahead of other models", () => {
    const models = [
      modelOption("first"),
      modelOption("second"),
      modelOption("third"),
      modelOption("fourth"),
    ];
    const favorites = new Set([models[2]!.key, models[0]!.key]);

    expect(favoritesFirst(models, favorites).map((model) => model.selection.model)).toEqual([
      "first",
      "third",
      "second",
      "fourth",
    ]);
    expect(models.map((model) => model.selection.model)).toEqual([
      "first",
      "second",
      "third",
      "fourth",
    ]);
  });

  it("matches visible model and provider terms", () => {
    const model = modelOption("gpt-next");

    expect(modelMatchesCatalogQuery({ model, providerLabel: "Codex", query: "NEXT" })).toBe(true);
    expect(modelMatchesCatalogQuery({ model, providerLabel: "Codex", query: "codex" })).toBe(true);
    expect(modelMatchesCatalogQuery({ model, providerLabel: "Codex", query: "claude" })).toBe(
      false,
    );
  });

  it("treats whitespace-only catalog searches as empty", () => {
    expect(
      modelMatchesCatalogQuery({
        model: modelOption("gpt-next"),
        providerLabel: "Codex",
        query: "   ",
      }),
    ).toBe(true);
  });

  it("matches the upstream provider's display name", () => {
    const model = {
      ...modelOption("opencode/claude-fable-5"),
      label: "Claude Fable 5",
      subtitle: "OpenCode Zen",
    };

    expect(modelMatchesCatalogQuery({ model, providerLabel: "OpenCode", query: " ZEN " })).toBe(
      true,
    );
    expect(modelMatchesCatalogQuery({ model, providerLabel: "OpenCode", query: "copilot" })).toBe(
      false,
    );
  });

  it("cannot select a hidden model exposed only for visibility management", () => {
    const option = modelOption("gpt-next");
    expect(
      canSelectModel(option, [
        { providerKey: "codex", providerLabel: "Codex", models: [{ ...option, isHidden: true }] },
      ]),
    ).toBe(false);
  });

  it("cannot select a model after sign-out removes it from the catalog", () => {
    const option = modelOption("gemini-native");
    const group = { providerKey: "codex", providerLabel: "Codex", models: [option] };

    expect(canSelectModel(option, [group])).toBe(true);
    expect(canSelectModel(option, [])).toBe(false);
    expect(
      canSelectModel(option, [
        {
          ...group,
          models: [{ ...option, isUnavailable: true }],
        },
      ]),
    ).toBe(false);
  });
});
