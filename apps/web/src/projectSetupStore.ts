import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { resolveStorage } from "./lib/storage";

export const useProjectSetupStore = create<{
  dismissed: Record<string, boolean>;
  dismiss: (projectKey: string) => void;
}>()(
  persist(
    (set) => ({
      dismissed: {},
      dismiss: (key) => set((state) => ({ dismissed: { ...state.dismissed, [key]: true } })),
    }),
    {
      name: "supacode:project-setup:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window === "undefined" ? undefined : window.localStorage),
      ),
    },
  ),
);
