CREATE TABLE IF NOT EXISTS "ChatProviderSession" (
	"chatId" uuid NOT NULL,
	"provider" varchar(64) NOT NULL,
	"sessionId" text NOT NULL,
	"userId" uuid NOT NULL,
	"createdAt" timestamp NOT NULL,
	"updatedAt" timestamp NOT NULL,
	CONSTRAINT "ChatProviderSession_chatId_provider_pk" PRIMARY KEY("chatId","provider")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ChatProviderSession" ADD CONSTRAINT "ChatProviderSession_chatId_Chat_id_fk" FOREIGN KEY ("chatId") REFERENCES "public"."Chat"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ChatProviderSession" ADD CONSTRAINT "ChatProviderSession_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
