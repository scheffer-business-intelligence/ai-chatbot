import { expect, test } from "@playwright/test";

test.describe("Authentication Pages", () => {
  test("login page renders google-only access", async ({ page }) => {
    await page.goto("/login");
    await expect(
      page.getByRole("button", { name: "Entrar com Google" })
    ).toBeVisible();
    await expect(
      page.getByText("Somente emails @scheffer.agr.br.")
    ).toBeVisible();
    await expect(
      page.getByAltText("Ilustração de inteligência artificial")
    ).toBeVisible();
  });

  test("login page shows access denied error", async ({ page }) => {
    await page.goto("/login?error=AccessDenied");
    await expect(
      page.getByText("Acesso negado para este domínio.")
    ).toBeVisible();
  });

  test("register route redirects to login", async ({ page }) => {
    await page.goto("/register");
    await expect(page).toHaveURL("/login");
  });
});
