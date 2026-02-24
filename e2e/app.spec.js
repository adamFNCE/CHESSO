const { test, expect } = require('@playwright/test');

const TEST_WALLET = '0x1111111111111111111111111111111111111111';

async function mockWallet(page, address = TEST_WALLET) {
  await page.addInitScript((injectedAddress) => {
    const provider = {
      request: async ({ method }) => {
        if (method === 'eth_requestAccounts') return [injectedAddress];
        if (method === 'eth_accounts') return [injectedAddress];
        throw new Error(`Unsupported method: ${method}`);
      }
    };

    window.ethereum = provider;
    window.lukso = provider;
  }, address);
}

test.beforeEach(async ({ page }) => {
  await mockWallet(page);
});

test('welcome -> open lobby shows board preview box', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('button', { name: 'Open Lobby' })).toBeVisible();
  await page.getByRole('button', { name: 'Open Lobby' }).click();

  await expect(page.getByText('Game Preview')).toBeVisible();
  await expect(page.getByText('Create or join a room to start.')).toBeVisible();
});

test('buttons: connect wallet, create room, enter chat, send message', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: 'Open Lobby' }).click();
  await page.getByRole('button', { name: 'Connect UP Wallet' }).click();

  await expect(page.getByText('UP: 0x11111111...')).toBeVisible();

  await page.getByRole('button', { name: 'Create Room' }).click();

  await expect(page.getByRole('heading', { name: 'Moves' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Chat' })).toBeVisible();

  const usernameInput = page.getByPlaceholder('Choose a chat username');
  await expect(usernameInput).toBeVisible();
  await usernameInput.fill('StreetKing');
  await page.getByRole('button', { name: 'Enter Chat' }).click();

  await expect(page.getByText('Logged in as')).toBeVisible();
  await expect(page.getByText('StreetKing')).toBeVisible();

  const msgInput = page.getByPlaceholder('Type message');
  await msgInput.fill('gg');
  await page.getByRole('button', { name: 'Send' }).click();

  await expect(page.locator('.chat-messages .chat-msg').last()).toContainText('gg');
});
