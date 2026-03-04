"use client";

import { usePathname, useRouter } from "next/navigation";
import { memo } from "react";
import { useWindowSize } from "usehooks-ts";
import { SidebarToggle } from "@/components/sidebar-toggle";
import { Button } from "@/components/ui/button";
import { useSidebarOptional } from "@/components/ui/sidebar";
import { PlusIcon, ShareIcon } from "./icons";

function PureChatHeader({
  isReadonly,
  isSharing,
  onShare,
}: {
  isReadonly: boolean;
  isSharing: boolean;
  onShare: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const sidebar = useSidebarOptional();
  const open = sidebar?.open ?? false;

  const { width: windowWidth } = useWindowSize();
  const shouldShowShareButton = !isReadonly && pathname?.startsWith("/chat/");
  const shouldShowNewChatButton = !open || windowWidth < 768;

  return (
    <header className="sticky top-0 flex items-center gap-2 bg-background px-2 py-1.5 md:px-2">
      {sidebar ? <SidebarToggle /> : <div className="h-8 w-[42px] md:h-9" />}

      <div className="ml-auto flex items-center gap-2">
        {shouldShowShareButton && (
          <Button
            className="h-8 cursor-pointer px-2 md:h-fit md:px-3"
            disabled={isSharing}
            onClick={onShare}
            type="button"
            variant="outline"
          >
            <ShareIcon />
            <span className="hidden md:inline">
              {isSharing ? "Compartilhando..." : "Compartilhar"}
            </span>
          </Button>
        )}

        {shouldShowNewChatButton && (
          <Button
            className="h-8 cursor-pointer px-2 md:h-fit md:px-2"
            onClick={() => {
              router.push("/");
              router.refresh();
            }}
            variant="outline"
          >
            <PlusIcon />
            <span className="md:sr-only">Nova Conversa</span>
          </Button>
        )}
      </div>
    </header>
  );
}

export const ChatHeader = memo(PureChatHeader);
