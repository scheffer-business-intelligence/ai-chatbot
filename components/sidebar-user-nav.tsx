"use client";

import { ChevronUp, LogOut, Moon, Sun } from "lucide-react";
import type { User } from "next-auth";
import { signOut, useSession } from "next-auth/react";
import { useTheme } from "next-themes";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { LoaderIcon } from "./icons";
import { toast } from "./toast";

export function SidebarUserNav({ user }: { user: User }) {
  const { status } = useSession();
  const { setTheme, resolvedTheme } = useTheme();
  const isDarkTheme = resolvedTheme === "dark";
  const nextTheme = isDarkTheme ? "light" : "dark";
  const nextThemeLabel = nextTheme === "dark" ? "Dark Mode" : "Light Mode";
  const displayName =
    user.name?.trim() || user.email?.split("@")[0] || "Usuário";
  const avatarFallback =
    displayName
      .split(" ")
      .filter(Boolean)
      .slice(0, 2)
      .map((chunk) => chunk.charAt(0).toUpperCase())
      .join("") || "U";

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            {status === "loading" ? (
              <SidebarMenuButton className="h-10 justify-between bg-background data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground">
                <div className="flex flex-row gap-2">
                  <div className="size-6 animate-pulse rounded-full bg-zinc-500/30" />
                  <span className="animate-pulse rounded-md bg-zinc-500/30 text-transparent">
                    Loading auth status
                  </span>
                </div>
                <div className="animate-spin text-zinc-500">
                  <LoaderIcon />
                </div>
              </SidebarMenuButton>
            ) : (
              <SidebarMenuButton
                className="h-10 bg-background data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
                data-testid="user-nav-button"
              >
                <Avatar className="size-6">
                  <AvatarImage
                    alt={displayName}
                    src={user.image ?? "/images/scheffer-icon.png"}
                  />
                  <AvatarFallback>{avatarFallback}</AvatarFallback>
                </Avatar>
                <span className="truncate" data-testid="user-name">
                  {displayName}
                </span>
                <ChevronUp className="ml-auto" />
              </SidebarMenuButton>
            )}
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-popper-anchor-width)"
            data-testid="user-nav-menu"
            side="top"
          >
            <DropdownMenuItem
              className="cursor-pointer"
              data-testid="user-nav-item-theme"
              onSelect={() => setTheme(nextTheme)}
            >
              {nextTheme === "dark" ? (
                <Moon className="size-4" />
              ) : (
                <Sun className="size-4" />
              )}
              <span>{nextThemeLabel}</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="cursor-pointer text-destructive focus:bg-destructive/15 focus:text-destructive dark:text-red-500"
              data-testid="user-nav-item-auth"
              onSelect={() => {
                if (status === "loading") {
                  toast({
                    type: "error",
                    description:
                      "Checking authentication status, please try again!",
                  });

                  return;
                }

                signOut({
                  redirectTo: "/",
                });
              }}
            >
              <LogOut className="size-4" />
              <span>Sair</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
