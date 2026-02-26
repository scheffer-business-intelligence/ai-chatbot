"use client";

import Image from "next/image";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { Suspense, useState } from "react";
import { LogoGoogle } from "@/components/icons";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

function getLoginErrorMessage(error: string | null) {
  if (!error) {
    return null;
  }

  if (error === "AccessDenied") {
    return "Acesso negado para este domínio.";
  }

  if (error === "Configuration") {
    return "Configuração OAuth inválida. Verifique AUTH_GOOGLE_ID e AUTH_GOOGLE_SECRET.";
  }

  return "Erro ao fazer login. Tente novamente.";
}

export default function Page() {
  return (
    <Suspense fallback={<div className="min-h-svh bg-background" />}>
      <LoginPage />
    </Suspense>
  );
}

function LoginPage() {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const searchParams = useSearchParams();
  const error = searchParams.get("error");
  const callbackUrl = searchParams.get("callbackUrl") || "/";
  const errorMessage = getLoginErrorMessage(error);

  const handleGoogleLogin = async () => {
    if (isSubmitting) {
      return;
    }

    setIsSubmitting(true);

    try {
      await signIn(
        "google",
        { callbackUrl },
        {
          prompt: "select_account",
          hd: "scheffer.agr.br",
        }
      );
    } catch {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="grid min-h-svh lg:grid-cols-2">
      <div className="flex flex-col gap-4 p-6 md:p-10">
        <div className="flex justify-center gap-2 md:justify-start">
          <Link className="flex items-center gap-2 font-medium" href="/">
            <Image
              alt="Scheffer"
              className="rounded-sm"
              height={24}
              priority
              src="/images/scheffer-icon.png"
              width={24}
            />
            <Image
              alt="Scheffer Agente"
              className="h-5 w-auto"
              height={29}
              priority
              src="/images/scheffer-logo.png"
              width={196}
            />
          </Link>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <div className="w-full max-w-xs">
            <div className="flex flex-col gap-6">
              <div className="flex flex-col items-center gap-2 text-center">
                <h1 className="font-bold text-2xl">Entrar na sua conta</h1>
                <p className="text-muted-foreground text-sm text-balance">
                  Entre com sua conta Google corporativa para acessar o sistema.
                </p>
              </div>

              {errorMessage ? (
                <Alert variant="destructive">
                  <AlertDescription className="text-center">
                    {errorMessage}
                  </AlertDescription>
                </Alert>
              ) : null}

              <Button
                className="w-full cursor-pointer gap-3"
                disabled={isSubmitting}
                onClick={handleGoogleLogin}
                type="button"
                variant="outline"
              >
                <LogoGoogle size={20} />
                {isSubmitting ? "Redirecionando..." : "Entrar com Google"}
              </Button>

              <p className="text-center text-muted-foreground text-xs">
                Somente emails @scheffer.agr.br.
              </p>
            </div>
          </div>
        </div>
      </div>
      <div className="bg-muted relative hidden lg:flex items-center justify-center">
        <div className="relative h-1/2 w-1/2">
          <Image
            alt="Ilustração de inteligência artificial"
            className="object-contain"
            fill
            priority
            sizes="25vw"
            src="/images/login-hero.png"
            unoptimized
          />
        </div>
      </div>
    </div>
  );
}
