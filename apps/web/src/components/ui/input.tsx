import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes, type LabelHTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

export const fieldBase =
  'w-full rounded-md border border-border-strong/70 bg-surface px-2.5 text-[13px] text-fg placeholder:text-fg-3 shadow-sm ' +
  'outline-none transition-colors focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none ' +
  'disabled:opacity-60 aria-[invalid=true]:border-st-failed';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...props },
  ref,
) {
  return <input ref={ref} className={cn(fieldBase, 'h-8', className)} {...props} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...props }, ref) {
    return <textarea ref={ref} className={cn(fieldBase, 'min-h-20 py-2 leading-relaxed', className)} {...props} />;
  },
);

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('mb-1 block text-xs font-medium text-fg-2', className)} {...props} />;
}

export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string | null;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error ? (
        <p className="mt-1 text-xs text-bad" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="mt-1 text-xs text-fg-3">{hint}</p>
      ) : null}
    </div>
  );
}
