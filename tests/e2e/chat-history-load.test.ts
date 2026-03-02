import { expect, test } from "@playwright/test";

test.describe("Chat History Loading", () => {
  test("loads conversation messages when clicking sidebar item", async ({
    page,
  }) => {
    // 1. Go to home and send a message to create a conversation
    await page.goto("/");
    const input = page.getByTestId("multimodal-input");
    await input.fill("Olá, me diga qual é 2+2?");
    await page.getByTestId("send-button").click();

    // 2. Wait for assistant response
    const assistantMessage = page.locator("[data-role='assistant']").first();
    await expect(assistantMessage).toBeVisible({ timeout: 60_000 });

    // 3. URL should have changed to /chat/:id
    await expect(page).toHaveURL(/\/chat\/[\w-]+/, { timeout: 10_000 });
    const chatUrl = page.url();
    const chatId = chatUrl.split("/chat/")[1];

    // 4. Capture the user message text to verify later
    const userMessage = page.locator("[data-role='user']").first();
    await expect(userMessage).toBeVisible();

    // 5. Navigate to home page to leave the current chat
    await page.goto("/");
    await expect(page.getByTestId("multimodal-input")).toBeVisible();

    // 6. Wait for sidebar to load conversations
    const sidebarLink = page.locator(`a[href="/chat/${chatId}"]`);
    await expect(sidebarLink).toBeVisible({ timeout: 15_000 });

    // 7. Click the conversation in the sidebar
    await sidebarLink.click();

    // 8. Verify URL changed to the chat
    await expect(page).toHaveURL(`/chat/${chatId}`, { timeout: 10_000 });

    // 9. Verify messages are loaded - both user and assistant messages should be visible
    const loadedUserMessage = page.locator("[data-role='user']").first();
    await expect(loadedUserMessage).toBeVisible({ timeout: 30_000 });

    const loadedAssistantMessage = page
      .locator("[data-role='assistant']")
      .first();
    await expect(loadedAssistantMessage).toBeVisible({ timeout: 30_000 });

    // 10. Verify assistant message has actual content (not empty)
    const assistantContent = await loadedAssistantMessage.textContent();
    expect(assistantContent?.length).toBeGreaterThan(0);
  });

  test("loads different conversations correctly when switching between them", async ({
    page,
  }) => {
    // Create first conversation
    await page.goto("/");
    const input = page.getByTestId("multimodal-input");
    await input.fill("Primeira conversa: quanto é 1+1?");
    await page.getByTestId("send-button").click();

    const firstAssistant = page.locator("[data-role='assistant']").first();
    await expect(firstAssistant).toBeVisible({ timeout: 60_000 });
    await expect(page).toHaveURL(/\/chat\/[\w-]+/, { timeout: 10_000 });

    const firstChatUrl = page.url();
    const firstChatId = firstChatUrl.split("/chat/")[1];

    // Create second conversation
    await page.goto("/");
    await expect(page.getByTestId("multimodal-input")).toBeVisible();

    const input2 = page.getByTestId("multimodal-input");
    await input2.fill("Segunda conversa: quanto é 3+3?");
    await page.getByTestId("send-button").click();

    const secondAssistant = page.locator("[data-role='assistant']").first();
    await expect(secondAssistant).toBeVisible({ timeout: 60_000 });
    await expect(page).toHaveURL(/\/chat\/[\w-]+/, { timeout: 10_000 });

    const secondChatUrl = page.url();
    const secondChatId = secondChatUrl.split("/chat/")[1];

    // Now click on the FIRST conversation in the sidebar
    const firstChatLink = page.locator(`a[href="/chat/${firstChatId}"]`);
    await expect(firstChatLink).toBeVisible({ timeout: 15_000 });
    await firstChatLink.click();

    await expect(page).toHaveURL(`/chat/${firstChatId}`, { timeout: 10_000 });

    // Verify first conversation messages are loaded
    const loadedUser1 = page.locator("[data-role='user']").first();
    await expect(loadedUser1).toBeVisible({ timeout: 30_000 });
    await expect(loadedUser1).toContainText("1+1");

    // Now click on the SECOND conversation in the sidebar
    const secondChatLink = page.locator(`a[href="/chat/${secondChatId}"]`);
    await expect(secondChatLink).toBeVisible({ timeout: 15_000 });
    await secondChatLink.click();

    await expect(page).toHaveURL(`/chat/${secondChatId}`, { timeout: 10_000 });

    // Verify second conversation messages are loaded (not first conversation's messages)
    const loadedUser2 = page.locator("[data-role='user']").first();
    await expect(loadedUser2).toBeVisible({ timeout: 30_000 });
    await expect(loadedUser2).toContainText("3+3");
  });
});
