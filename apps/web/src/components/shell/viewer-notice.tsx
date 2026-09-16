"use client";

import { Eye } from "@phosphor-icons/react";
import { useSpace } from "@/lib/space";

/** Viewers see everything but change nothing — say so before they try. */
export function ViewerNotice() {
  const { space, canEdit } = useSpace();
  if (canEdit) return null;
  return (
    <p
      role="note"
      className="mb-6 flex items-center gap-2 rounded-lg border border-edge bg-raised px-3 py-2 text-[13px] text-mute"
    >
      <Eye size={15} className="shrink-0 text-faint" />
      You have view access to {space.name}. Changes are made by its owner and admins.
    </p>
  );
}
