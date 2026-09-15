"use client";

import * as RadixTabs from "@radix-ui/react-tabs";

export const Tabs = RadixTabs.Root;
export const TabsContent = RadixTabs.Content;

export function TabsList({ items }: { items: { value: string; label: string }[] }) {
  return (
    <RadixTabs.List className="mb-5 flex gap-0.5 overflow-x-auto border-b border-edge">
      {items.map((item) => (
        <RadixTabs.Trigger
          key={item.value}
          value={item.value}
          className="relative -mb-px whitespace-nowrap border-b-2 border-transparent px-3 pb-2.5 pt-1 text-[13px] font-medium text-mute transition-colors hover:text-ink data-[state=active]:border-live data-[state=active]:text-ink"
        >
          {item.label}
        </RadixTabs.Trigger>
      ))}
    </RadixTabs.List>
  );
}
