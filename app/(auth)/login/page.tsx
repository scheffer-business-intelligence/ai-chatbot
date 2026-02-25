"use client";

import { Bot } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { Suspense } from "react";
import { LogoGoogle } from "@/components/icons";

export default function Page() {
  return (
    <Suspense fallback={<div className="flex min-h-screen bg-[#0f1117]" />}>
      <LoginPage />
    </Suspense>
  );
}

function LoginPage() {
  const searchParams = useSearchParams();
  const error = searchParams.get("error");
  const callbackUrl = searchParams.get("callbackUrl") || "/";

  const handleGoogleLogin = async () => {
    await signIn("google", { callbackUrl });
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#0f1117] text-gray-100">
      <div className="w-full max-w-md px-4">
        <div className="rounded-2xl border border-[#1f2230] bg-[#0f1117] p-8 shadow-2xl shadow-black/30">
          <div className="mb-6 flex justify-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-[#1f2230]">
              <Bot className="h-8 w-8 text-[#10a37f]" />
            </div>
          </div>

          <h1 className="mb-2 text-center font-semibold text-2xl">
            Scheffer Agente
          </h1>
          <p className="mb-8 text-center text-gray-400">Entre para continuar</p>

          {error ? (
            <div className="mb-6 rounded-lg border border-red-900/40 bg-red-900/20 p-4">
              <p className="text-center text-red-200 text-sm">
                {error === "AccessDenied"
                  ? "Acesso negado para este domínio."
                  : error === "Configuration"
                    ? "Configuração OAuth inválida. Verifique AUTH_GOOGLE_ID e AUTH_GOOGLE_SECRET."
                    : "Erro ao fazer login. Tente novamente."}
              </p>
            </div>
          ) : null}

          <button
            className="flex w-full cursor-pointer items-center justify-center gap-3 rounded-full border border-[#2a2f3c] bg-[#1a1d27] px-6 py-3 font-medium text-gray-100 shadow-lg shadow-black/20 transition-colors hover:border-[#3a3f4f]"
            onClick={handleGoogleLogin}
            type="button"
          >
            <LogoGoogle size={20} />
            Entrar com Google
          </button>

          <p className="mt-6 text-center text-gray-500 text-xs">
            Use sua conta corporativa para acessar
          </p>
        </div>
      </div>
    </div>
  );
}
