Staff salary and advances
=========================

Set a monthly salary and an optional daily absence deduction on Employee Management. Salary changes start in the selected AD month (this month by default); prior months retain their rates. New tracking for existing staff starts in the month this feature is installed. Historic salary payouts are not treated as staff debt. Outstanding older advances are included.

Salary & Advances shows each staff member's remaining salary. Open Manage to choose a month, view the calculation and all histories, record a salary payment or give an advance. Positive balances carry forward as unpaid salary; negative balances carry forward as deductions. Salary periods use Gregorian (AD) months; payment dates continue to use the application's calendar-aware date fields.

The balance is opening balance + monthly salary - advances given - cash/online salary payments - absence deductions + deductions waived. Advance settlement on a salary payment reduces the outstanding advance account; it is not subtracted from this balance again. Partial payments are supported.

The Salary action in Expenses selects a staff member and records either an advance or a salary payment in the same payroll ledger. It does not create a duplicate manual expense. Find and manage that entry in Salary & Advances. Existing manual salary expenses are left as historical expenses; they cannot be reliably matched to staff automatically.

In Settings / Business, an administrator can enable absence deductions. Enter absent days manually in the staff salary drawer. The saved entry retains its daily rate and calculation, even if the staff rate later changes. Switching the feature off stops new absence deductions; it preserves existing entries.

Administrators may waive all or part of an advance or absence deduction with a reason. Original records remain visible along with the waiver, administrator, and timestamp. Advance waivers are recorded in the current month and require an open business day because they also clear the accounting receivable. Absence waivers apply to the selected month's deductions. Cashiers cannot create these adjustments.

Payroll supports Business Cash, Bank / Online and Business Funding. If Cash or Online cannot cover a payout, the screen asks for approval to cover only the shortfall from Business Funding. Insufficient funding rejects the entire transaction. Summary and Business Funding history read the actual journal split, so funding does not masquerade as a bank payment or a drawer top-up. Deleting an eligible payment returns each portion to its original source.

Payment and advance dates cannot be in the future. Late entries belong to the business day matching their date; records from closed days cannot be deleted from the active day. The selected salary month can differ from the payment date, for example when paying last month's salary today.

The screens attach a unique request key to each submission. Retrying a saved request returns the same record instead of paying twice. Request receipts survive deletion, so an old retry cannot recreate a removed payment. Staff with payroll history must be deactivated instead of deleted.

PostgreSQL deployment requires migrations through 073 (`npm run db:migrate`) before using the new payroll screens. SQLite development databases initialize the new tables automatically. Salary tracking does not reconstruct unrecorded historic salary entitlements or calculate attendance automatically. To end future salary accrual, set the salary to zero from the appropriate month.
