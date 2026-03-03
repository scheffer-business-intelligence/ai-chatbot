"use client";

import type { ComponentProps } from "react";
import { useMemo } from "react";
import { Streamdown } from "streamdown";
import { MarkdownTable } from "@/components/markdown-table";
import { normalizeMarkdownForRender } from "@/lib/markdown";
import { cn } from "@/lib/utils";

type ResponseProps = ComponentProps<typeof Streamdown>;

export function Response({
  className,
  children,
  components,
  ...props
}: ResponseProps) {
  const normalizedChildren =
    typeof children === "string"
      ? normalizeMarkdownForRender(children)
      : children;
  const resolvedComponents = useMemo(
    () => ({
      ...components,
      table: MarkdownTable,
    }),
    [components]
  );

  return (
    <Streamdown
      className={cn(
        "min-w-0 max-w-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_code]:whitespace-pre-wrap [&_code]:break-words [&_pre]:max-w-full [&_pre]:overflow-x-auto",
        className
      )}
      components={resolvedComponents}
      {...props}
    >
      {normalizedChildren}
    </Streamdown>
  );
}
