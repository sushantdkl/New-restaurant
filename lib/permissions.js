/**
 * Admin-configurable permissions for staff pages and actions. The catalog is
 * shared by navigation, direct-route guards and API guards so a control is not
 * merely hidden in the UI while remaining callable on the server.
 */
import { ensureColumn, serialPkSql } from './db/schema-helpers.js';
import { ensureSqliteTable } from './db/ensure-sqlite-table.js';

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };

export const MANAGED_ROLES = ['waiter', 'cashier', 'kitchen'];

export const PERMISSION_CATALOG = [
  { key: 'report.profitability.view', label: 'Purchase, consumption & profitability analytics', category: 'Reports: Individual', roles: ['cashier'], description: 'View confidential purchase costs, ingredient consumption and gross margins. Off by default.' },
  { key: 'orders.view', label: 'View orders', category: 'Orders', description: 'View active and historical orders.' },
  { key: 'orders.create', label: 'Create orders', category: 'Orders', description: 'Start an order and add its initial items.' },
  { key: 'orders.update', label: 'Update orders', category: 'Orders', description: 'Change order details, status and unsent items.' },
  { key: 'orders.cancel', label: 'Cancel an order', category: 'Orders', description: 'Cancel or void an in-progress order from POS/admin.' },
  { key: 'orders.cancel_item', label: 'Remove a sent item', category: 'Orders', description: 'Remove an already-sent item from an order.' },
  { key: 'menu.view', label: 'View menu', category: 'Menu & Tables', description: 'View menu items and categories while taking orders.' },
  { key: 'tables.view', label: 'View tables', category: 'Menu & Tables', description: 'View table availability and current occupancy.' },
  { key: 'tables.update', label: 'Update table status', category: 'Menu & Tables', description: 'Change table state, assign a waiter and clear a finished table.' },
  { key: 'kots.view', label: 'View KOTs', category: 'Kitchen', description: 'View kitchen order tickets.' },
  { key: 'kots.create', label: 'Send KOTs', category: 'Kitchen', description: 'Send order items to the kitchen.' },
  { key: 'kots.update', label: 'Update KOT status', category: 'Kitchen', description: 'Accept, prepare and complete kitchen tickets.' },
  { key: 'kots.reprint', label: 'Reprint a KOT', category: 'Kitchen', description: 'Print another copy of a kitchen ticket.' },
  { key: 'kots.cancel', label: 'Cancel a KOT', category: 'Kitchen', description: 'Cancel a kitchen order ticket.' },
  { key: 'bills.view', label: 'View bills', category: 'Billing', description: 'View bill amounts and details.' },
  { key: 'bills.request', label: 'Request a bill', category: 'Billing', description: 'Prepare or request a bill for an open order.' },
  { key: 'bills.pay', label: 'Collect bill payments', category: 'Billing', description: 'Settle a bill using Cash or Online.' },
  { key: 'bills.reprint', label: 'Reprint receipts', category: 'Billing', description: 'Print another copy of a bill or receipt.' },
  { key: 'bills.revise_settlement', label: 'Correct bill settlement', category: 'Billing', roles: ['cashier'], description: 'Correct payment allocations on a settled bill with an audit reason.' },
  { key: 'bills.void', label: 'Void a paid bill', category: 'Billing', description: 'Void a bill that has already been paid.' },
  { key: 'bills.refund', label: 'Refund a bill', category: 'Billing', description: 'Issue a full or partial refund on a bill.' },
  { key: 'bills.reopen', label: 'Reopen a closed bill', category: 'Billing', description: 'Reopen a paid bill to add or change items.' },
  { key: 'bills.discount', label: 'Apply a discount', category: 'Billing', description: 'Apply or override a discount on a bill.' },
  { key: 'credit.writeoff', label: 'Discount customer credit', category: 'Billing', roles: ['cashier'], description: 'Reduce an existing customer credit balance with a recorded reason and audit trail.' },
  { key: 'credit.payment_method_correct', label: 'Correct credit payment method', category: 'Billing', roles: ['cashier'], description: 'Change a received customer-credit payment between Cash and Online. Off for cashiers by default.' },
  { key: 'customers.delete', label: 'Delete a customer', category: 'Cashier: Core', roles: ['cashier'], description: 'Permanently remove a customer record. Off by default — customers with history should normally be kept.' },
  { key: 'purchases.view', label: 'View purchases', category: 'Purchases & Suppliers', roles: ['cashier'], description: 'View purchase history, delivery lines and linked stock/expense records.' },
  { key: 'purchases.create', label: 'Receive a purchase', category: 'Purchases & Suppliers', roles: ['cashier'], description: 'Record a received delivery and update inventory and expenses.' },
  { key: 'purchases.import', label: 'Import purchases', category: 'Purchases & Suppliers', roles: ['cashier'], description: 'Upload and commit multiple invoice lines from CSV after previewing them.' },
  { key: 'purchases.edit', label: 'Edit a purchase', category: 'Purchases & Suppliers', roles: ['cashier'], description: 'Correct an existing delivery and safely re-apply its stock movement.' },
  { key: 'purchases.payment_method_correct', label: 'Correct purchase payment method', category: 'Purchases & Suppliers', roles: ['cashier'], description: 'Reclassify how an existing purchase was paid, with a required audit reason. Off by default.' },
  { key: 'purchases.void', label: 'Void a purchase', category: 'Purchases & Suppliers', roles: ['cashier'], description: 'Reverse a purchase from the current business day, its stock and its linked expense.' },
  { key: 'purchases.void_previous_day', label: 'Void previous-day purchase', category: 'Purchases & Suppliers', roles: ['cashier'], description: 'Also void purchases dated to an earlier business day. This changes the cash and stock of that earlier day. Off by default.' },
  { key: 'suppliers.view', label: 'View suppliers', category: 'Purchases & Suppliers', roles: ['cashier'], description: 'View supplier contact details and purchase history.' },
  { key: 'suppliers.manage', label: 'Create or edit suppliers', category: 'Purchases & Suppliers', roles: ['cashier'], description: 'Create suppliers and update their contact details. Supplier merging remains admin-only.' },
  { key: 'payroll.view', label: 'View salary & advances', category: 'Payroll', roles: ['cashier'], description: 'View employee salary amounts, advance balances and payroll history.' },
  { key: 'payroll.advances.create', label: 'Give salary advances', category: 'Payroll', roles: ['cashier'], description: 'Pay and record a salary advance for an employee.' },
  { key: 'payroll.payments.create', label: 'Record salary payments', category: 'Payroll', roles: ['cashier'], description: 'Record a salary payment. Off for cashiers by default.' },
  { key: 'payroll.records.delete', label: 'Delete payroll records', category: 'Payroll', roles: ['cashier'], description: 'Delete a salary payment or advance. Off for cashiers by default.' },
  { key: 'reports.view', label: 'Show Reports section', category: 'Reports: Access', roles: ['cashier'], description: 'Show the Reports section in the cashier workspace. Individual reports can be allowed below.' },
  { key: 'report.sales.view', label: 'Sales report', category: 'Reports: Individual', roles: ['cashier'], description: 'View invoices, payment splits, categories and daily sales.' },
  { key: 'report.finance.view', label: 'Finance report', category: 'Reports: Individual', roles: ['cashier'], description: 'View expenses, profit, tax and VAT figures. Off by default.' },
  { key: 'report.expenses.view', label: 'Expenses report', category: 'Reports: Individual', roles: ['cashier'], description: 'View detailed operating expenses. Off by default.' },
  { key: 'report.purchases.view', label: 'Purchases report', category: 'Reports: Individual', roles: ['cashier'], description: 'View received purchase invoices. Off by default.' },
  { key: 'report.suppliers.view', label: 'Suppliers report', category: 'Reports: Individual', roles: ['cashier'], description: 'View supplier-level spending. Off by default.' },
  { key: 'report.orders.view', label: 'Orders report', category: 'Reports: Individual', roles: ['cashier'], description: 'View order progress and order records.' },
  { key: 'report.changes.view', label: 'Cancellations & changes report', category: 'Reports: Individual', roles: ['cashier'], description: 'View cancellations, voids, refunds, revisions and discounts.' },
  { key: 'report.inventory.view', label: 'Inventory report', category: 'Reports: Individual', roles: ['cashier'], description: 'View current stock, movements and low-stock records.' },
  { key: 'report.employees.view', label: 'Employees report', category: 'Reports: Individual', roles: ['cashier'], description: 'View employee performance figures. Off by default.' },
  { key: 'report.tables.view', label: 'Tables report', category: 'Reports: Individual', roles: ['cashier'], description: 'View table performance and served orders.' },
  { key: 'report.reservations.view', label: 'Reservations report', category: 'Reports: Individual', roles: ['cashier'], description: 'View reservation and waiting-time records.' },
  { key: 'report.menu.view', label: 'Menu report', category: 'Reports: Individual', roles: ['cashier'], description: 'View item sales, food cost, profit and margin.' },
  { key: 'report.categories.view', label: 'Category report', category: 'Reports: Individual', roles: ['cashier'], description: 'View sales, profit and share by category.' },
  { key: 'report.customers.view', label: 'Customers report', category: 'Reports: Individual', roles: ['cashier'], description: 'View customer visits and lifetime value. Off by default.' },
  { key: 'report.previous_day.view', label: 'Previous-day activity report', category: 'Reports: Individual', roles: ['cashier'], description: 'View purchases and expenses belonging to earlier business days, and later changes that touched those days.' },
  { key: 'dashboard.view', label: 'View dashboard', category: 'Manager Workspace', roles: ['cashier'], description: 'View the live table dashboard and open or continue table orders.' },
  { key: 'analytics.view', label: 'View advanced analytics', category: 'Manager Workspace', roles: ['cashier'], description: 'View commercial, menu, payment and operational analytics. Off by default.' },
  { key: 'summary.view', label: 'View owner summary', category: 'Manager Workspace', roles: ['cashier'], description: 'View the owner-level period summary. Off by default.' },
  { key: 'menu.manage', label: 'Manage menu setup', category: 'Manager Workspace', roles: ['cashier'], description: 'Create and edit menu items, menu categories and recipes.' },
  { key: 'promotions.manage', label: 'Manage offers & discounts', category: 'Manager Workspace', roles: ['cashier'], description: 'Create, edit and disable promotions. Off by default.' },
  { key: 'combos.manage', label: 'Manage combo packs', category: 'Manager Workspace', roles: ['cashier'], description: 'Create, edit and disable combo packs. Off by default.' },
  { key: 'tables.manage', label: 'Manage tables & floor plan', category: 'Manager Workspace', roles: ['cashier'], description: 'Create and configure tables, floors, types and table QR codes. Off by default.' },
  { key: 'host_desk.manage', label: 'Manage host desk', category: 'Manager Workspace', roles: ['cashier'], description: 'Manage reservation leads and inquiries. Off by default.' },
  { key: 'kitchen_analytics.view', label: 'View kitchen analytics', category: 'Manager Workspace', description: 'View kitchen timing and throughput analytics.' },
  { key: 'delivery.manage', label: 'Manage delivery executives', category: 'Operations', description: 'View, create and update delivery executives and their assigned orders.' },
  { key: 'inventory.dashboard.view', label: 'View inventory dashboard', category: 'Inventory Controls', roles: ['cashier'], description: 'View inventory health, value, movement and consumption analytics.' },
  { key: 'inventory.movements.view', label: 'View stock movements', category: 'Inventory Controls', roles: ['cashier'], description: 'View the complete stock movement and stock-adjustment audit history.' },
  { key: 'inventory.view', label: 'View inventory items', category: 'Inventory Controls', description: 'View ingredient, stock and inventory item details used by the role.' },
  { key: 'inventory.setup.view', label: 'View inventory setup', category: 'Inventory Controls', description: 'View inventory categories and unit conversions.' },
  { key: 'recipes.view', label: 'View recipes', category: 'Inventory Controls', description: 'View menu recipes and ingredient requirements.' },
  { key: 'inventory.manage', label: 'Manage inventory items', category: 'Inventory Controls', roles: ['cashier'], description: 'Create, edit, archive and manually adjust inventory items. Quantity adjustments still require a reason.' },
  { key: 'inventory.setup.manage', label: 'Manage inventory setup', category: 'Inventory Controls', roles: ['cashier'], description: 'Manage inventory categories and unit conversions.' },
  { key: 'wastage.manage', label: 'Record and view wastage', category: 'Inventory Controls', description: 'Record wastage and view the complete wastage history.' },
  { key: 'expenses.manage', label: 'Record and view expenses', category: 'Cash & Accounting', roles: ['cashier'], description: 'View and record operating expenses.' },
  { key: 'expenses.payment_method_correct', label: 'Correct expense payment method', category: 'Cash & Accounting', roles: ['cashier'], description: 'Reclassify how an existing expense was paid, with a required audit reason. Off by default.' },
  { key: 'expense_categories.manage', label: 'Manage expense categories', category: 'Cash & Accounting', roles: ['cashier'], description: 'Create, rename and archive expense categories. Off by default.' },
  { key: 'business_funding.manage', label: 'Manage business funding', category: 'Cash & Accounting', roles: ['cashier'], description: 'Record owner funding and financing activity. Off by default.' },
  { key: 'savings.manage', label: 'Manage savings deposits', category: 'Cash & Accounting', roles: ['cashier'], description: 'View, create and void Savings & Deposits transfers with audit reasons.' },
  { key: 'cash_exchange.manage', label: 'Record cash exchange', category: 'Cash & Accounting', roles: ['cashier'], description: 'View and record note-exchange transactions during an open business day.' },
  { key: 'cash_drawer.manage', label: 'Operate cash drawer', category: 'Cash & Accounting', roles: ['cashier'], description: 'Open and close drawer sessions and record cash-in or cash-out movements.' },
  { key: 'business_days.view', label: 'View opening & closing', category: 'Cash & Accounting', roles: ['cashier'], description: 'View current and historical business-day sessions.' },
  { key: 'business_days.open', label: 'Open business day', category: 'Cash & Accounting', roles: ['cashier'], description: 'Open a new restaurant business day.' },
  { key: 'business_days.close', label: 'Close business day', category: 'Cash & Accounting', roles: ['cashier'], description: 'Close a normal business day after its blockers are resolved. Forced closing remains admin-only.' },
  { key: 'business_days.force_close', label: 'Force-close business day', category: 'Cash & Accounting', roles: ['cashier'], description: 'Close despite unresolved operational blockers. Off for cashiers by default.' },
  { key: 'corrections.manage', label: 'Post accounting corrections', category: 'Cash & Accounting', roles: ['cashier'], description: 'View corrections and post audited journal reversals, bill voids and refunds.' },
  { key: 'general_ledger.view', label: 'View general ledger', category: 'Cash & Accounting', roles: ['cashier'], description: 'View journal entries and account ledgers without changing the chart of accounts.' },
  { key: 'hrm.departments.manage', label: 'Manage departments', category: 'HRM', roles: ['cashier'], description: 'Create, edit and remove departments.' },
  { key: 'hrm.designations.manage', label: 'Manage designations', category: 'HRM', roles: ['cashier'], description: 'Create, edit and remove designations.' },
  { key: 'hrm.attendance.manage', label: 'Mark staff attendance', category: 'HRM', roles: ['cashier'], description: 'View and mark the daily staff attendance register.' },
  { key: 'hrm.holidays.manage', label: 'Manage holidays', category: 'HRM', roles: ['cashier'], description: 'Add and remove entries on the holiday calendar.' },
  { key: 'employees.manage', label: 'Manage staff accounts', category: 'HRM', roles: ['cashier'], description: 'Create and update staff profiles and login access. Off by default.' },
  { key: 'employee_performance.view', label: 'View staff performance', category: 'HRM', roles: ['cashier'], description: 'View staff performance and productivity reports. Off by default.' },
  { key: 'cms.manage', label: 'Manage website content', category: 'Administration', roles: ['cashier'], description: 'Edit public website content and media. Off by default.' },
  { key: 'settings.manage', label: 'Manage restaurant settings', category: 'Administration', roles: ['cashier'], description: 'Change restaurant and printer settings. Off by default.' },
  { key: 'cancellation_verifications.manage', label: 'Verify cancellations', category: 'Administration', description: 'Review and verify cancellation records.' },
  { key: 'inventory.import', label: 'Import inventory', category: 'Inventory Controls', roles: ['cashier'], description: 'Import inventory records in bulk. Off by default.' },
  { key: 'pos.access', label: 'Access POS', category: 'Cashier: Core', roles: ['cashier'], description: 'Open the cashier POS and create or settle orders.' },
  { key: 'order_desk.access', label: 'Access Order Desk', category: 'Cashier: Core', roles: ['cashier'], description: 'View the cashier order desk and current service activity.' },
  { key: 'customers.access', label: 'Access Customers', category: 'Customer Records', description: 'View and manage customer records.' },
  { key: 'customer_ledger.access', label: 'Access Customer Ledger', category: 'Cashier: Core', roles: ['cashier'], description: 'View and maintain customer receivables.' },
  { key: 'supplier_ledger.access', label: 'Access Supplier Ledger', category: 'Cashier: Core', roles: ['cashier'], description: 'View and maintain supplier payables.' },
  { key: 'waiter_calls.access', label: 'Access Waiter Calls', category: 'Operations', description: 'Receive and resolve waiter calls.' },
  { key: 'online_orders.access', label: 'Access Online Orders', category: 'Cashier: Operations', roles: ['cashier'], description: 'View and process online orders.' },
  { key: 'reservations.access', label: 'Access Reservations', category: 'Operations', description: 'View and manage reservations available to the role.' },
  { key: 'reviews.access', label: 'Access Customer Reviews', category: 'Cashier: Operations', roles: ['cashier'], description: 'Open customer review forms and record a customer response.' },
  { key: 'reviews.manage', label: 'Manage Customer Reviews', category: 'Administration', roles: ['cashier'], description: 'Create feedback forms, generate QR codes and moderate responses. Off by default.' },
  { key: 'bills.access', label: 'Access Bills', category: 'Billing', description: 'Open the bill list and bill details available to the role.' },
  { key: 'kot_history.access', label: 'Access KOT History', category: 'Kitchen', description: 'View kitchen order ticket history.' },
  { key: 'payments.access', label: 'Access Payments', category: 'Cashier: Operations', roles: ['cashier'], description: 'View payment history.' },
  { key: 'finance_dashboard.access', label: 'Access Finance Dashboard', category: 'Cashier: Accounting', roles: ['cashier'], description: 'View the finance overview and balances.' },
  { key: 'chart_of_accounts.access', label: 'Access Chart of Accounts', category: 'Cashier: Accounting', roles: ['cashier'], description: 'View and manage the chart of accounts.' },
  { key: 'bank_reconciliation.access', label: 'Access Bank Reconciliation', category: 'Cashier: Accounting', roles: ['cashier'], description: 'Reconcile bank statements and ledger lines.' },
  { key: 'bank.access', label: 'Access Bank', category: 'Cashier: Accounting', roles: ['cashier'], description: 'Manage bank accounts and bank transactions.' },
  { key: 'financial_reports.access', label: 'Access Financial Reports', category: 'Cashier: Accounting', roles: ['cashier'], description: 'View financial statements and accounting reports.' },
];
const CATALOG_KEYS = new Set(PERMISSION_CATALOG.map((p) => p.key));
const CATALOG_BY_KEY = new Map(PERMISSION_CATALOG.map((p) => [p.key, p]));
export const DYNAMIC_PERMISSION_KEYS = CATALOG_KEYS;

