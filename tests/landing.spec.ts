import { test, expect } from '@playwright/test'

test.describe('Landing Page', () => {
  test('loads and shows hero content', async ({ page }) => {
    await page.goto('/')
    await page.waitForURL(/\/(landing|auth)?/, { timeout: 10000 })

    await expect(page.getByText('Find your center')).toBeVisible({ timeout: 10000 })
    await expect(page.getByText('Grow together')).toBeVisible()
  })

  test('shows navigation bar with hero CTA', async ({ page }) => {
    await page.goto('/landing')

    const brand = page.locator('text=Janata >> visible=true').first()
    await expect(brand).toBeVisible({ timeout: 10000 })

    const startExploring = page.getByText(/Start Exploring/i).first()
    await expect(startExploring).toBeVisible({ timeout: 10000 })
  })

  test('hero Start Exploring button navigates to Explore', async ({ page }) => {
    await page.goto('/landing')

    const startExploring = page.getByText(/Start Exploring/i).first()
    await expect(startExploring).toBeVisible({ timeout: 10000 })
    await startExploring.click()

    await page.waitForURL(/\/explore/, { timeout: 10000 })
  })

  test('final browse button navigates to Explore', async ({ page }) => {
    await page.goto('/landing')

    const browse = page.getByText(/Browse events nearby/i).first()
    await browse.scrollIntoViewIfNeeded()
    await expect(browse).toBeVisible({ timeout: 10000 })
    await browse.click()

    await page.waitForURL(/\/explore/, { timeout: 10000 })
  })

  test('page has no critical console errors (excluding WebGL)', async ({ page }) => {
    const errors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        errors.push(msg.text())
      }
    })

    await page.goto('/landing')
    await page.waitForLoadState('networkidle')

    // Filter out expected errors (WebGL not available in headless, resource loads)
    const criticalErrors = errors.filter(
      (e) =>
        !e.includes('favicon') &&
        !e.includes('manifest') &&
        !e.includes('Failed to load resource') &&
        !e.includes('WebGL') &&
        !e.includes('webglcontextcreationerror')
    )

    expect(criticalErrors).toHaveLength(0)
  })

  test('landing page is responsive', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/landing')
    await expect(page.getByText('Find your center')).toBeVisible({ timeout: 10000 })

    await page.setViewportSize({ width: 768, height: 1024 })
    await expect(page.getByText('Find your center')).toBeVisible()

    await page.setViewportSize({ width: 375, height: 812 })
    await expect(page.getByText('Find your center')).toBeVisible()
  })
})
