import { BrowserRouter, HashRouter, MemoryRouter, Navigate, Route, Routes } from 'react-router-dom'
import { ToastProvider } from './components/ui'
import { NotFound } from './pages/NotFound'
import { LoginPage } from './pages/staff/LoginPage'
import { MenuManager } from './pages/staff/MenuManager'
import { OrdersBoard } from './pages/staff/OrdersBoard'
import { PrintQrPage } from './pages/staff/PrintQrPage'
import { ReportsPage } from './pages/staff/ReportsPage'
import { SettingsPage } from './pages/staff/SettingsPage'
import { RequireStaff, StaffLayout } from './pages/staff/StaffLayout'
import { CartPage } from './pages/student/CartPage'
import { MenuPage } from './pages/student/MenuPage'
import { MyOrdersPage } from './pages/student/MyOrdersPage'
import { OrderPage } from './pages/student/OrderPage'
import { TableEntry } from './pages/student/TableEntry'
import { CartProvider } from './state/cart'
import { PublicDataProvider } from './state/publicData'
import { StaffSessionProvider } from './state/staffSession'

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<MenuPage />} />
      <Route path="/t/:label" element={<TableEntry />} />
      <Route path="/cart" element={<CartPage />} />
      <Route path="/order/:id" element={<OrderPage />} />
      <Route path="/orders" element={<MyOrdersPage />} />

      <Route path="/staff/login" element={<LoginPage />} />
      <Route path="/staff/print-qr" element={<RequireStaff ownerOnly><PrintQrPage /></RequireStaff>} />
      <Route path="/staff" element={<RequireStaff><StaffLayout /></RequireStaff>}>
        <Route index element={<OrdersBoard />} />
        <Route path="menu" element={<MenuManager />} />
        <Route path="reports" element={<RequireStaff ownerOnly><ReportsPage /></RequireStaff>} />
        <Route path="settings" element={<RequireStaff ownerOnly><SettingsPage /></RequireStaff>} />
        <Route path="*" element={<Navigate to="/staff" replace />} />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  )
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <PublicDataProvider>
        <StaffSessionProvider>
          <CartProvider>{children}</CartProvider>
        </StaffSessionProvider>
      </PublicDataProvider>
    </ToastProvider>
  )
}

// Hash/memory routing is only for static previews that can't rewrite deep links to index.html.
const Router = import.meta.env.VITE_ROUTER === 'hash' ? HashRouter : import.meta.env.VITE_ROUTER === 'memory' ? MemoryRouter : BrowserRouter

export default function App() {
  return (
    <Router>
      <Providers>
        <AppRoutes />
      </Providers>
    </Router>
  )
}
