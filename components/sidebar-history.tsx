"use client";

import { format, isToday, isYesterday } from "date-fns";
import { ptBR } from "date-fns/locale";
import { motion } from "framer-motion";
import { usePathname, useRouter } from "next/navigation";
import type { User } from "next-auth";
import { useState } from "react";
import { toast } from "sonner";
import useSWRInfinite from "swr/infinite";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  useSidebar,
} from "@/components/ui/sidebar";
import type { Chat } from "@/lib/db/schema";
import { fetcher } from "@/lib/utils";
import { LoaderIcon } from "./icons";
import { ChatItem } from "./sidebar-history-item";

type ChatGroup = {
  heading: string;
  chats: Chat[];
};

export type ChatHistory = {
  chats: Chat[];
  hasMore: boolean;
};

const PAGE_SIZE = 20;

function getDateHeading(chatDate: Date) {
  if (isToday(chatDate)) {
    return "Hoje";
  }

  if (isYesterday(chatDate)) {
    return "Ontem";
  }

  const formatted = format(chatDate, "d MMMM yyyy", { locale: ptBR });
  const [day, month, year] = formatted.split(" ");

  if (!day || !month || !year) {
    return formatted;
  }

  return `${day} ${month.charAt(0).toUpperCase()}${month.slice(1)} ${year}`;
}

const groupChatsByDate = (chats: Chat[]): ChatGroup[] => {
  const groupsMap = new Map<string, Chat[]>();

  for (const chat of chats) {
    const chatDate = new Date(chat.createdAt);
    const heading = getDateHeading(chatDate);
    const currentGroup = groupsMap.get(heading);

    if (currentGroup) {
      currentGroup.push(chat);
      continue;
    }

    groupsMap.set(heading, [chat]);
  }

  return Array.from(groupsMap.entries()).map(([heading, groupChats]) => ({
    heading,
    chats: groupChats,
  }));
};

export function getChatHistoryPaginationKey(
  pageIndex: number,
  previousPageData: ChatHistory
) {
  if (previousPageData && previousPageData.hasMore === false) {
    return null;
  }

  if (pageIndex === 0) {
    return `/api/history?limit=${PAGE_SIZE}`;
  }

  const firstChatFromPage = previousPageData.chats.at(-1);

  if (!firstChatFromPage) {
    return null;
  }

  return `/api/history?ending_before=${firstChatFromPage.id}&limit=${PAGE_SIZE}`;
}

