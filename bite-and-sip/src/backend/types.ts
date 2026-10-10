import type {
  CafeSettings, CafeTable, Category, CustomerOrder, Menu, OrderStatus, PlaceOrderInput, SalesSummary,
  StaffMember, StaffOrder, StaffProfile, StaffRole,
} from '../lib/types'

export type LiveStatus = 'connecting' | 'live' | 'offline'

export interface PublicData {
  settings: CafeSettings
  menu: Menu
  tables: CafeTable[]
}

export interface MenuItemInput {
  id?: string
  category_id: string
  name: string
  description: string
  price: number
  is_veg: boolean
  is_available: boolean
  is_popular: boolean
  image_path: string | null
  addons: { id?: string; name: string; price: number; is_available: boolean }[]
}

export interface StatusChange {
  /** Expected current status — the update fails with `conflict` if someone changed it first. */
  from: OrderStatus
  to: OrderStatus
  /** Mark the order paid in the same atomic update (cash collected at handover). */
  markPaid?: boolean
  reason?: string
}

export interface Backend {
  readonly mode: 'supabase' | 'demo'

  // Public (students)
  getPublicData(): Promise<PublicData>
  placeOrder(input: PlaceOrderInput): Promise<CustomerOrder>
  getOrder(id: string, token: string): Promise<CustomerOrder>
  getOrders(refs: { id: string; token: string }[]): Promise<CustomerOrder[]>
  reportUpiPayment(id: string, token: string): Promise<CustomerOrder>
  cancelMyOrder(id: string, token: string): Promise<CustomerOrder>
  /** Notifies when the order changes. The callback carries no data: refetch with getOrder. */
  watchOrder(trackKey: string, onChange: () => void, onStatus: (s: LiveStatus) => void): () => void
  imageUrl(path: string | null): string | null

  // Staff auth
  getStaffSession(): Promise<StaffProfile | null>
  signIn(email: string, password: string): Promise<StaffProfile>
  signOut(): Promise<void>
  onAuthChange(cb: () => void): () => void

  // Orders
  listOrdersSince(sinceIso: string): Promise<StaffOrder[]>
  listOrdersInRange(fromDay: string, toDay: string): Promise<StaffOrder[]>
  changeStatus(id: string, change: StatusChange): Promise<StaffOrder>
  setPayment(id: string, paid: boolean, reference?: string): Promise<StaffOrder>
  /** Notifies when any order changes. Refetch to stay authoritative. */
  watchOrders(onChange: (orderId: string | null) => void, onStatus: (s: LiveStatus) => void): () => void

  // Menu
  saveMenuItem(input: MenuItemInput): Promise<string>
  deleteMenuItem(id: string): Promise<void>
  setItemAvailability(id: string, available: boolean): Promise<void>
  setAddonAvailability(id: string, available: boolean): Promise<void>
  uploadImage(file: Blob): Promise<string>
  removeImage(path: string): Promise<void>
  createCategory(name: string): Promise<Category>
  updateCategory(id: string, patch: Partial<Pick<Category, 'name' | 'sort_order'>>): Promise<void>
  deleteCategory(id: string): Promise<void>

  // Owner
  updateSettings(patch: Partial<Omit<CafeSettings, 'updated_at'>>): Promise<CafeSettings>
  addTables(labels: string[]): Promise<void>
  setTableActive(label: string, active: boolean): Promise<void>
  deleteTable(label: string): Promise<void>
  listStaff(): Promise<StaffMember[]>
  updateStaff(userId: string, patch: Partial<{ role: StaffRole; is_active: boolean; display_name: string }>): Promise<void>
  salesSummary(fromDay: string, toDay: string): Promise<SalesSummary>
}