// Reproduces the role arrays / in-handler checks these actions were gated by
// before this feature existed. Used to seed new rows and as the fallback
// while the cache is cold.
const DEFAULTS = {
  'report.profitability.view': { waiter: false, cashier: false, kitchen: false },
  'orders.view': { waiter: true, cashier: true, kitchen: true },
  'orders.create': { waiter: true, cashier: true, kitchen: false },
  'orders.update': { waiter: true, cashier: true, kitchen: true },
  'orders.cancel': { waiter: true, cashier: true, kitchen: false },
  'orders.cancel_item': { waiter: true, cashier: true, kitchen: false },
  'menu.view': { waiter: true, cashier: true, kitchen: false },
  'tables.view': { waiter: true, cashier: true, kitchen: false },
  'tables.update': { waiter: true, cashier: true, kitchen: false },
  'kots.view': { waiter: true, cashier: true, kitchen: true },
  'kots.create': { waiter: true, cashier: true, kitchen: false },
  'kots.update': { waiter: true, cashier: true, kitchen: true },
  'kots.reprint': { waiter: true, cashier: true, kitchen: true },
  'kots.cancel': { waiter: true, cashier: true, kitchen: false },
  'bills.view': { waiter: true, cashier: true, kitchen: false },
  'bills.request': { waiter: true, cashier: true, kitchen: false },
  'bills.pay': { waiter: false, cashier: true, kitchen: false },
  'bills.reprint': { waiter: true, cashier: true, kitchen: false },
  'bills.revise_settlement': { waiter: false, cashier: true, kitchen: false },
  'bills.void': { waiter: false, cashier: true, kitchen: false },
  'bills.refund': { waiter: false, cashier: true, kitchen: false },
  'bills.reopen': { waiter: false, cashier: true, kitchen: false },
  'bills.discount': { waiter: true, cashier: true, kitchen: false },
  'credit.writeoff': { waiter: false, cashier: true, kitchen: false },
  'credit.payment_method_correct': { waiter: false, cashier: false, kitchen: false },
  // Customer deletion remains off by default because it is destructive.
  'customers.delete': { waiter: false, cashier: false, kitchen: false },
  'purchases.view': { waiter: false, cashier: true, kitchen: false },
  'purchases.create': { waiter: false, cashier: true, kitchen: false },
  'purchases.import': { waiter: false, cashier: true, kitchen: false },
  'purchases.edit': { waiter: false, cashier: true, kitchen: false },
  'purchases.payment_method_correct': { waiter: false, cashier: false, kitchen: false },
  'purchases.void': { waiter: false, cashier: true, kitchen: false },
  'purchases.void_previous_day': { waiter: false, cashier: false, kitchen: false },
  'suppliers.view': { waiter: false, cashier: true, kitchen: false },
  'suppliers.manage': { waiter: false, cashier: true, kitchen: false },
  'payroll.view': { waiter: false, cashier: true, kitchen: false },
  'payroll.advances.create': { waiter: false, cashier: true, kitchen: false },
  'payroll.payments.create': { waiter: false, cashier: false, kitchen: false },
  'payroll.records.delete': { waiter: false, cashier: false, kitchen: false },
  'reports.view': { waiter: false, cashier: true, kitchen: false },
  'report.sales.view': { waiter: false, cashier: true, kitchen: false },
  'report.finance.view': { waiter: false, cashier: false, kitchen: false },
  'report.expenses.view': { waiter: false, cashier: false, kitchen: false },
  'report.purchases.view': { waiter: false, cashier: false, kitchen: false },
  'report.suppliers.view': { waiter: false, cashier: false, kitchen: false },
  'report.orders.view': { waiter: false, cashier: true, kitchen: false },
  'report.changes.view': { waiter: false, cashier: true, kitchen: false },
  'report.inventory.view': { waiter: false, cashier: true, kitchen: false },
  'report.employees.view': { waiter: false, cashier: false, kitchen: false },
  'report.tables.view': { waiter: false, cashier: true, kitchen: false },
  'report.reservations.view': { waiter: false, cashier: true, kitchen: false },
  'report.menu.view': { waiter: false, cashier: true, kitchen: false },
  'report.categories.view': { waiter: false, cashier: true, kitchen: false },
  'report.customers.view': { waiter: false, cashier: false, kitchen: false },
  'report.previous_day.view': { waiter: false, cashier: true, kitchen: false },
  'dashboard.view': { waiter: false, cashier: true, kitchen: false },
  'analytics.view': { waiter: false, cashier: false, kitchen: false },
  'summary.view': { waiter: false, cashier: false, kitchen: false },
  'menu.manage': { waiter: false, cashier: true, kitchen: false },
  'promotions.manage': { waiter: false, cashier: false, kitchen: false },
  'combos.manage': { waiter: false, cashier: false, kitchen: false },
  'tables.manage': { waiter: false, cashier: false, kitchen: false },
  'host_desk.manage': { waiter: false, cashier: false, kitchen: false },
  'kitchen_analytics.view': { waiter: false, cashier: false, kitchen: true },
  'delivery.manage': { waiter: true, cashier: true, kitchen: false },
  'inventory.dashboard.view': { waiter: false, cashier: true, kitchen: false },
  'inventory.movements.view': { waiter: false, cashier: true, kitchen: false },
  'inventory.view': { waiter: true, cashier: true, kitchen: true },
  'inventory.setup.view': { waiter: false, cashier: true, kitchen: true },
  'recipes.view': { waiter: true, cashier: true, kitchen: true },
  'inventory.manage': { waiter: false, cashier: true, kitchen: false },
  'inventory.setup.manage': { waiter: false, cashier: true, kitchen: false },
  'wastage.manage': { waiter: true, cashier: true, kitchen: true },
  'expenses.manage': { waiter: false, cashier: true, kitchen: false },
  'expenses.payment_method_correct': { waiter: false, cashier: false, kitchen: false },
  'expense_categories.manage': { waiter: false, cashier: false, kitchen: false },
  'business_funding.manage': { waiter: false, cashier: false, kitchen: false },
  'savings.manage': { waiter: false, cashier: true, kitchen: false },
  'cash_exchange.manage': { waiter: false, cashier: true, kitchen: false },
  'cash_drawer.manage': { waiter: false, cashier: true, kitchen: false },
  'business_days.view': { waiter: false, cashier: true, kitchen: false },
  'business_days.open': { waiter: false, cashier: true, kitchen: false },
  'business_days.close': { waiter: false, cashier: true, kitchen: false },
  'business_days.force_close': { waiter: false, cashier: false, kitchen: false },
  'corrections.manage': { waiter: false, cashier: true, kitchen: false },
  'general_ledger.view': { waiter: false, cashier: true, kitchen: false },
  'hrm.departments.manage': { waiter: false, cashier: false, kitchen: false },
  'hrm.designations.manage': { waiter: false, cashier: false, kitchen: false },
  'hrm.attendance.manage': { waiter: false, cashier: false, kitchen: false },
  'hrm.holidays.manage': { waiter: false, cashier: false, kitchen: false },
  'employees.manage': { waiter: false, cashier: false, kitchen: false },
  'employee_performance.view': { waiter: false, cashier: false, kitchen: false },
  'cms.manage': { waiter: false, cashier: false, kitchen: false },
  'settings.manage': { waiter: false, cashier: false, kitchen: false },
  'cancellation_verifications.manage': { waiter: false, cashier: false, kitchen: true },
  'inventory.import': { waiter: false, cashier: false, kitchen: false },
  'pos.access': { waiter: false, cashier: true, kitchen: false },
  'order_desk.access': { waiter: false, cashier: true, kitchen: false },
  'customers.access': { waiter: true, cashier: true, kitchen: false },
  'customer_ledger.access': { waiter: false, cashier: true, kitchen: false },
  'supplier_ledger.access': { waiter: false, cashier: true, kitchen: false },
  'waiter_calls.access': { waiter: true, cashier: true, kitchen: false },
  'online_orders.access': { waiter: false, cashier: true, kitchen: false },
  'reservations.access': { waiter: true, cashier: true, kitchen: false },
  'reviews.access': { waiter: false, cashier: true, kitchen: false },
  'reviews.manage': { waiter: false, cashier: false, kitchen: false },
  'bills.access': { waiter: true, cashier: true, kitchen: false },
  'kot_history.access': { waiter: true, cashier: true, kitchen: true },
  'payments.access': { waiter: false, cashier: true, kitchen: false },
  'finance_dashboard.access': { waiter: false, cashier: true, kitchen: false },
  'chart_of_accounts.access': { waiter: false, cashier: true, kitchen: false },
  'bank_reconciliation.access': { waiter: false, cashier: true, kitchen: false },
  'bank.access': { waiter: false, cashier: true, kitchen: false },
  'financial_reports.access': { waiter: false, cashier: true, kitchen: false },
};

