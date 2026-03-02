import { Skeleton } from "@/components/ui/skeleton";

function MessageSkeleton({
  role,
  lines = 2,
}: {
  role: "user" | "assistant";
  lines?: number;
}) {
  if (role === "user") {
    return (
      <div className="flex w-full justify-end">
        <div className="w-fit max-w-[calc(100%-2.5rem)] sm:max-w-[80%]">
          <Skeleton className="h-12 w-48 rounded-lg bg-primary/10" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex w-full items-start gap-3">
      <Skeleton className="size-8 shrink-0 rounded-full" />
      <div className="flex w-full flex-col gap-2">
        {Array.from({ length: lines }).map((_, i) => (
          <Skeleton
            className={`h-4 rounded ${i === lines - 1 ? "w-3/5" : "w-full"}`}
            key={i}
          />
        ))}
      </div>
    </div>
  );
}

export function ChatSkeleton() {
  return (
    <div className="flex h-dvh min-w-0 flex-col bg-background">
      {/* Header skeleton */}
      <header className="flex h-14 items-center gap-2 border-b px-4">
        <Skeleton className="h-5 w-40" />
      </header>

      {/* Messages area skeleton */}
      <div className="relative flex-1">
        <div className="absolute inset-0 overflow-hidden">
          <div className="mx-auto flex max-w-4xl flex-col gap-6 px-2 py-4 md:px-4">
            <MessageSkeleton lines={1} role="user" />
            <MessageSkeleton lines={3} role="assistant" />
            <MessageSkeleton lines={1} role="user" />
            <MessageSkeleton lines={4} role="assistant" />
            <MessageSkeleton lines={1} role="user" />
            <MessageSkeleton lines={2} role="assistant" />
          </div>
        </div>
      </div>

      {/* Input area skeleton */}
      <div className="sticky bottom-0 mx-auto flex w-full max-w-4xl px-2 pb-3 md:px-4 md:pb-4">
        <Skeleton className="h-14 w-full rounded-2xl" />
      </div>
    </div>
  );
}
