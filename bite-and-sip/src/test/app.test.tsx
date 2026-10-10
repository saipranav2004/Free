// Component tests that drive real screens on top of the in-browser demo backend.
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

vi.stubEnv('VITE_DEMO_MODE', 'true')

async function renderApp(path: string) {
  const { AppRoutes, Providers } = await import('../App')
  const user = userEvent.setup()
  render(
    <MemoryRouter initialEntries={[path]}>
      <Providers>
        <AppRoutes />
      </Providers>
    </MemoryRouter>,
  )
  return user
}

describe('student menu', () => {
  it('shows the menu with categories, search and sold-out items', async () => {
    const user = await renderApp('/')
    await screen.findByRole('heading', { name: /order from your seat/i })
    expect(screen.getByRole('heading', { name: /Beverages/ })).toBeInTheDocument()
    expect(screen.getAllByText('Sold out').length).toBeGreaterThan(0)

    await user.type(screen.getByRole('searchbox', { name: /search the menu/i }), 'maggi')
    expect(screen.queryByRole('heading', { name: /Beverages/ })).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /Maggi.*View details/ }).length).toBe(2)

    await user.clear(screen.getByRole('searchbox', { name: /search the menu/i }))
    await user.type(screen.getByRole('searchbox', { name: /search the menu/i }), 'pasta')
    expect(screen.getByText(/Nothing matches/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /show the full menu/i }))
    await user.click(screen.getByRole('button', { name: 'Snacks' }))
    expect(screen.getByRole('button', { name: 'Snacks' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('heading', { name: /Beverages/ })).not.toBeInTheDocument()
  })

  it('customises an item and keeps a correct cart total', async () => {
    const user = await renderApp('/t/T12')
    await screen.findByText(/Table T12/)
    await user.click(screen.getByRole('button', { name: /College Special Maggi, ₹40/ }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByLabelText(/Extra Cheese/))
    await user.click(within(dialog).getByLabelText(/Extra Masala/))
    await user.click(within(dialog).getByRole('button', { name: /Increase/ }))
    expect(within(dialog).getByRole('button', { name: /Add to cart · ₹120/ })).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: /Add to cart/ }))
    await user.click(screen.getByRole('button', { name: 'Add Masala Chai' }))
    expect(await screen.findByText('₹135')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Increase Masala Chai' }))
    expect(screen.getByText('₹150')).toBeInTheDocument()
  })
})

describe('checkout', () => {
  async function cartWithChai() {
    const user = await renderApp('/')
    await screen.findByRole('heading', { name: /order from your seat/i })
    await user.click(screen.getByRole('button', { name: 'Add Masala Chai' }))
    await user.click(screen.getByRole('button', { name: /View cart/ }))
    await screen.findByRole('heading', { name: 'Your details' })
    return user
  }

  it('validates name, phone and payment method before ordering', async () => {
    const user = await cartWithChai()
    await user.click(screen.getByRole('button', { name: /Place order · ₹15/ }))
    expect(screen.getByText(/Please enter your name/)).toBeInTheDocument()
    expect(screen.getByText(/Please enter your mobile number/)).toBeInTheDocument()
    expect(screen.getByText(/Choose how you’ll pay/)).toBeInTheDocument()
    await user.type(screen.getByLabelText('Mobile number'), '12345')
    await user.type(screen.getByLabelText('Name'), 'Nikitha')
    expect(screen.queryByText(/Please enter your name/)).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Place order/ }))
    expect(screen.getByText(/valid 10-digit/)).toBeInTheDocument()
  })

  it('places a cash order and shows the tracking page', async () => {
    const user = await cartWithChai()
    await user.type(screen.getByLabelText('Name'), 'Nikitha')
    await user.type(screen.getByLabelText('Mobile number'), '9876543210')
    await user.click(screen.getByLabelText(/Cash at the counter/))
    await user.click(screen.getByRole('button', { name: /Place order · ₹15/ }))
    expect(await screen.findByText('Order received', {}, { timeout: 4000 })).toBeInTheDocument()
    expect(screen.getByText(/in cash at the counter when you collect/)).toHaveTextContent('Pay ₹15 in cash at the counter')
    expect(JSON.parse(localStorage.getItem('bitesip-cart-v1')!)).toEqual([])
    expect(JSON.parse(localStorage.getItem('bitesip-my-orders-v1')!)).toHaveLength(1)
  })

  it('blocks ordering while the café is closed', async () => {
    const { backend } = await import('../backend')
    await backend.signIn('owner@demo.bitesip', 'demo-owner')
    await backend.updateSettings({ is_open: false })
    await backend.signOut()
    const user = await renderApp('/')
    await screen.findByText(/We’re closed right now/)
    expect(screen.getByRole('button', { name: 'Add Masala Chai' })).toBeDisabled()
    void user
  })
})

describe('staff access', () => {
  it('redirects to login and rejects wrong passwords', async () => {
    const user = await renderApp('/staff/reports')
    await screen.findByRole('heading', { name: 'Staff sign in' })
    await user.type(screen.getByLabelText('Email'), 'kitchen@demo.bitesip')
    await user.type(screen.getByLabelText('Password'), 'wrong')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText(/incorrect/)).toBeInTheDocument()
  })

  it('kitchen staff cannot open owner pages', async () => {
    const { backend } = await import('../backend')
    await backend.signIn('kitchen@demo.bitesip', 'demo-kitchen')
    await renderApp('/staff/settings')
    await screen.findByRole('heading', { name: 'Orders' })
    expect(screen.queryByRole('link', { name: /Settings/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Reports/ })).not.toBeInTheDocument()
    await backend.signOut()
  })

  it('owner sees reconciled reports', async () => {
    const { backend } = await import('../backend')
    await backend.signIn('owner@demo.bitesip', 'demo-owner')
    await renderApp('/staff/reports')
    await screen.findByRole('heading', { name: 'Where the money is' })
    await waitFor(() => expect(screen.getByText(/Cash collected \+ UPI confirmed/)).toBeInTheDocument())
    await backend.signOut()
  })
})