export async function ensurePermissionsSchema(db) {
  if (db.driver === 'postgres') {
    const ready = await db.get(`SELECT to_regclass('public.role_permissions') AS t`);
    if (!ready?.t) throw Object.assign(new Error('Permissions schema is not installed. Run database migration 038 (npm run db:migrate).'), { status: 503, code: 'schema_missing', expose: true });
    return;
  }
  const pk = serialPkSql(db);
  await ensureSqliteTable(db, `CREATE TABLE IF NOT EXISTS role_permissions (
    role TEXT NOT NULL, permission_key TEXT NOT NULL, allowed INTEGER NOT NULL DEFAULT 0,
    updated_by INTEGER, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (role, permission_key))`);
  await ensureSqliteTable(db, `CREATE TABLE IF NOT EXISTS permission_audit (
    ${pk}, role TEXT NOT NULL, permission_key TEXT NOT NULL, previous_value INTEGER,
    new_value INTEGER NOT NULL, actor_id INTEGER, actor_name TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  await ensureColumn(db, 'role_permissions', 'updated_by', 'INTEGER');
}

function defaultFor(key, role) {
  return !!DEFAULTS[key]?.[role];
}

/* --------------------------------------------------------- sync read path */
// hasPermission() in lib/auth/auth.js must stay synchronous (it's called
// without await from a handful of unrelated routes) — so the DB-backed
// matrix is loaded into this module-level cache ahead of time (see
// ensurePermissionCache, awaited once per request in api-guard.js) and
// checked here without touching the database.

let CACHE = null;

export async function ensurePermissionCache(db) {
  // A manager can change roles while another server worker is handling
  // cashier requests. Refresh the small matrix on each guarded request so
  // stale worker memory cannot keep access hidden (or granted) incorrectly.
  await ensurePermissionsSchema(db);
  const rows = await db.all(`SELECT role, permission_key, allowed FROM role_permissions`);
  const cache = {};
  for (const role of MANAGED_ROLES) cache[role] = {};
  for (const row of rows || []) {
    if (!cache[row.role]) cache[row.role] = {};
    cache[row.role][row.permission_key] = !!row.allowed;
  }
  CACHE = cache;
  return CACHE;
}

export function invalidatePermissionCache() {
  CACHE = null;
}

export function isPermissionAllowedSync(role, key) {
  if (role === 'admin') return true;
  const cached = CACHE?.[role]?.[key];
  if (cached != null) return cached;
  return defaultFor(key, role);
}

/* ------------------------------------------------------------- admin CRUD */

export async function listRolePermissions(db) {
  await ensurePermissionsSchema(db);
  const rows = await db.all(`SELECT role, permission_key, allowed FROM role_permissions`);
  const matrix = {};
  for (const role of MANAGED_ROLES) {
    matrix[role] = {};
    for (const { key } of PERMISSION_CATALOG) matrix[role][key] = defaultFor(key, role);
  }
  for (const row of rows || []) {
    if (matrix[row.role]) matrix[row.role][row.permission_key] = !!row.allowed;
  }
  return { catalog: PERMISSION_CATALOG, roles: MANAGED_ROLES, matrix };
}

export async function setRolePermissions(db, updates, actor) {
  await ensurePermissionsSchema(db);
  const clean = (updates || []).filter((u) => {
    if (!MANAGED_ROLES.includes(u?.role) || !CATALOG_KEYS.has(u?.key)) return false;
    const allowedRoles = CATALOG_BY_KEY.get(u.key)?.roles;
    return !allowedRoles || allowedRoles.includes(u.role);
  });
  if (!clean.length) fail('No valid permission changes supplied.');

  await db.transaction(async (tx) => {
    for (const { role, key, allowed } of clean) {
      const prev = await tx.get(`SELECT allowed FROM role_permissions WHERE role=? AND permission_key=?`, [role, key]);
      const nextValue = allowed ? 1 : 0;
      await tx.run(
        `INSERT INTO role_permissions (role, permission_key, allowed, updated_by, updated_at)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT (role, permission_key) DO UPDATE SET allowed = excluded.allowed, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`,
        [role, key, nextValue, actor?.id || null]
      );
      const previousValue = prev ? (prev.allowed ? 1 : 0) : (defaultFor(key, role) ? 1 : 0);
      if (previousValue !== nextValue) {
        await tx.run(
          `INSERT INTO permission_audit (role, permission_key, previous_value, new_value, actor_id, actor_name)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [role, key, previousValue, nextValue, actor?.id || null, actor?.full_name || actor?.username || null]
        );
      }
    }
  });

  invalidatePermissionCache();
  return listRolePermissions(db);
}

export async function permissionAuditHistory(db, { limit = 100 } = {}) {
  await ensurePermissionsSchema(db);
  return db.all(`SELECT * FROM permission_audit ORDER BY created_at DESC, id DESC LIMIT ${Math.min(500, Math.max(1, Number(limit) || 100))}`);
}
