"use client";

import { forwardRef, type ButtonHTMLAttributes } from "react";

type Variant = "primary" | "outline" | "ghost" | "danger";
type Size = "sm" | "md";

const base =
  "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-all duration-150 " +
  "active:translate-y-px active:scale-[0.99] disabled:pointer-events-none disabled:opacity-45 " +
  "focus-visible:outline-2 focus-visible:outline-live select-none whitespace-nowrap";

const variants: Record<Variant, string> = {
  primary: "bg-live text-[#06130c] hover:brightness-110 shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]",
  outline: "border border-edge-strong text-ink hover:bg-raised hover:border-faint",
  ghost: "text-mute hover:text-ink hover:bg-raised",
  danger: "bg-danger-soft text-danger border border-danger/30 hover:bg-danger hover:text-white",
};

const sizes: Record<Size, string> = {
  sm: "h-8 px-3 text-[13px]",
  md: "h-9.5 px-4 text-sm",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "outline", size = "md", loading, className = "", children, disabled, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      className={`${base} ${variants[variant]} ${sizes[size]} ${className}`}
      disabled={disabled || loading}
      {...props}
    >
      {loading && (
        <span
          aria-hidden
          className="size-3.5 animate-spin rounded-full border-[1.5px] border-current border-t-transparent"
        />
      )}
      {children}
    </button>
  );
});
