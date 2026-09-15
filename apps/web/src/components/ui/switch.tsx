"use client";

import * as RadixSwitch from "@radix-ui/react-switch";

export function Switch({
  checked,
  onCheckedChange,
  disabled,
  label,
}: {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <RadixSwitch.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={label}
      className="group relative h-5.5 w-9.5 shrink-0 rounded-full border border-edge-strong bg-raised transition-colors data-[state=checked]:border-live data-[state=checked]:bg-live-soft disabled:opacity-40"
    >
      <RadixSwitch.Thumb className="block size-4 translate-x-0.5 rounded-full bg-faint transition-transform duration-150 group-data-[state=checked]:translate-x-[18px] group-data-[state=checked]:bg-live" />
    </RadixSwitch.Root>
  );
}
