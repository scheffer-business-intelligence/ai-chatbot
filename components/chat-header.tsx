"use client";

import { useRouter } from "next/navigation";
import { memo } from "react";
import { useWindowSize } from "usehooks-ts";
import { SidebarToggle } from "@/components/sidebar-toggle";
import { Button } from "@/components/ui/button";
import { useSidebarOptional } from "@/components/ui/sidebar";
import { PlusIcon } from "./icons";

function PureChatHeader() {
  const router = useRouter();
  const sidebar = useSidebarOptional();
  const open = sidebar?.open ?? false;

  const { width: windowWidth } = useWindowSize();

  return (
    <header className="sticky top-0 flex items-center gap-2 bg-background px-2 py-1.5 md:px-2">
      {sidebar ? <SidebarToggle /> : <div className="h-8 w-[42px] md:h-9" />}

      {(!open || windowWidth < 768) && (
        <Button
          className="order-2 ml-auto h-8 cursor-pointer px-2 md:order-1 md:ml-0 md:h-fit md:px-2"
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
    </header>
  );
}

export const ChatHeader = memo(PureChatHeader);
