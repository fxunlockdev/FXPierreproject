"use client";

import {
  cloneElement,
  forwardRef,
  isValidElement,
  useId,
  type InputHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";

const inputStyles =
  "w-full rounded-lg border border-edge bg-surface px-3 text-sm text-ink placeholder:text-faint " +
  "transition-colors hover:border-edge-strong focus:border-live focus:outline-none h-9.5 " +
  "disabled:opacity-45 disabled:pointer-events-none";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className = "", ...props }, ref) {
    return <input ref={ref} className={`${inputStyles} ${className}`} {...props} />;
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className = "", ...props }, ref) {
    return (
      <textarea
        ref={ref}
        className={`${inputStyles} h-auto min-h-20 py-2 leading-relaxed ${className}`}
        {...props}
      />
    );
  },
);

export function Field({
  label,
  hint,
  error,
  children,
  className = "",
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
  className?: string;
}) {
  // Explicit htmlFor + aria-describedby, NOT a wrapping <label>: wrapping
  // would fold the hint text into the control's accessible name.
  const autoId = useId();
  const describedBy = hint || error ? `${autoId}-desc` : undefined;
  const child = isValidElement(children)
    ? cloneElement(children as React.ReactElement<Record<string, unknown>>, {
        id: (children.props as { id?: string }).id ?? autoId,
        "aria-describedby": describedBy,
        "aria-invalid": error ? true : undefined,
      })
    : children;
  const childId = isValidElement(children)
    ? ((children.props as { id?: string }).id ?? autoId)
    : autoId;

  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      <label htmlFor={childId} className="text-[13px] font-medium text-mute">
        {label}
      </label>
      {child}
      {hint && !error && (
        <span id={describedBy} className="text-xs text-faint">
          {hint}
        </span>
      )}
      {error && (
        <span id={describedBy} className="text-xs text-danger">
          {error}
        </span>
      )}
    </div>
  );
}
