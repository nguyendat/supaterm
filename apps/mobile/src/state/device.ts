import { createDeviceEnvironmentAtoms } from "@supacode/client-runtime/state/device";
import { resolveDeviceHubAccess } from "@supacode/client-runtime/state/deviceHubAccess";
import { DEVICE_MEDIA_V1_PATH, type EnvironmentId } from "@supacode/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { useMemo } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "./atom-registry";
import { useEnvironmentQuery } from "./query";
import { environmentSession, usePreparedConnection } from "./session";

export const deviceEnvironment = createDeviceEnvironmentAtoms(connectionAtomRuntime);

const deviceHubAccessAtom = Atom.family((environmentId: EnvironmentId) =>
  connectionAtomRuntime
    .atom((get) => {
      const prepared = Option.getOrNull(
        get(environmentSession.preparedConnectionValueAtom(environmentId)),
      );
      return prepared === null
        ? Effect.never
        : resolveDeviceHubAccess({ prepared, hubBasePath: "/api/device-hub" });
    })
    .pipe(Atom.setIdleTTL(60_000), Atom.withLabel(`mobile-device-hub-access:${environmentId}`)),
);

export function refreshDeviceHubAccess(environmentId: EnvironmentId) {
  appAtomRegistry.refresh(deviceHubAccessAtom(environmentId));
}

export function useDeviceHubAccess(environmentId: EnvironmentId, hostId: string) {
  const state = useEnvironmentQuery(deviceEnvironment.state({ environmentId, input: {} }));
  const prepared = usePreparedConnection(environmentId);
  const query = useEnvironmentQuery(deviceHubAccessAtom(environmentId));
  const access = useMemo(
    () =>
      query.data && query.error === null && Option.isSome(prepared)
        ? {
            ...query.data,
            query: { ...query.data.query, hostId },
            ...(state.data?.supportsDeviceMediaV1
              ? {
                  mediaV1WsBase: query.data.wsBase.replace(
                    /\/api\/device-hub$/,
                    DEVICE_MEDIA_V1_PATH,
                  ),
                }
              : {}),
          }
        : null,
    [query.data, query.error, prepared, hostId, state.data?.supportsDeviceMediaV1],
  );
  return { access, error: query.error, refresh: query.refresh };
}