export function SidebarHistory({ user }: { user: User | undefined }) {
  const { setOpenMobile } = useSidebar();
  const pathname = usePathname();
  const id = pathname?.startsWith("/chat/") ? pathname.split("/")[2] : null;

  const {
    data: paginatedChatHistories,
    setSize,
    isValidating,
    isLoading,
    mutate,
  } = useSWRInfinite<ChatHistory>(getChatHistoryPaginationKey, fetcher, {
    fallbackData: [],
  });

  const router = useRouter();
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  const updateChatVisibilityInCache = (
    chatId: string,
    visibility: "public" | "private"
  ) => {
    mutate(
      (chatHistories) =>
        chatHistories?.map((chatHistory) => ({
          ...chatHistory,
          chats: chatHistory.chats.map((chat) =>
            chat.id === chatId ? { ...chat, visibility } : chat
          ),
        })),
      { revalidate: false }
    );
  };

  const handleShare = (chat: Chat) => {
    const sharePromise = (async () => {
      if (chat.visibility !== "public") {
        const response = await fetch("/api/chat", {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            id: chat.id,
            visibility: "public",
          }),
        });

        const payload = (await response.json().catch(() => null)) as
          | { message?: string; cause?: string; error?: string }
          | null;

        if (!response.ok) {
          throw new Error(
            payload?.cause ||
              payload?.error ||
              payload?.message ||
              "Falha ao habilitar compartilhamento."
          );
        }

        updateChatVisibilityInCache(chat.id, "public");
      }

      const shareUrl = `${window.location.origin}/chat/${chat.id}`;

      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(shareUrl);
        } catch {
          window.prompt("Copie o link da conversa:", shareUrl);
        }
      } else {
        window.prompt("Copie o link da conversa:", shareUrl);
      }
    })();

    toast.promise(sharePromise, {
      loading:
        chat.visibility === "public"
          ? "Copiando link..."
          : "Preparando compartilhamento...",
      success: "Link de compartilhamento copiado!",
      error: (error) =>
        error instanceof Error ? error.message : "Falha ao compartilhar.",
    });
  };

  const normalizedChatHistoryPages = (paginatedChatHistories ?? []).map(
    (page) => ({
      chats: Array.isArray(page?.chats) ? page.chats : [],
      hasMore: page?.hasMore === true,
    })
  );

  const hasReachedEnd =
    normalizedChatHistoryPages.length > 0
      ? normalizedChatHistoryPages.some((page) => page.hasMore === false)
      : false;

  const hasEmptyChatHistory =
    normalizedChatHistoryPages.length > 0
      ? normalizedChatHistoryPages.every((page) => page.chats.length === 0)
      : false;

  const handleDelete = () => {
    const chatToDelete = deleteId;
    const isCurrentChat = pathname === `/chat/${chatToDelete}`;

    setShowDeleteDialog(false);

    const deletePromise = fetch(`/api/chat?id=${chatToDelete}`, {
      method: "DELETE",
    });

    toast.promise(deletePromise, {
      loading: "Excluindo o chat...",
      success: () => {
        mutate((chatHistories) => {
          if (chatHistories) {
            return chatHistories.map((chatHistory) => ({
              ...chatHistory,
              chats: chatHistory.chats.filter(
                (chat) => chat.id !== chatToDelete
              ),
            }));
          }
        });

        if (isCurrentChat) {
          router.replace("/");
          router.refresh();
        }

        return "Chat excluído com sucesso";
      },
      error: "Failed to delete chat",
    });
  };

  if (!user) {
    return (
      <SidebarGroup>
        <SidebarGroupContent>
          <div className="flex w-full flex-row items-center justify-center gap-2 px-2 text-sm text-zinc-500">
            Login to save and revisit previous chats!
          </div>
        </SidebarGroupContent>
      </SidebarGroup>
    );
  }

  if (isLoading) {
    return (
      <SidebarGroup>
        <div className="px-2 py-1 text-sidebar-foreground/50 text-xs">Hoje</div>
        <SidebarGroupContent>
          <div className="flex flex-col">
            {[44, 32, 28, 64, 52].map((item) => (
              <div
                className="flex h-8 items-center gap-2 rounded-md px-2"
                key={item}
              >
                <div
                  className="h-4 max-w-(--skeleton-width) flex-1 rounded-md bg-sidebar-accent-foreground/10"
                  style={
                    {
                      "--skeleton-width": `${item}%`,
                    } as React.CSSProperties
                  }
                />
              </div>
            ))}
          </div>
        </SidebarGroupContent>
      </SidebarGroup>
    );
  }

  if (hasEmptyChatHistory) {
    return (
      <SidebarGroup>
        <SidebarGroupContent>
          <div className="flex w-full flex-row items-center justify-center gap-2 px-2 text-sm text-zinc-500">
            Suas conversas aparecerão aqui assim que você começar a conversar!
          </div>
        </SidebarGroupContent>
      </SidebarGroup>
    );
  }

  return (
    <>
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            {normalizedChatHistoryPages.length > 0 &&
              (() => {
                const chatsFromHistory = normalizedChatHistoryPages.flatMap(
                  (paginatedChatHistory) => paginatedChatHistory.chats
                );

                const groupedChats = groupChatsByDate(chatsFromHistory);

                return (
                  <div className="flex flex-col gap-6">
                    {groupedChats.map((group) => (
                      <div key={group.heading}>
                        <div className="px-2 py-1 text-sidebar-foreground/50 text-xs">
                          {group.heading}
                        </div>
                        {group.chats.map((chat) => (
                          <ChatItem
                            chat={chat}
                            isActive={chat.id === id}
                            key={chat.id}
                            onShare={handleShare}
                            onDelete={(chatId) => {
                              setDeleteId(chatId);
                              setShowDeleteDialog(true);
                            }}
                            setOpenMobile={setOpenMobile}
                          />
                        ))}
                      </div>
                    ))}
                  </div>
                );
              })()}
          </SidebarMenu>

          <motion.div
            onViewportEnter={() => {
              if (!isValidating && !hasReachedEnd) {
                setSize((size) => size + 1);
              }
            }}
          />

          {hasReachedEnd ? (
            <div className="mt-8 flex w-full flex-row items-center justify-center gap-2 px-2 text-sm text-zinc-500">
              Você chegou ao fim do seu histórico de bate-papo.
            </div>
          ) : (
            <div className="mt-8 flex flex-row items-center gap-2 p-2 text-zinc-500 dark:text-zinc-400">
              <div className="animate-spin">
                <LoaderIcon />
              </div>
              <div>Carregando conversas...</div>
            </div>
          )}
        </SidebarGroupContent>
      </SidebarGroup>

      <AlertDialog onOpenChange={setShowDeleteDialog} open={showDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Tem certeza absoluta?</AlertDialogTitle>
            <AlertDialogDescription>
              Esta ação não pode ser desfeita. Isso excluirá permanentemente seu
              chat e o removerá de nossos servidores.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>
              Continuar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
