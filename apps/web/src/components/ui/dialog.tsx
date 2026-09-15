"use client";

import * as RadixDialog from "@radix-ui/react-dialog";
import { X } from "@phosphor-icons/react";

export const Dialog = RadixDialog.Root;
export const DialogTrigger = RadixDialog.Trigger;
export const DialogClose = RadixDialog.Close;

export function DialogContent({
  title,
  description,
  children,
  wide = false,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <RadixDialog.Portal>
      <RadixDialog.Overlay className="fixed inset-0 z-50 bg-overlay backdrop-blur-[3px] data-[state=open]:animate-in" />
      <RadixDialog.Content
        className={`fixed left-1/2 top-1/2 z-50 max-h-[88dvh] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-edge bg-surface shadow-[0_24px_64px_-16px_rgba(0,0,0,0.5),inset_0_1px_0_var(--edge)] focus:outline-none ${
          wide ? "max-w-2xl" : "max-w-md"
        }`}
      >
        <header className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-edge bg-surface/95 px-6 py-4 backdrop-blur">
          <div>
            <RadixDialog.Title className="text-[15px] font-semibold tracking-tight">
              {title}
            </RadixDialog.Title>
            {description ? (
              <RadixDialog.Description className="mt-0.5 text-[13px] text-mute">
                {description}
              </RadixDialog.Description>
            ) : (
              <RadixDialog.Description className="sr-only">{title}</RadixDialog.Description>
            )}
          </div>
          <RadixDialog.Close
            aria-label="Close"
            className="rounded-md p-1.5 text-mute transition-colors hover:bg-raised hover:text-ink"
          >
            <X size={16} weight="bold" />
          </RadixDialog.Close>
        </header>
        <div className="px-6 py-5">{children}</div>
      </RadixDialog.Content>
    </RadixDialog.Portal>
  );
}
