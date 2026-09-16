"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { SpaceInfo } from "./types";
import { SPACE_COOKIE } from "./space-cookie";
import { setWorkerSpace } from "./worker";

interface SpaceContextValue {
  /** The space every page reads from and writes to. */
  space: SpaceInfo;
  spaces: SpaceInfo[];
  /** Owners and admins change things; viewers only look. */
  canEdit: boolean;
  isPlatformAdmin: boolean;
  switchSpace(id: string): void;
}

const SpaceContext = createContext<SpaceContextValue | null>(null);

export function SpaceProvider({
  spaces,
  initialSpaceId,
  isPlatformAdmin,
  children,
}: {
  spaces: SpaceInfo[];
  initialSpaceId: string;
  isPlatformAdmin: boolean;
  children: React.ReactNode;
}) {
  const qc = useQueryClient();
  const [spaceId, setSpaceId] = useState(initialSpaceId);
  const space = spaces.find((s) => s.id === spaceId) ?? spaces[0]!;

  useEffect(() => {
    setWorkerSpace(space.id);
  }, [space.id]);

  const switchSpace = useCallback(
    (id: string) => {
      document.cookie = `${SPACE_COOKIE}=${id}; path=/; max-age=31536000; samesite=lax`;
      setWorkerSpace(id);
      setSpaceId(id);
      // drop every cached row of the previous space
      qc.removeQueries();
    },
    [qc],
  );

  const value = useMemo<SpaceContextValue>(
    () => ({
      space,
      spaces,
      canEdit: space.role === "owner" || space.role === "admin",
      isPlatformAdmin,
      switchSpace,
    }),
    [space, spaces, isPlatformAdmin, switchSpace],
  );

  return <SpaceContext.Provider value={value}>{children}</SpaceContext.Provider>;
}

export function useSpace(): SpaceContextValue {
  const ctx = useContext(SpaceContext);
  if (!ctx) throw new Error("useSpace must be used inside SpaceProvider");
  return ctx;
}

export const useSpaceId = (): string => useSpace().space.id;
