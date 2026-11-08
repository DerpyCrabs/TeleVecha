import { test } from '@playwright/test';
import { expect } from './expect';
import { openReady } from './helpers';

for (const width of [375, 768, 1280]) {
  test(`privacy changes remain drafts until saved at ${width}px`, async ({ page }, testInfo) => {
    await openReady(page);
    await page.getByRole('button', { name: 'Open main menu' }).click();
    await page.getByRole('button', { name: 'Open settings' }).click();
    await page.setViewportSize({ width, height: 800 });
    await page.getByRole('button', { name: 'Privacy', exact: true }).click();
    const privacy = page.getByRole('dialog', { name: 'Privacy', exact: true });
    await expect(privacy.locator('.privacy-setting-row')).toHaveCount(12);
    await privacy.getByRole('button', { name: /Phone number My Contacts/ }).click();
    const editor = page.getByRole('dialog', { name: 'Phone number', exact: true });
    const serverRules = () =>
      page.evaluate(async () => {
        const r = [...window.__televechaRuntimes!.values()][0]!;
        return (await r.runEffect(r.engine.getPrivacy('phone-number'))).rules;
      });
    const original = await serverRules();
    await editor.getByRole('radio', { name: 'Nobody', exact: true }).check();
    await editor.getByRole('button', { name: /Always allow/ }).click();
    const exceptions = page.getByRole('dialog', { name: 'Privacy exceptions', exact: true });
    await exceptions.getByRole('button', { name: 'Add users or groups' }).click();
    await page
      .getByRole('dialog', { name: 'Choose privacy exception' })
      .getByRole('button', { name: /Alice Fixture/ })
      .click();
    await expect(exceptions).toContainText('Alice Fixture');
    await page.screenshot({ path: testInfo.outputPath('privacy-exceptions.png') });
    await exceptions.getByRole('button', { name: 'Done', exact: true }).click();
    expect(await serverRules()).toEqual(original);
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(editor).toHaveCount(0);
    const saved = await serverRules();
    expect(saved).toContainEqual({ kind: 'deny-all' });
    expect(saved).toContainEqual(
      expect.objectContaining({
        kind: 'allow-users',
        users: [expect.objectContaining({ id: 'u:101' })],
      }),
    );
    await privacy.getByRole('button', { name: /Phone number Nobody/ }).click();
    await editor.getByRole('radio', { name: 'Everybody', exact: true }).check();
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(await serverRules()).toEqual(saved);
    await privacy.getByRole('checkbox', { name: 'Hide read time' }).check();
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const r = [...window.__televechaRuntimes!.values()][0]!;
          return r.runEffect(r.engine.getReadTimePrivacy());
        }),
      )
      .toBe(true);
  });

  test(`device management preserves this session at ${width}px`, async ({ page }, testInfo) => {
    await openReady(page);
    await page.getByRole('button', { name: 'Open main menu' }).click();
    await page.getByRole('button', { name: 'Open settings' }).click();
    await page.setViewportSize({ width, height: 800 });
    await page.getByRole('button', { name: 'Devices', exact: true }).click();
    const devices = page.getByRole('dialog', { name: 'Devices', exact: true });
    await expect(devices.locator('.device-row')).toHaveCount(3);
    await page.screenshot({ path: testInfo.outputPath('devices.png') });
    await devices.getByRole('button', { name: /Fixture browser/ }).click();
    const details = page.getByRole('dialog', { name: 'Device details' });
    await expect(details.getByRole('button', { name: 'Terminate session' })).toHaveCount(0);
    await details.getByRole('button', { name: 'Cancel', exact: true }).click();
    await devices.getByRole('button', { name: /Pixel 8/ }).click();
    await details.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(devices.locator('.device-row')).toHaveCount(3);
    await devices.getByRole('button', { name: /Pixel 8/ }).click();
    await details.getByRole('button', { name: 'Terminate session', exact: true }).click();
    await expect(devices.locator('.device-row')).toHaveCount(2);
    await devices.getByRole('combobox', { name: 'Session inactivity period' }).selectOption('30');
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const r = [...window.__televechaRuntimes!.values()][0]!;
          return (await r.runEffect(r.engine.getActiveSessions())).ttlDays;
        }),
      )
      .toBe(30);
    await devices
      .getByRole('button', { name: 'Terminate all other sessions', exact: true })
      .click();
    await page
      .getByRole('dialog', { name: 'Terminate other sessions' })
      .getByRole('button', { name: 'Terminate all', exact: true })
      .click();
    await expect(devices.locator('.device-row')).toHaveCount(1);
    await expect(devices.locator('.device-row')).toContainText('Fixture browser');
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const r = [...window.__televechaRuntimes!.values()][0]!;
          return (await r.runEffect(r.engine.getActiveSessions())).sessions.map((s) => s.current);
        }),
      )
      .toEqual([true]);
  });
}
