Payroll audit — 2026-10-24
==========================

Fixed
-----

- Payroll treated every non-cash method as Bank. Cash, Online aliases and Business Funding now use explicit validated sources; unsupported methods are rejected.
- Payroll could overdraw Cash or Bank. It now checks available funds and asks before using Business Funding for a shortfall. Insufficient funding rolls back the record and journal together.
- Business Funding history omitted staff payouts. Funded advances and salary payments now appear there, including payouts split between Cash/Online and Funding.
- The salary summary inferred payout sources from the selected method. It now reads actual journal credits, reports funding separately, and explains advance waivers separately from money paid out.
- Duplicate retries could create repeated payouts or deductions. Browser submissions now have persistent request receipts; replay returns the original record, changed payloads are rejected, and old requests cannot recreate deleted entries.
- Backdated payroll was attached to the active business day. It now belongs to its dated day, with invalid and future payment dates rejected. Closed-day deletion remains blocked.
- Salary deletion returned the wrong status for a missing record. It now returns 404; eligible deletions restore the exact cash/bank/funding split.
- Staff deletion could orphan payroll records, especially for staff who received advances without a configured salary. Both employee deletion routes now preserve payroll identities and require deactivation instead.
- Salary actions in the staff/payroll screens did not consistently follow dynamic permissions. Drawer actions now use the actual capabilities.
- Absence entries could be added to future periods or before salary tracking began. Those entries are now rejected; saved daily rates and admin waiver history remain intact.

Verification
------------

All 363 tests in the full Node unit suite passed, covering payroll, funding, business-day reconciliation, expenses, reports and the rest of the application. Lint and the production build also passed. The dedicated payroll funding audit covers direct funding, consent for shortfalls, exact journal splits, insufficient-fund rollback, duplicate retries, deletion refunds, online aliases, backdated records, absence rate snapshots, waiver limits and suggested settlement after an absence waiver. Staff API tests cover both deletion routes.

Isolated desktop and mobile Chrome checks passed for staff payout selection, direct funding from the salary drawer, funding approval from Expenses and Payroll, salary/funding balances, history and horizontal layout. No browser runtime errors occurred. Test databases were separate from restaurant data and were removed after verification.

Operating limits
----------------

- Salary periods currently use Gregorian (AD) months. Payment dates retain the application's AD/BS display setting.
- Existing unrecorded salary entitlements cannot be reconstructed automatically. Existing manual salary expenses are not automatically matched to staff.
- Deactivation preserves history and access status. To stop future salary accrual, set salary to zero from the intended month.
- The automated database tests use SQLite. PostgreSQL migration and concurrency code are included, but require verification against the deployment database when migrations are applied.
- Request receipts protect submissions carrying a request key. Legacy API clients omitting that optional key retain their existing behavior.

Deploy migrations through 073 with `npm run db:migrate` before using the updated payroll screens on PostgreSQL.
