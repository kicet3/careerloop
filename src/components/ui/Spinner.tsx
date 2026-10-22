import { cn } from "./cn";

export function Spinner({
  size = "md",
  className,
  label,
}: {
  size?: "sm" | "md";
  className?: string;
  /** 지정하면 스크린리더에 읽힌다. 없으면 장식으로 취급. */
  label?: string;
}) {
  return (
    <span
      role={label ? "status" : undefined}
      aria-hidden={label ? undefined : true}
      className={cn("inline-flex items-center", className)}
    >
      <span
        className={cn(
          "animate-spin rounded-full border-2 border-current border-r-transparent",
          size === "sm" ? "size-3.5" : "size-5",
        )}
      />
      {label && <span className="sr-only">{label}</span>}
    </span>
  );
}
